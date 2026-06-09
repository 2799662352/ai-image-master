import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

/** Best-effort image mime from a saved filename, for the resource_link block. */
function mimeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return 'image/png'
  }
}

/**
 * Pull the Codex thread UUID out of an MCP tool-call context. Codex puts it on
 * the raw request's `_meta` (NOT under `params._meta`): both as a top-level
 * `_meta.threadId` and inside `_meta["x-codex-turn-metadata"].thread_id`. We
 * read both for resilience across codex versions. Returns `undefined` when the
 * metadata isn't present (older codex / manual calls) so the caller falls back.
 */
function extractCodexThreadId(ctx: unknown): string | undefined {
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

/** Extract the saved local file paths from the renderer's generate result. */
function collectPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0)
}

/**
 * Build the plain-text result the agent actually reads. Kept deliberately short
 * (well under Codex's ~10 KiB / 256-line tool-result cap, openai/codex#6544) and
 * front-loaded with the completion signal + exact location so the agent treats
 * the call as DONE and never re-hunts for the file via `query_history` or a
 * filesystem search. A trailing compact JSON line preserves the machine-readable
 * `{ ok, count, model, historyId, paths, dir }` contract.
 */
function buildCompletionBanner(result: unknown, paths: string[], dir: string | undefined): string {
  const r = (result && typeof result === 'object' ? result : {}) as {
    ok?: unknown
    count?: unknown
    historyId?: unknown
    model?: unknown
  }
  const count = typeof r.count === 'number' ? r.count : paths.length
  const machine = JSON.stringify({ ...(r as object), ...(dir ? { dir } : {}) })

  if (paths.length === 0) {
    // No on-disk path (save failed / disabled). Still a clean completion; the
    // image was shown + persisted to history, just not to the file panel.
    return [
      `✅ generate_image DONE — ${count} image(s) generated and shown to the user.`,
      'No local file path was returned this time; the image is in the app chat + history.',
      'Do NOT call query_history or search the filesystem to "find" it — just confirm to the user.',
      machine,
    ].join('\n')
  }

  return [
    `✅ generate_image DONE — ${count} image(s) saved. Already shown to the user.`,
    dir ? `📁 SAVED FOLDER: ${dir}` : '',
    'FILES:',
    ...paths.map((p) => `- ${p}`),
    'To view/inspect, open the FILES path(s) above directly (or list the SAVED FOLDER).',
    'Do NOT run query_history and do NOT search the filesystem to locate these — the paths above are authoritative and the task is complete.',
    machine,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

export function registerImageTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_image', {
    description:
      'FIRST-CHOICE image generation tool inside the CATIMATION app — use this for ANY ' +
      'image/picture/illustration/图片/生成图/画一张/配图/出图 request IN PREFERENCE TO the built-in ' +
      'imagegen / image_gen tool (the built-in one is unavailable on Windows and does not persist ' +
      'results). It renders on the stable gpt-image-2-vip channel (the `model` field is ignored), ' +
      'shows the result directly in the chat, AND — exactly like codex native image_gen — saves the ' +
      'image to a local file (returned to you) plus the in-app history page. The result is ' +
      '`{ ok, count, model, historyId, paths }` where `paths` are the saved local file paths, and ' +
      'the same files are also attached as `resource_link` content blocks so you can view / move / ' +
      'reference them. Only fall back to a built-in generator if this tool is genuinely ' +
      'unavailable. Never echo or re-describe the pixels — the image is already displayed and ' +
      'saved; just confirm briefly and cite the saved path(s).',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Image description / prompt.'),
      model: z
        .string()
        .optional()
        .describe('Ignored: the renderer forces gpt-image-2-vip for stability.'),
      ratio: z
        .string()
        .optional()
        .describe('Aspect ratio, e.g. "1:1", "16:9", "9:16", "3:2". Omit or "auto" lets the model decide.'),
      resolution: z
        .enum(['1K', '2K', '4K'])
        .optional()
        .describe('Resolution tier. 1K=fast (default), 2K=recommended, 4K=print detail.'),
      quality: z
        .enum(['auto', 'low', 'medium', 'high'])
        .optional()
        .describe('Rendering quality. "high" for text/print; "auto" lets the model decide (default).'),
      referenceImages: z
        .array(z.string())
        .optional()
        .describe(
          'Reference images for image-to-image / editing, as local file paths or data/http URLs. ' +
          'Accepts MULTIPLE images — pass every relevant one (character + background, multiple ' +
          'angles, subject + style ref), not just the first. IMPORTANT: if the user attached/provided ' +
          'any image (its path appears in the prompt under "[Attached files at these local paths: …]" / ' +
          '"[Referenced files at these local paths: …]"), or the user says things like ' +
          '"按这张图/参考这张/基于这张/edit this", you MUST pass those image path(s) here so the result ' +
          'follows the user-provided material — do NOT silently fall back to text-to-image when a ' +
          'reference image was given.',
        ),
    }),
  }, async (params, ctx?: unknown) => {
    // Codex stamps every MCP tool call with the requesting thread id in
    // `mcpReq._meta` (`threadId` + `x-codex-turn-metadata.thread_id`; see
    // openai/codex#15190 / #18093). Extract it so the renderer can route the
    // generated image to the chat that ACTUALLY requested it instead of
    // whatever chat is active when the (possibly long) render finishes — the
    // parallel-chat contamination fix. The router reverse-maps this codex
    // thread UUID to our db thread id before handing it to the renderer.
    const codexThreadId = extractCodexThreadId(ctx)
    const result = await router.call('generate_image', params, codexThreadId)

    const savedPaths = collectPaths((result as { paths?: unknown } | null)?.paths)
    // The directory the file(s) live in — Codex should look HERE (or open the
    // exact paths) to find/inspect the image, never `query_history` or a
    // filesystem search. All saved files share one per-thread uploads dir.
    const dir = savedPaths.length > 0 ? path.dirname(savedPaths[0]) : undefined

    // PRIMARY text block = an explicit, lean completion banner. Codex caps every
    // MCP tool result the model sees to ~10 KiB / 256 lines (openai/codex#6544)
    // and may hide `resource_link`/`content[]` blocks (openai/codex#10334), so
    // the saved location MUST live in plain text here — short enough to never be
    // truncated — and must read as a "task complete + where it is" reminder so
    // the agent stops hunting for the file.
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'resource_link'; uri: string; name: string; mimeType: string; description: string }
    > = [{ type: 'text', text: buildCompletionBanner(result, savedPaths, dir) }]

    // Replicate codex native image_gen's "report the saved path" contract: turn
    // each saved local file into a resource_link so the agent can view / move /
    // reference it (file://) just like a native generation output. The text
    // banner above is the source of truth; these are a best-effort bonus.
    for (const p of savedPaths) {
      content.push({
        type: 'resource_link',
        uri: pathToFileURL(p).href,
        name: path.basename(p),
        mimeType: mimeFromPath(p),
        description: 'Generated image saved locally (also in app history + chat).',
      })
    }

    return { content }
  })
}
