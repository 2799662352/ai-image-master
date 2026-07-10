import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import { imageTaskManager, type ImageTaskManager, type ImageTaskState } from './imageTaskRegistry'

/** generate_images 批量任务的结果形状(存进 registry,check_image_task 据此重建 banner)。 */
interface BatchTaskResult {
  successes: unknown[]
  failures: Array<{ index: number; error: string }>
  savedPaths: string[]
}

/**
 * generate_image 阻塞预算 —— 「短阻塞 + handoff 轮询」混合模型。
 *
 * 背景:裸阻塞到终态(实测一张图 ~6 分钟)会让 agent 整段静默,体验差;而早期 45s 又偏
 * 短、且会暴露「codex 拿到 STILL RUNNING 就结束 turn / 自判已提交而不轮询」的弃坑风险。
 * 折中:阻塞 1 分钟 —— 足够接住快渲染直接返回 ✅ DONE,又不会把 agent 闷死太久。超过 1
 * 分钟仍在渲染就把 taskId 交还(⏳ STILL RUNNING),agent 立刻回话(「已提交,正在生成」)
 * 并由 check_image_task 兜底长轮询到完成。
 *
 * 兜底能真正触发的两个保证:① firstPartySkills 明确要求收到 STILL RUNNING 后用
 * check_image_task 轮询到 DONE/FAILED;② check_image_task 服务端长轮询(见下),状态一变
 * 立即返回,使「再调一次」即可拿到结果,降低弃坑概率。期间用户在 app 聊天里始终看到
 * 「生成中」气泡(渲染层独立链路),图最终一定会出现,与 agent 是否轮询无关。
 */
export const GENERATE_IMAGE_BLOCKING_BUDGET_MS = 60_000
/** check_image_task 服务端长轮询窗口(须 < codex 工具超时,留足余量)。 */
export const CHECK_IMAGE_LONG_POLL_MS = 25_000
/** One MCP batch may contain up to 20 prompts; renderer executes them through a bounded worker pool. */
export const GENERATE_IMAGES_MAX_PROMPTS = 20

export interface ImageToolsOptions {
  /** 注入图片任务管理器(测试用);默认进程级单例。 */
  manager?: ImageTaskManager
  /** 注入阻塞预算(测试用)。 */
  blockingBudgetMs?: number
  /** 注入长轮询窗口(测试用)。 */
  checkLongPollMs?: number
}

type ImageToolContent = Array<
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string; description: string }
>

function elapsedSeconds(task: ImageTaskState): number {
  return Math.max(0, Math.round((Date.now() - task.createdAt) / 1000))
}

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
    persistencePending?: unknown
  }
  const count = typeof r.count === 'number' ? r.count : paths.length
  const machine = JSON.stringify({ ...(r as object), ...(dir ? { dir } : {}) })

  if (r.persistencePending === true) {
    // Render succeeded but local bookkeeping (history/file save) exceeded its
    // time budget and is still settling in the background. Success is decided
    // by the render — never make the agent wait on (or retry over) bookkeeping.
    return [
      `✅ generate_image DONE — ${count} image(s) generated and shown to the user.`,
      'Local file save is still finishing in the background, so no path is available yet.',
      'Treat this generation as COMPLETE — do NOT retry or re-generate.',
      'If you genuinely need the file path later, call query_history then; otherwise just confirm to the user.',
      machine,
    ].join('\n')
  }

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
    // The "do not self-inspect" line is load-bearing: a batch of view_image
    // calls on these full-res files injects N × multi-MB base64 into the next
    // model request, which exceeds relay gateways' request-size cap and wedges
    // the thread (observed live 2026-06-11: 5 images → 5 view_image → hang).
    'Do NOT open these files with view_image to "double-check" — the user is already looking at the image(s) in chat. Viewing them injects multi-MB base64 into context and can kill the thread (request_too_large). Only view if the user explicitly asks, and then at most ONE image.',
    'Do NOT run query_history and do NOT search the filesystem to locate these — the paths above are authoritative and the task is complete.',
    machine,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

