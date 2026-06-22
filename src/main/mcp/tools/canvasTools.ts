import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import { editRequestRegistry } from '../canvas/EditRequestRegistry'

function asResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  }
}

/** check_image_task-style long-poll window for the canvas edit-request queue. */
const WATCH_LONG_POLL_MS = 25_000

export function registerCanvasTools(server: McpServer, router: ToolRouter): void {
  // ---- Renderer-routed tools ----
  server.registerTool('canvas_open', {
    description:
      'Open the CATIMATION canvas (Agent Workspace → Canvas tab). Call this first before creating holders or inserting images.',
    inputSchema: z.object({}),
  }, async () => asResult(await router.call('canvas_open', {})))

  server.registerTool('prepare_image_generation', {
    description:
      'Open the canvas, ensure an image holder exists, and return the holder id + a suggested generation prompt. Then call generate_image, then insert_image_into_holder.',
    inputSchema: z.object({
      request: z.string().min(1).describe('What the user wants the image to be.'),
      aspectRatio: z.string().default('5:7').describe('Aspect ratio like 1:1, 16:9, 5:7.'),
      intendedUse: z.string().optional(),
      label: z.string().optional(),
    }),
  }, async (params) => asResult(await router.call('prepare_image_generation', params as Record<string, unknown>)))

  server.registerTool('create_image_holder', {
    description: 'Create a dashed image-holder rectangle on the canvas to receive a generated image.',
    inputSchema: z.object({
      label: z.string().optional(),
      aspectRatio: z.string().default('5:7'),
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().optional(),
      h: z.number().optional(),
    }),
  }, async (params, ctx?: unknown) =>
    asResult(await router.call('create_image_holder', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('insert_image_into_holder', {
    description: 'Place a generated image (local file path from generate_image) over a holder as version 1.',
    inputSchema: z.object({
      holderShapeId: z.string().min(1),
      imagePath: z.string().min(1).describe('Local file path returned by generate_image.'),
      title: z.string().optional(),
    }),
  }, async (params, ctx?: unknown) =>
    asResult(await router.call('insert_image_into_holder', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('collect_annotations', {
    description:
      'Read the canvas and return the structured annotation plan (arrows/text/circles) for the target AI image.',
    inputSchema: z.object({ targetShapeId: z.string().optional(), radius: z.number().default(420) }),
  }, async (params) => asResult(await router.call('collect_annotations', params as Record<string, unknown>)))

  server.registerTool('prepare_annotation_edit', {
    description: 'Collect annotations and return a ready edit prompt + input image path for the target AI image.',
    inputSchema: z.object({
      targetShapeId: z.string().optional(),
      radius: z.number().default(420),
      userRequest: z.string().optional(),
    }),
  }, async (params) => asResult(await router.call('prepare_annotation_edit', params as Record<string, unknown>)))

  server.registerTool('create_image_version', {
    description:
      'Place an edited image (local file path) as a new version to the RIGHT of the source image, keeping the old one.',
    inputSchema: z.object({
      sourceShapeId: z.string().min(1),
      imagePath: z.string().min(1),
      title: z.string().optional(),
    }),
  }, async (params, ctx?: unknown) =>
    asResult(await router.call('create_image_version', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('save_snapshot', {
    description: 'Force-persist the current canvas snapshot.',
    inputSchema: z.object({}),
  }, async () => asResult(await router.call('save_snapshot', {})))

  // ---- Queue tools (main process; read/write the edit-request registry directly) ----
  server.registerTool('watch_edit_requests', {
    description:
      'Wait for an edit request submitted from the canvas 按标注修图 button (auto-edit mode). Long-polls ~25s; keep calling until a request arrives. When one arrives, call generate_image with its editPrompt + targetImagePath as referenceImages, then create_image_version, then update_edit_request(completed).',
    inputSchema: z.object({
      waitMs: z.number().int().min(0).max(WATCH_LONG_POLL_MS).optional(),
      claim: z.boolean().default(true),
    }),
  }, async (params) => {
    const p = params as { waitMs?: number; claim?: boolean }
    const result = await editRequestRegistry.waitForNext(Math.min(p.waitMs ?? WATCH_LONG_POLL_MS, WATCH_LONG_POLL_MS), {
      claim: p.claim !== false,
    })
    return asResult(result)
  })

  server.registerTool('get_edit_request', {
    description: 'Read one edit request by id.',
    inputSchema: z.object({ requestId: z.string().min(1) }),
  }, async (params) => asResult(editRequestRegistry.get((params as { requestId: string }).requestId) ?? { error: 'not found' }))

  server.registerTool('update_edit_request', {
    description: 'Mark an edit request completed / failed / processing / needs_clarification.',
    inputSchema: z.object({
      requestId: z.string().min(1),
      status: z.enum(['queued', 'processing', 'completed', 'failed', 'needs_clarification']),
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.string().optional(),
    }),
  }, async (params) => {
    const p = params as {
      requestId: string
      status: 'queued' | 'processing' | 'completed' | 'failed' | 'needs_clarification'
      result?: Record<string, unknown>
      error?: string
    }
    return asResult(editRequestRegistry.update(p.requestId, p.status, p.result, p.error) ?? { error: 'not found' })
  })
}

/**
 * Pull the Codex thread UUID out of an MCP tool-call context. Mirrors
 * imageTools' `extractCodexThreadId`: Codex puts the id on the raw request's
 * `_meta` (NOT under `params._meta`), both as a top-level `_meta.threadId` and
 * inside `_meta["x-codex-turn-metadata"].thread_id`. Returns `undefined` when
 * absent so renderer tools fall back to active-thread capture.
 */
function extractThreadId(ctx: unknown): string | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: unknown } } | undefined)?.mcpReq?._meta as
    | { threadId?: unknown; ['x-codex-turn-metadata']?: { thread_id?: unknown; session_id?: unknown } }
    | undefined
  if (!meta) return undefined
  const direct = typeof meta.threadId === 'string' && meta.threadId.length > 0 ? meta.threadId : undefined
  const turn = meta['x-codex-turn-metadata']
  const fromTurn =
    typeof turn?.thread_id === 'string' && turn.thread_id.length > 0
      ? turn.thread_id
      : typeof turn?.session_id === 'string' && turn.session_id.length > 0
        ? turn.session_id
        : undefined
  return direct ?? fromTurn
}
