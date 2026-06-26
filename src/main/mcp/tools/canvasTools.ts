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
  // Tool annotations (readOnlyHint/destructiveHint/idempotentHint/openWorldHint)
  // mirror tldraw mcp-app + sora-canvas-mcp so an MCP host can decide auto-approve
  // vs. confirm. Canvas writes are NOT destructive (they add shapes, never delete
  // user data) but ARE non-idempotent (each call adds another shape).
  const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

  server.registerTool('canvas_open', {
    description:
      'Open the CATIMATION canvas (Agent Workspace → Canvas tab). Call this first before creating holders or inserting images.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    annotations: WRITE,
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
    annotations: WRITE,
  }, async (params, ctx?: unknown) =>
    asResult(await router.call('create_image_holder', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('insert_image_into_holder', {
    description: 'Place a generated image (local file path from generate_image) over a holder as version 1.',
    inputSchema: z.object({
      holderShapeId: z.string().min(1),
      imagePath: z.string().min(1).describe('Local file path returned by generate_image.'),
      title: z.string().optional(),
    }),
    annotations: WRITE,
  }, async (params, ctx?: unknown) =>
    asResult(await router.call('insert_image_into_holder', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('insert_video', {
    description:
      'Place a video file (e.g. a generated Seedance/Sora clip — a local file path) onto the canvas as a real tldraw video shape that plays inline. Use this after generating a video so it lives on the canvas next to its source image. Optional x/y to position it and w/h to size it (omit to use the video\'s intrinsic size, capped to 640px on the longest edge).',
    inputSchema: z.object({
      videoPath: z.string().min(1).describe('Absolute path to the video file on disk (mp4/webm/mov).'),
      title: z.string().optional().describe('Label stored on the shape (alt text).'),
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().optional().describe('Display width in px.'),
      h: z.number().optional().describe('Display height in px.'),
    }),
    annotations: WRITE,
  }, async (params) => asResult(await router.call('insert_video', params as Record<string, unknown>)))

  server.registerTool('canvas_snapshot', {
    description:
      'SEE the current canvas. Returns a structured list of every shape (images, dashed holders, arrows/circles/text annotations with positions/bounds/assetPath/assetId/intrinsic size) PLUS `imagePath` — an on-disk PNG render of the whole canvas you can open and view. Call this whenever the user asks what is on the canvas, or to inspect the layout before editing/inserting.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  }, async () => asResult(await router.call('canvas_snapshot', {})))

  server.registerTool('list_canvas_images', {
    description:
      'List every image shape on the canvas: shapeId, assetId, on-canvas size, role, version, on-disk assetPath, and hasFile. Cheap and read-only — call this FIRST to pick which image to act on (then get_canvas_image / create_image_version with the shapeId).',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, async () => asResult(await router.call('list_canvas_images', {})))

  server.registerTool('get_canvas_image', {
    description:
      'Fetch ONE image on the canvas by shapeId (get it from list_canvas_images). Returns focused metadata (assetId, on-canvas + intrinsic dimensions, src) plus `imagePath` — an on-disk PNG of just that image (annotations excluded) you can open/view or pass to generate_image as a referenceImage. Use this to inspect or to get a clean edit source.',
    inputSchema: z.object({
      shapeId: z.string().min(1).describe('Image shape id from list_canvas_images / canvas_snapshot.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  }, async (params) => asResult(await router.call('get_canvas_image', params as Record<string, unknown>)))

  server.registerTool('get_canvas_video', {
    description:
      "Resolve the VIDEO currently selected on the canvas (or the only video if nothing is selected) to a LOCAL file path you can run ffmpeg on — contact-sheet / probe / trim / transcode. Returns `videoPath`: an absolute on-disk mp4/webm/mov (the clip's recorded path, or a freshly materialized copy if it had none) plus `shapeId`, `assetUrl`, `title`, `materialized`. Call this FIRST whenever you need to ffmpeg or QA a video that lives ON THE CANVAS — never hunt the disk by filename/size. (For semantic '理解/分析' of the clip, use understand_canvas_video instead.)",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  }, async () => asResult(await router.call('get_canvas_video', {})))

  server.registerTool('collect_annotations', {
    description:
      'Read the canvas and return the structured annotation plan (arrows/text/circles) for the target AI image.',
    inputSchema: z.object({ targetShapeId: z.string().optional(), radius: z.number().default(420) }),
    annotations: READ_ONLY,
  }, async (params) => asResult(await router.call('collect_annotations', params as Record<string, unknown>)))

  server.registerTool('prepare_annotation_edit', {
    description: 'Collect annotations and return a ready edit prompt + input image path for the target AI image.',
    inputSchema: z.object({
      targetShapeId: z.string().optional(),
      radius: z.number().default(420),
      userRequest: z.string().optional(),
    }),
    annotations: READ_ONLY,
  }, async (params) => asResult(await router.call('prepare_annotation_edit', params as Record<string, unknown>)))

  server.registerTool('create_image_version', {
    description:
      'Place an edited image (local file path) as a new version to the RIGHT of the source image, keeping the old one.',
    inputSchema: z.object({
      sourceShapeId: z.string().min(1),
      imagePath: z.string().min(1),
      title: z.string().optional(),
    }),
    annotations: WRITE,
  }, async (params, ctx?: unknown) =>
    asResult(await router.call('create_image_version', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('save_snapshot', {
    description:
      'Persist the current canvas and export it to disk. Returns `imagePath` — an on-disk PNG of the whole canvas (a saved "address" you can open/share), like an uploaded attachment.',
    inputSchema: z.object({}),
    // Writes a fresh PNG file each call → not idempotent; not destructive (adds a file).
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async () => asResult(await router.call('save_snapshot', {})))

  server.registerTool('save_checkpoint', {
    description:
      'Save a RESTORABLE checkpoint of the whole canvas to disk (tldraw getSnapshot JSON). Returns `checkpointId` + `path`. Use as a "fork"/branch point before risky edits, or to keep named versions of the whole canvas. Restore later with `load_checkpoint`. (Unlike `save_snapshot`, which only exports a flat PNG, this captures the full editable state.)',
    inputSchema: z.object({
      name: z.string().optional().describe('Optional human label for this checkpoint (e.g. "before night edit").'),
    }),
    // Writes a new checkpoint file each call → not idempotent; not destructive (adds a file).
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (params) => asResult(await router.call('save_checkpoint', params as Record<string, unknown>)))

  server.registerTool('load_checkpoint', {
    description:
      'Restore the canvas to a previously saved checkpoint (by `checkpointId` from `list_checkpoints`). This REPLACES the current canvas content with the checkpoint — effectively switching to that fork/branch. Save the current state with `save_checkpoint` first if you might want to come back.',
    inputSchema: z.object({
      checkpointId: z.string().min(1).describe('The checkpointId returned by save_checkpoint / list_checkpoints.'),
    }),
    // Replaces the whole canvas → destructive (current unsaved content is overwritten).
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (params) => asResult(await router.call('load_checkpoint', params as Record<string, unknown>)))

  server.registerTool('list_checkpoints', {
    description:
      'List saved canvas checkpoints (newest first): `checkpointId`, `name`, `createdAt`, `shapeCount`, on-disk `path`. Pick a `checkpointId` to pass to `load_checkpoint`.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, async () => asResult(await router.call('list_checkpoints', {})))

  server.registerTool('canvas_exec', {
    description: `Escape hatch: execute JavaScript directly on the live tldraw \`editor\` to do layout/edits the fixed tools can't (move, align, distribute, group, delete, resize, reorder, custom shapes). The code has \`editor\` (real tldraw Editor API) plus helpers: createShapeId, createBindingId, createArrowBetweenShapes(fromId,toId,opts), boxShapes(ids,opts), zoomToFit(ids), Box, Vec, Mat, clamp, getArrowBindings, toRichText. Use \`return\` to read data back. Call \`canvas_search\` first to discover available methods/shape props.

Examples:
- return editor.getCurrentPageShapes().map(s => ({ id: s.id, type: s.type }))
- editor.createShape({ type: 'geo', x: 200, y: 120, props: { geo: 'rectangle', w: 320, h: 180 } })
- createArrowBetweenShapes('shape:a', 'shape:b', { text: 'next' })
- editor.distributeShapes(editor.getSelectedShapeIds(), 'horizontal')`,
    inputSchema: z.object({
      code: z.string().min(1).describe('JavaScript to run. Has `editor` + helpers in scope; use `return` to produce output.'),
    }),
    // Arbitrary code CAN delete shapes → mark destructive so a host can confirm.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (params) => asResult(await router.call('canvas_exec', params as Record<string, unknown>)))

  server.registerTool('canvas_search', {
    description: `Search the tldraw Editor API surface to learn what \`canvas_exec\` can call. Write JS that receives \`spec\` and returns a result. spec.members (Editor methods: name/kind/signature/description/category), spec.categories, spec.types.shapeTypes, spec.types.shapes (per-type prop names), spec.helpers (exec helper functions).

Examples:
- return spec.members.filter(m => m.category === 'layout').map(m => m.signature)
- return spec.types.shapes.find(s => s.shapeType === 'arrow')
- return spec.helpers`,
    inputSchema: z.object({
      code: z.string().min(1).describe('JavaScript that receives `spec` and uses `return` to produce output.'),
    }),
    annotations: READ_ONLY,
  }, async (params) => asResult(await router.call('canvas_search', params as Record<string, unknown>)))

  // ---- Queue tools (main process; read/write the edit-request registry directly) ----
  server.registerTool('watch_edit_requests', {
    description:
      'Auto-edit watch loop. The canvas auto-submits an edit request when the user finishes annotating (no button needed). Long-polls ~25s; keep calling in a loop until a request arrives. When one arrives, call generate_image with its editPrompt + targetImagePath as referenceImages, then create_image_version (places the new version to the right of the original), then update_edit_request(completed).',
    inputSchema: z.object({
      waitMs: z.number().int().min(0).max(WATCH_LONG_POLL_MS).optional(),
      claim: z.boolean().default(true),
    }),
    // Long-poll that (by default) CLAIMS the next request — a registry mutation,
    // so not read-only and not idempotent.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (params) => asResult(editRequestRegistry.get((params as { requestId: string }).requestId) ?? { error: 'not found' }))

  server.registerTool('update_edit_request', {
    description: 'Mark an edit request completed / failed / processing / needs_clarification.',
    inputSchema: z.object({
      requestId: z.string().min(1),
      status: z.enum(['queued', 'processing', 'completed', 'failed', 'needs_clarification']),
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