function buildBatchCompletionBanner(results: unknown[], paths: string[]): string {
  const dirs = [...new Set(paths.map((p) => path.dirname(p)))]
  const pendingCount = results.filter(
    (r) => (r as { persistencePending?: unknown } | null)?.persistencePending === true,
  ).length
  const machine = JSON.stringify({
    ok: true,
    count: results.length,
    paths,
    dirs,
    results,
  })

  return [
    `✅ generate_images DONE — ${results.length}/${results.length} image(s) generated. Already shown to the user.`,
    dirs.length === 1 ? `📁 SAVED FOLDER: ${dirs[0]}` : '',
    paths.length > 0 ? 'FILES:' : '',
    ...paths.map((p) => `- ${p}`),
    pendingCount > 0
      ? `${pendingCount} file save(s) are still finishing in the background — their paths are not listed yet. The generation itself is COMPLETE; do NOT retry. Use query_history later only if a missing path is genuinely needed.`
      : '',
    'Do NOT open these files with view_image to "double-check" — the user is already looking at the image(s) in chat. Viewing them injects multi-MB base64 into context and can kill the thread (request_too_large). Only view if the user explicitly asks, and then at most ONE image.',
    pendingCount === 0
      ? 'Do NOT run query_history and do NOT search the filesystem to locate these — the paths above are authoritative and the batch task is complete.'
      : '',
    machine,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

function buildBatchFailureBanner(successes: unknown[], failures: Array<{ index: number; error: string }>, paths: string[]): string {
  const machine = JSON.stringify({ ok: false, successCount: successes.length, failureCount: failures.length, paths, failures })
  return [
    `❌ generate_images PARTIAL/FAILED — ${successes.length} succeeded, ${failures.length} failed.`,
    paths.length > 0 ? 'SAVED FILES:' : '',
    ...paths.map((p) => `- ${p}`),
    'FAILURES:',
    ...failures.map((f) => `- #${f.index}: ${f.error}`),
    'The chat UI already shows any successful image(s). Do not inspect generated images unless the user explicitly asks.',
    machine,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/** 成功任务的统一回包:DONE banner(纯文本权威) + 每个本地文件一个 resource_link。 */
function buildImageDoneContent(result: unknown): ImageToolContent {
  const savedPaths = collectPaths((result as { paths?: unknown } | null)?.paths)
  const dir = savedPaths.length > 0 ? path.dirname(savedPaths[0]) : undefined
  const content: ImageToolContent = [{ type: 'text', text: buildCompletionBanner(result, savedPaths, dir) }]
  for (const p of savedPaths) {
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(p).href,
      name: path.basename(p),
      mimeType: mimeFromPath(p),
      description: 'Generated image saved locally (also in app history + chat).',
    })
  }
  return content
}

/** 短预算烧完仍在渲染:把 taskId 交还 agent,它可继续回话,由 check_image_task 兜底。 */
export function buildImageRunningHandoffBanner(task: ImageTaskState): string {
  return [
    `⏳ generate_image STILL RUNNING after ${elapsedSeconds(task)}s — taskId: ${task.taskId}.`,
    'The render is taking longer than usual but the task is alive, and the user ALREADY sees a live "generating" bubble in the chat — the finished image will appear there automatically whether or not you poll.',
    'You can keep talking to the user now (e.g. say the image is generating). When you want to confirm completion and get the saved file path, call check_image_task with this taskId (it long-polls ~25s server-side); keep calling until DONE or FAILED.',
    'Do NOT resubmit generate_image for the same request — that would render a duplicate.',
    JSON.stringify({ taskId: task.taskId, status: 'running', elapsedSeconds: elapsedSeconds(task) }),
  ].join('\n')
}

/** check_image_task 仍在渲染时的回包。 */
export function buildImageCheckRunningBanner(task: ImageTaskState): string {
  return [
    `⏳ check_image_task — still rendering. Elapsed: ${elapsedSeconds(task)}s.`,
    'Call check_image_task again with the same taskId (it long-polls ~25s server-side, so just call it immediately). Do NOT resubmit generate_image — the task is alive and the user sees its progress bubble.',
    JSON.stringify({ taskId: task.taskId, status: 'running', elapsedSeconds: elapsedSeconds(task) }),
  ].join('\n')
}

export function buildUnknownImageTaskBanner(taskId: string): string {
  return [
    `❌ check_image_task — unknown taskId: ${taskId}.`,
    'Image tasks live in memory and are dropped after app restart or ~30 minutes past completion.',
    'If the image never appeared in the chat, submit a NEW generate_image call; do not keep checking this id.',
    JSON.stringify({ taskId, status: 'unknown' }),
  ].join('\n')
}

export function buildImageFailureBanner(task: ImageTaskState): string {
  return [
    `❌ generate_image FAILED — ${task.error ?? 'image generation failed'}.`,
    'The user sees the failure in the chat. You may retry ONCE with an adjusted prompt if the error suggests a content/parameter problem; otherwise report the error to the user.',
    JSON.stringify({ ok: false, taskId: task.taskId, error: task.error ?? 'image generation failed' }),
  ].join('\n')
}

/** 批量任务完成回包:组合 banner(全成功/部分失败) + 每个本地文件 resource_link。 */
function buildBatchContent(data: BatchTaskResult): ImageToolContent {
  const { successes, failures, savedPaths } = data
  const content: ImageToolContent = [
    {
      type: 'text',
      text:
        failures.length === 0
          ? buildBatchCompletionBanner(successes, savedPaths)
          : buildBatchFailureBanner(successes, failures, savedPaths),
    },
  ]
  for (const p of savedPaths) {
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(p).href,
      name: path.basename(p),
      mimeType: mimeFromPath(p),
      description: 'Generated image saved locally (also in app history + chat).',
    })
  }
  return content
}

/** generate_images 烧满预算仍在渲染:把批量 taskId 交还,走 check_image_task 兜底。 */
export function buildBatchRunningHandoffBanner(task: ImageTaskState): string {
  return [
    `⏳ generate_images STILL RUNNING after ${elapsedSeconds(task)}s — taskId: ${task.taskId}.`,
    'The batch is taking longer than usual but is alive; the user ALREADY sees live "generating" bubbles in the chat — every finished image appears there automatically whether or not you poll.',
    'You can keep talking to the user now. To confirm completion and get the saved paths, call check_image_task with this taskId (it long-polls ~25s server-side); keep calling until DONE or FAILED.',
    'Do NOT resubmit generate_images for the same request — that would render duplicates.',
    JSON.stringify({ taskId: task.taskId, status: 'running', elapsedSeconds: elapsedSeconds(task) }),
  ].join('\n')
}

export function registerImageTools(server: McpServer, router: ToolRouter, options: ImageToolsOptions = {}): void {
  const manager = options.manager ?? imageTaskManager
  const blockingBudgetMs = options.blockingBudgetMs ?? GENERATE_IMAGE_BLOCKING_BUDGET_MS
  const checkLongPollMs = options.checkLongPollMs ?? CHECK_IMAGE_LONG_POLL_MS
  const ratioSchema = z
    .enum(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:4', '4:5'])
    .optional()
    .describe(
      'Aspect ratio. Supported values match the UI dropdown exactly: ' +
      'auto, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9, 5:4, 4:5.',
    )

  // Optional channel OVERRIDE. Default = the channel the user picked in the chat
  // composer (VIP / Image2 官方 / 腾讯 / Nano2 / 万相 2.7 pro). Omit to honor the
  // user's pick; set it only when you have a concrete reason to override (e.g. 万相
  // for a 组图 series, or the user asked for a specific channel this turn).
  const modelSchema = z
    .enum(['custom-imagemodel-gt', 'gpt-image-2-vip', 'gpt-image-2', 'wan2.7-image-pro', 'gemini-3.1-flash-image'])
    .optional()
    .describe(
      'Rendering channel OVERRIDE (optional). By default the render channel follows the user\'s ' +
      'composer picker (VIP / Image2 官方 / 腾讯 / Nano2 / 万相 2.7 pro; default VIP) — OMIT this to ' +
      "honor the user's pick. Set it ONLY when you have a concrete reason to override: pass " +
      '"wan2.7-image-pro" for a CONSISTENT 组图 series (count>1), or the specific channel the user ' +
      'explicitly asked for this turn (gpt-image-2-vip = OpenAI 官逆/vip, gpt-image-2 = API易 ' +
      'OpenAI 官方旗舰/Image2 官方 — slower per-token billing, highest quality ceiling, ' +
      'custom-imagemodel-gt = 腾讯, gemini-3.1-flash-image = Nano Banana 2). The result reports ' +
      'the actual channel used in its `model` field.',
    )

  server.registerTool('generate_image', {
    description:
      'FIRST-CHOICE image generation tool inside the CATIMATION app — use this for ANY ' +
      'image/picture/illustration/图片/生成图/画一张/配图/出图 request IN PREFERENCE TO the built-in ' +
      'imagegen / image_gen tool (the built-in one is unavailable on Windows and does not persist ' +
      'results). By default it renders on the channel the USER picked in the chat composer (default ' +
      'VIP); you may override per-call via `model` when you have a reason (see below). It ' +
      'shows the result directly in the chat, AND — exactly like codex native image_gen — saves the ' +
      'image to a local file (returned to you) plus the in-app history page. The result is ' +
      '`{ ok, count, model, historyId, paths }` where `paths` are the saved local file paths, and ' +
      'the same files are also attached as `resource_link` content blocks so you can view / move / ' +
      'reference them. Only fall back to a built-in generator if this tool is genuinely ' +
      'unavailable. Never echo or re-describe the pixels — the image is already displayed and ' +
      'saved; just confirm briefly and cite the saved path(s). The render channel defaults to the ' +
      "user's composer channel picker (default VIP); pass `model` to override when needed (the " +
      'returned `model` field reports what was actually used). For a CONSISTENT multi-image 组图 ' +
      'series from one prompt, set model="wan2.7-image-pro" with `count`>1 (1–12) — `count` only ' +
      'takes effect on the 万相 2.7 pro channel; for unrelated images use generate_images instead. ' +
      'TIMING: a single render typically takes several minutes. This call blocks up to ~1 minute and ' +
      'returns ✅ DONE if the image finishes that fast; otherwise it returns ⏳ STILL RUNNING with a ' +
      '`taskId` (this is the COMMON case for normal renders). When you get STILL RUNNING the image ' +
      'will STILL appear in the user\'s chat automatically — tell the user it is generating and then ' +
      'call check_image_task with that taskId, repeatedly, until it reports DONE or FAILED. Before ' +
      'calling this tool, briefly tell the user you are submitting the render.',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Image description / prompt.'),
      model: modelSchema,
      ratio: ratioSchema,
      resolution: z
        .enum(['1K', '2K', '4K'])
        .optional()
        .describe('Resolution tier. 2K is the default/recommended choice. Use 1K only when the user asks for fast/cheap/draft. Use 4K only for explicit print/ultra-detail requests.'),
      quality: z
        .enum(['auto', 'low', 'medium', 'high'])
        .optional()
        .describe('Rendering quality. "high" for text/print; "auto" lets the model decide (default).'),
      count: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe(
          'Number of images from THIS single prompt (default 1). ONLY meaningful for ' +
          'model="wan2.7-image-pro": count>1 turns on 万相 组图 / enable_sequential, returning a ' +
          'front-to-back CONSISTENT series (e.g. 同一只猫的四季, same character across shots) — up to 12. ' +
          'Other channels ignore it and always return 1. For several UNRELATED images (distinct ' +
          'subjects/variations), use generate_images with one prompt each instead of count.',
        ),
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

    // Truly-async model (mirrors generate_video). Register the task FIRST, then
    // "kick" the renderer with the taskId: the renderer acks IMMEDIATELY (no
    // long-held IPC) and renders in the background, broadcasting one terminal
    // `image:task-update` when done → main's ImageTaskManager.applyUpdate writes
    // it back. We only block up to a SHORT budget waiting for that terminal
    // state. Within budget → ✅ DONE (text banner is source of truth +
    // resource_links). Over budget → ⏳ STILL RUNNING + taskId so the agent
    // regains control and polls via check_image_task. The renderer's own
    // "generating" bubble shows the image to the user regardless of polling.
    const taskId = manager.create(typeof params.prompt === 'string' ? params.prompt : '', 'single')
    void router.call('generate_image', { ...params, __taskId: taskId }, codexThreadId).catch((error) => {
      // The renderer never even acked (it's gone / threw before starting) →
      // settle failed so the budget wait returns immediately instead of stalling.
      manager.fail(taskId, error instanceof Error ? error.message : String(error))
    })

    const snapshot = await manager.waitForTerminal(taskId, blockingBudgetMs)
    if (!snapshot) {
      // Should never happen (we just created it), but fail safe with a handoff.
      return { content: [{ type: 'text', text: buildUnknownImageTaskBanner(taskId) }] }
    }
    if (snapshot.status === 'failed') {
      // Preserve "the tool errored" semantics so Codex marks the call failed.
      throw new Error(snapshot.error ?? 'Image generation failed')
    }
    if (snapshot.status === 'running') {
      // Budget exhausted, render still in flight → hand the taskId back.
      return { content: [{ type: 'text', text: buildImageRunningHandoffBanner(snapshot) }] }
    }

    // PRIMARY text block = an explicit, lean completion banner. Codex caps every
    // MCP tool result the model sees to ~10 KiB / 256 lines (openai/codex#6544)
    // and may hide `resource_link`/`content[]` blocks (openai/codex#10334), so
    // the saved location MUST live in plain text here — short enough to never be
    // truncated — and must read as a "task complete + where it is" reminder so
    // the agent stops hunting for the file. resource_links replicate codex
    // native image_gen's "report the saved path" contract (best-effort bonus).
    return { content: buildImageDoneContent(snapshot.result) }
  })

  server.registerTool('check_image_task', {
    description:
      'Poller for a generate_image / generate_images task. Use it whenever those tools returned a ' +
      '⏳ STILL RUNNING handoff (with a taskId) — which is COMMON since a normal render takes several ' +
      'minutes and the tools only block ~1 minute — to confirm completion and get the saved file ' +
      'path(s). Long-polls server-side for up to ~25s and returns AS SOON AS the status changes; keep ' +
      'calling with the same taskId until DONE or FAILED. The image(s) already appear in the user\'s ' +
      'chat automatically, so this is only about getting the saved path / final status — never ' +
      'resubmit generate_image.',
    inputSchema: z.object({
      taskId: z.string().min(1).describe('Task id returned by a generate_image STILL RUNNING handoff.'),
    }),
  }, async (params) => {
    const taskId = typeof (params as { taskId?: unknown }).taskId === 'string' ? (params as { taskId: string }).taskId : ''
    const snapshot = await manager.waitForTerminal(taskId, checkLongPollMs)
    if (!snapshot) {
      return { content: [{ type: 'text', text: buildUnknownImageTaskBanner(taskId) }] }
    }
    if (snapshot.status === 'failed') {
      return { content: [{ type: 'text', text: buildImageFailureBanner(snapshot) }] }
    }
    if (snapshot.status === 'succeeded') {
      return snapshot.kind === 'batch'
        ? { content: buildBatchContent(snapshot.result as BatchTaskResult) }
        : { content: buildImageDoneContent(snapshot.result) }
    }
    return { content: [{ type: 'text', text: buildImageCheckRunningBanner(snapshot) }] }
  })

  server.registerTool('generate_images', {
    description:
      'Batch image generation tool for when the user asks for MULTIPLE images (e.g. "生成 3 张", ' +
      '"make 5 variations", "几张图", "批量生成"). Prefer this over calling generate_image repeatedly: ' +
      'it runs 2–20 prompts through a bounded concurrent worker pool inside CATIMATION, so the images ' +
      'render in chat in parallel and the model receives one concise combined DONE/FAILED result. ' +
      'Use one prompt per desired image; for variations, write distinct but related prompts. Do not ' +
      'use subagents for image fan-out. ' +
      'TIMING: like generate_image this blocks up to ~1 minute and returns ✅ DONE if the whole batch ' +
      'finishes that fast; otherwise (the COMMON case, since renders take several minutes) it returns ' +
      '⏳ STILL RUNNING with a `taskId`. The images still appear in the user\'s chat automatically; ' +
      'tell the user they are generating and call check_image_task with that taskId, repeatedly, until ' +
      'DONE or FAILED. Before calling, briefly tell the user you are submitting the batch.',
    inputSchema: z.object({
      prompts: z.array(z.string().min(1)).min(2).max(GENERATE_IMAGES_MAX_PROMPTS).describe(
        'One prompt per image (2–20). If the user asks for N images, provide N prompts here.',
      ),
      model: modelSchema,
      ratio: ratioSchema,
      resolution: z
        .enum(['1K', '2K', '4K'])
        .optional()
        .describe('Resolution tier shared by all images. Prefer 2K by default. Use 1K only for fast/cheap/draft, and 4K only for explicit print/ultra-detail requests.'),
      quality: z
        .enum(['auto', 'low', 'medium', 'high'])
        .optional()
        .describe('Rendering quality shared by all images.'),
      referenceImages: z
        .array(z.string())
        .optional()
        .describe('Reference images shared by all prompts, as local file paths or data/http URLs.'),
    }),
  }, async (params, ctx?: unknown) => {
    const parsed = params as {
      prompts?: unknown
      model?: 'gpt-image-2-vip' | 'gpt-image-2' | 'custom-imagemodel-gt' | 'wan2.7-image-pro' | 'gemini-3.1-flash-image'
      ratio?: string
      resolution?: '1K' | '2K' | '4K'
      quality?: 'auto' | 'low' | 'medium' | 'high'
      referenceImages?: string[]
    }
    const prompts = Array.isArray(parsed.prompts) ? parsed.prompts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0) : []
    const codexThreadId = extractCodexThreadId(ctx)

    // Truly-async batch (mirrors generate_image). Register ONE batch task, then
    // kick the renderer with the taskId — it acks immediately, fans out the N
    // renders concurrently in the background (each with its own "generating"
    // bubble), and broadcasts ONE terminal `image:task-update` carrying the
    // combined { successes, failures, savedPaths }. We only block up to the
    // budget; over budget → hand the taskId back for check_image_task.
    const taskId = manager.create(prompts[0] ?? '', 'batch')
    void router
      .call('generate_images', { ...(params as Record<string, unknown>), prompts, __taskId: taskId }, codexThreadId)
      .catch((error) => {
        manager.fail(taskId, error instanceof Error ? error.message : String(error))
      })

    const snapshot = await manager.waitForTerminal(taskId, blockingBudgetMs)
    if (!snapshot) {
      return { content: [{ type: 'text', text: buildUnknownImageTaskBanner(taskId) }] }
    }
    if (snapshot.status === 'running') {
      return { content: [{ type: 'text', text: buildBatchRunningHandoffBanner(snapshot) }] }
    }
    if (snapshot.status === 'failed') {
      // The whole batch kick failed before the renderer could run.
      return { content: [{ type: 'text', text: buildImageFailureBanner(snapshot) }] }
    }
    return { content: buildBatchContent(snapshot.result as BatchTaskResult) }
  })
}
