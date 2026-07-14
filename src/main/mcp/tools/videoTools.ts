// Seedance 视频生成 MCP 工具（catimation generate_image 同款「阻塞到完成」模式）。
//
// 设计演进（2026-06-12 v2）：
// - v1 是「提交即回 + check_video_task 轮询」双工具模式 —— 实测 codex 经常在
//   渲染完成前就停止轮询（turn 结束/自行判断「已提交」），视频出来了用户却
//   没有拿到结果。
// - v2 对齐 catimation `generate_image` 策略：stdio 桥上长工具调用是安全的
//   （坑 1 只影响 streamable HTTP；codexLaunch 配了 tool_timeout_sec=2000），
//   所以 `generate_video` 内部轮询任务直到终态才返回 —— 「生成完才回归」，
//   模型零轮询负担、不可能提前弃坑。
// - `check_video_task` 是常规续轮询：首个阻塞窗口（~75s）烧完就交还 taskId，模型
//   接着用它每 ~25s 长轮询到终态；也用于 app 重启后追旧任务。
//
// 设计演进（2026-07-02 v3）：首窗从 10 分钟压到 ~75s（对齐 generate_image 的 60s
//   首窗）。原因：阻塞期间模型不推理，用户 turn/steer 插话会排队到工具返回才处理；
//   短首窗让模型每轮 check_video_task 之间冒头一次，插话响应从 ≤10min 降到 ≤~25s。
//   可靠性不降——成片由 SeedanceTaskListener 独立落聊天，banner 明确要求继续轮询。
//
// banner 约定与 imageTools 一致：短文本、完成信号前置、显式「勿重试 /
// 勿翻文件 / 勿自检」，结尾附 machine-readable JSON 行。

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import type { SeedanceTaskState } from '../../services/seedance/types'

/** check_video_task 服务端长轮询窗口（须 < codex 工具超时，留足余量）。 */
export const CHECK_LONG_POLL_MS = 25_000
/**
 * generate_video 首个阻塞窗口。渲染典型 1–3 分钟，但我们只阻塞 ~75s 就把 taskId
 * 交还模型走 check_video_task 兜底 —— 与 generate_image 的 60s 首窗同款(见
 * GENERATE_IMAGE_BLOCKING_BUDGET_MS)。
 *
 * 为什么短:阻塞期间模型不做推理,用户的 turn/steer 插话会一直排队到工具返回才被
 * 处理;首窗压到 ~75s 后,模型每轮 check_video_task(~25s 长轮询)之间都会冒头做一次
 * 推理步,插话响应从「最长 10 分钟」降到「≤~25s」。可靠性不降:成片由
 * SeedanceTaskListener 独立推进聊天,budget-exhausted banner 也明确要求继续轮询、
 * 不重复提交。(codex 工具超时是 2000s,余量充足。)
 */
export const GENERATE_BLOCKING_BUDGET_MS = 75_000
/**
 * succeeded 后等落盘（persistence）的额外预算 —— 成功语义由渲染决定，落盘只是
 * bookkeeping，「后台保存过慢绝不阻塞任务」（坑 3）。视频已在聊天里播放、状态已
 * 广播，这里只为「快落盘」抢回本地路径塞进回包；超过预算就带 persistencePending
 * 立即返回（banner 已说明仍在后台保存）。
 */
export const PERSISTENCE_GRACE_MS = 8_000
/** 落盘等待期的短轮询窗口：让慢落盘最多 ~PERSISTENCE_GRACE_MS 即返回，而非卡满 25s 长轮询。 */
export const PERSISTENCE_POLL_MS = 2_000

/** 与 imageTools.extractCodexThreadId 相同的 _meta 提取逻辑。 */
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

function elapsedSeconds(task: SeedanceTaskState): number {
  return Math.max(0, Math.round((Date.now() - task.createdAt) / 1000))
}

function machineLine(task: SeedanceTaskState): string {
  return JSON.stringify({
    taskId: task.taskId,
    status: task.status,
    model: task.model,
    resolution: task.resolution,
    duration: task.duration,
    ...(task.localPath ? { localPath: task.localPath } : {}),
    ...(task.videoUrl ? { videoUrl: task.videoUrl } : {}),
    ...(task.error ? { error: task.error } : {}),
    persistence: task.persistence,
  })
}

/** 阻塞预算烧完仍未终态：把 taskId 交还模型走 check_video_task 兜底。 */
export function buildBudgetExhaustedBanner(task: SeedanceTaskState): string {
  return [
    `⏳ generate_video STILL RUNNING after ${elapsedSeconds(task)}s — taskId: ${task.taskId}.`,
    'The render is taking unusually long but the task is alive; the user sees a live progress bubble in the chat.',
    'NEXT STEP: call check_video_task with this taskId (it long-polls ~25s server-side) and keep calling until DONE or FAILED. Do NOT resubmit generate_video.',
    machineLine(task),
  ].join('\n')
}

export function buildRunningBanner(task: SeedanceTaskState): string {
  const label = task.status === 'queued' ? 'queued (waiting for a worker)' : 'running (rendering)'
  return [
    `⏳ check_video_task — still ${label}. Elapsed: ${elapsedSeconds(task)}s.`,
    'If you have NOT yet told the user the render is in progress, say so in one short line BEFORE polling again — never leave the user in silence across multiple polls.',
    'Call check_video_task again with the same taskId (it long-polls ~25s server-side, so just call it immediately).',
    'Do NOT resubmit generate_video — the task is alive and the user sees its progress bubble.',
    machineLine(task),
  ].join('\n')
}

/**
 * 「交付优先」硬指令 —— 治「视频早出来了 agent 还在闷头 QA」(2026-07-14 实录):
 * skill 的 QA 分级(抽帧九宫格/understand_video)本身合理,但模型倾向于拿到 DONE
 * 后先静默跑完全部质检再回话,turn 在用户看来就是卡死。banner 是模型每次必读的
 * 位置,在这里强制「先一句话交付 → 出声再 QA」,与 skill 的 QA 纪律互补不冲突。
 */
const DELIVER_FIRST_VIDEO =
  'FIRST, before anything else: send the user a one-line delivery message NOW (the video is already playing in the chat; cite the saved path). Only AFTER that message may you run QA/verification (frame grids, understand_video, etc.) — and announce it briefly (e.g. 「正在快速质检…」) before starting. NEVER run silent QA before replying; the user cannot see tool calls and will think you are stuck.'

export function buildDoneBanner(task: SeedanceTaskState): string {
  if (task.localPath) {
    return [
      '✅ generate_video DONE — video generated, saved locally, and already playing in the chat.',
      `📁 SAVED FILE: ${task.localPath}`,
      DELIVER_FIRST_VIDEO,
      'This path is authoritative and the task is COMPLETE — do NOT call check_video_task again, do NOT search the filesystem, and do NOT re-generate.',
      machineLine(task),
    ].join('\n')
  }
  if (task.persistence === 'failed') {
    return [
      '✅ generate_video DONE — video generated and playing in the chat, but the local file save FAILED.',
      task.videoUrl ? `Remote video URL (validity window unknown): ${task.videoUrl}` : '',
      DELIVER_FIRST_VIDEO,
      'The generation itself is COMPLETE — do NOT retry. Mention to the user that local save failed.',
      machineLine(task),
    ]
      .filter((l) => l.length > 0)
      .join('\n')
  }
  // persistence still running: success is decided by the render — never make
  // the agent wait on bookkeeping (pitfalls doc, lesson 3).
  return [
    '✅ generate_video DONE — video generated and already playing in the chat.',
    'Local file save is still finishing in the background (persistencePending) — treat this task as COMPLETE; do NOT retry.',
    DELIVER_FIRST_VIDEO,
    'If you genuinely need the saved path, call check_video_task ONCE more in ~10s; otherwise just confirm to the user.',
    machineLine(task),
  ].join('\n')
}

export function buildFailedBanner(task: SeedanceTaskState): string {
  return [
    `❌ generate_video FAILED — ${task.error ?? 'upstream reported failure without a reason'}.`,
    'The user sees the failure in the chat bubble. You may retry ONCE with an adjusted prompt if the error suggests a content/parameter problem; otherwise report the error to the user.',
    machineLine(task),
  ].join('\n')
}

export function buildUnknownTaskBanner(taskId: string): string {
  return [
    `❌ check_video_task — unknown taskId: ${taskId}.`,
    'Tasks live in memory and are dropped after app restart or ~30 minutes past completion.',
    'If the video never appeared in the chat, submit a NEW generate_video call; do not keep checking this id.',
    JSON.stringify({ taskId, status: 'unknown' }),
  ].join('\n')
}

function buildErrorBanner(tool: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes('SEEDANCE_KEY_MISSING')) {
    return [
      `❌ ${tool} — Seedance API Key is not configured.`,
      'Tell the user to open 设置页 (Settings) → 「Seedance 视频生成」 and paste their API Key, then retry.',
      JSON.stringify({ ok: false, error: 'SEEDANCE_KEY_MISSING' }),
    ].join('\n')
  }
  return [
    `❌ ${tool} failed: ${msg}`,
    JSON.stringify({ ok: false, error: msg }),
  ].join('\n')
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

type ToolContent = Array<
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string; description: string }
>

/** succeeded 任务的统一回包：DONE banner + 本地文件 resource_link。 */
function doneContent(task: SeedanceTaskState): { content: ToolContent } {
  const content: ToolContent = [{ type: 'text', text: buildDoneBanner(task) }]
  if (task.localPath) {
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(task.localPath).href,
      name: path.basename(task.localPath),
      mimeType: 'video/mp4',
      description: 'Generated video saved locally (also playing in app chat + history).',
    })
  }
  return { content }
}

/**
 * 阻塞轮询任务直到终态（catimation「生成完才回归」策略）。
 * - 每轮复用 check_video_task 的服务端长轮询（≤25s，状态一变即醒）；
 * - succeeded 后再给落盘 PERSISTENCE_GRACE_MS 预算，烧完即返回
 *   （banner 自带 persistencePending 文案，绝不让模型等 bookkeeping）；
 * - 总预算 GENERATE_BLOCKING_BUDGET_MS 烧完返回当前快照，由调用方给
 *   handoff banner 转 check_video_task 兜底。
 */
async function waitForTerminal(
  router: ToolRouter,
  taskId: string,
  codexThreadId: string | undefined,
): Promise<SeedanceTaskState | null> {
  const startedAt = Date.now()
  let persistenceWaitStart: number | null = null
  while (true) {
    // 落盘等待期用短轮询（PERSISTENCE_POLL_MS），渲染期用默认长轮询：慢落盘最多
    // 等 ~PERSISTENCE_GRACE_MS 就带 persistencePending 返回，绝不卡满 25s。
    const callParams =
      persistenceWaitStart !== null ? { taskId, pollMs: PERSISTENCE_POLL_MS } : { taskId }
    const res = (await router.call('check_video_task', callParams, codexThreadId)) as {
      found: boolean
      task?: SeedanceTaskState
    }
    if (!res.found || !res.task) return null
    const task = res.task
    if (task.status === 'failed') return task
    if (task.status === 'succeeded') {
      if (task.persistence !== 'running') return task
      persistenceWaitStart ??= Date.now()
      if (Date.now() - persistenceWaitStart > PERSISTENCE_GRACE_MS) return task
      continue
    }
    if (Date.now() - startedAt > GENERATE_BLOCKING_BUDGET_MS) return task
  }
}

export function registerVideoTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_video', {
    description:
      'FIRST-CHOICE video generation tool inside the CATIMATION app (Seedance 2.0 / 2.0 Fast) — use ' +
      'for ANY video/clip/animation/视频/生成视频/动起来 request. Submits the render and blocks ' +
      '~75s for fast results/early failures; a normal render takes 1–3 minutes, so it COMMONLY ' +
      'returns ⏳ STILL RUNNING with a taskId — then just keep calling check_video_task (server ' +
      'long-polls ~25s, returns the moment status changes) until DONE or FAILED. Do NOT resubmit ' +
      'generate_video. The user sees a live progress bubble the whole time and the finished MP4 ' +
      'plays inline in the chat, is saved to a local file, and lands in the app history page — the ' +
      'video is delivered to the chat automatically even if you stop polling. Model choice: "2.0" ' +
      '(default — 满血/full-quality model) for top quality and complex multi-shot motion; only switch to ' +
      '"2.0-fast" when the user explicitly asks for fast/cheap/draft. Default resolution is 720p — do NOT jump to 1080p unless the user asks for HD; 1080p requires model "2.0". When the spec is unstated, confirm resolution/duration/ratio with the user (an ask_user card) before rendering. All input images are ' +
      'automatically imported into the user\'s portrait library (人像库) and referenced as ' +
      'asset://assetId — identical images are deduplicated upstream, which keeps characters ' +
      'consistent across videos. You can also pass an existing asset://assetId (from the 人像库 ' +
      'page) directly as any image input. DEFAULT MODE = 全能参考 (omni-reference): for almost every ' +
      'request, supply the user material via referenceImages (up to 9), referenceVideos (up to 3, total ' +
      '≤15s) and referenceAudios (up to 3, total ≤15s) — this keeps subject/motion/voice consistent and ' +
      'is the recommended path. Only use firstFrame/lastFrame (strict first/last-frame mode) when the ' +
      'user explicitly asks for it or has a clear first/last-frame need. This ONE tool also covers ' +
      'VIDEO EDITING (替换/增删/修改元素 in an existing clip) and VIDEO EXTENSION (向前/向后延长 or ' +
      'stitching up to 3 clips): both are just omni-reference under the hood — pass the source clip(s) ' +
      'via referenceVideos and write an edit/extend-style prompt (see the catimation-video skill). In ' +
      'the prompt, refer to materials by ordinal ("视频1 / 图片1 / 音频1"), never by assetId. Note: real ' +
      'human faces cannot be used as references directly — use a 人像库 asset:// (virtual avatar) or a ' +
      'previously Seedance-generated clip.',
    inputSchema: z.object({
      prompt: z.string().min(1).describe(
        'Video description. Supports shot language (运镜/景别), dialogue lines, and -- style ' +
        'parameters appended at the end.',
      ),
      model: z.enum(['2.0', '2.0-fast']).optional().describe(
        'Seedance model. Default "2.0" (满血/full-quality — top quality, complex motion, 1080p). Only use "2.0-fast" when the user explicitly wants fast/cheap/draft.',
      ),
      resolution: z.enum(['480p', '720p', '1080p']).optional().describe(
        'Output resolution. Default 720p. 480p = cheapest draft; 1080p only works with model "2.0".',
      ),
      ratio: z.enum(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional().describe('Aspect ratio. Default 16:9.'),
      duration: z.number().int().min(4).max(15).optional().describe('Video length in seconds (4–15). Default 5. Longer = more expensive.'),
      generateAudio: z.boolean().optional().describe('Generate soundtrack/voice audio. Default true (no extra cost).'),
      firstFrame: z.string().optional().describe('STRICT first/last-frame mode only — use ONLY when the user explicitly wants a fixed first frame. First-frame image: local file path, data: URL, https URL, or asset://assetId (portrait library). Local images ≤30MB (large files are relayed automatically).'),
      lastFrame: z.string().optional().describe('Last-frame image (requires firstFrame too, strict mode only). Same formats/limits as firstFrame.'),
      referenceImages: z.array(z.string()).max(9).optional().describe(
        '全能参考 (DEFAULT mode): up to 9 reference images for subject/style consistency (人物/角色一致性). ' +
        'Prefer this over firstFrame for almost every request. If the user attached image paths in the ' +
        'prompt, pass them here. asset://assetId from the portrait library also works.',
      ),
      referenceVideos: z.array(z.string()).max(3).optional().describe(
        '全能参考: up to 3 reference videos (motion/style), local path / URL / asset://assetId. Each 4–15s, ' +
        'local files ≤50MB, COMBINED total duration ≤15s.',
      ),
      referenceAudios: z.array(z.string()).max(3).optional().describe(
        '全能参考: up to 3 reference audios (lip-sync/voice), local path / URL / asset://assetId. Each 4–15s, ' +
        'local files ≤50MB, COMBINED total duration ≤15s.',
      ),
      referenceVideo: z.string().optional().describe('Deprecated single alias for referenceVideos — prefer referenceVideos.'),
      referenceAudio: z.string().optional().describe('Deprecated single alias for referenceAudios — prefer referenceAudios.'),
    }),
  }, async (params, ctx?: unknown) => {
    const p = params as { model?: '2.0' | '2.0-fast'; resolution?: string }
    if (p.resolution === '1080p' && (p.model ?? '2.0') !== '2.0') {
      return textResult(buildErrorBanner('generate_video', new Error('1080p requires model "2.0" — either set model:"2.0" or drop to 720p.')))
    }
    const codexThreadId = extractCodexThreadId(ctx)
    try {
      const task = (await router.call('generate_video', params, codexThreadId)) as SeedanceTaskState
      // catimation 策略：阻塞到生成完成才返回（与 generate_image 一致），
      // 模型零轮询负担、不可能提前弃坑。
      const final = await waitForTerminal(router, task.taskId, codexThreadId)
      if (!final) return textResult(buildUnknownTaskBanner(task.taskId))
      if (final.status === 'failed') return textResult(buildFailedBanner(final))
      if (final.status === 'succeeded') return doneContent(final)
      // 预算烧完仍在渲染：交还 taskId 走 check_video_task 兜底。
      return textResult(buildBudgetExhaustedBanner(final))
    } catch (error) {
      return textResult(buildErrorBanner('generate_video', error))
    }
  })

  server.registerTool('check_video_task', {
    description:
      'FALLBACK poller for a generate_video task — normally NOT needed because generate_video ' +
      'blocks until the video is done. Use it ONLY when generate_video returned a STILL RUNNING ' +
      'handoff (with a taskId), or to re-check a task after an unexpected interruption. Long-polls ' +
      'server-side for up to ~25s and returns AS SOON AS the status changes; keep calling until ' +
      'DONE or FAILED. Returns queued/running progress, the final saved MP4 path on success, or ' +
      'the upstream error on failure.',
    inputSchema: z.object({
      taskId: z.string().min(1).describe('Task id returned by generate_video.'),
    }),
  }, async (params, ctx?: unknown) => {
    const codexThreadId = extractCodexThreadId(ctx)
    try {
      const result = (await router.call('check_video_task', params, codexThreadId)) as {
        found: boolean
        task?: SeedanceTaskState
      }
      if (!result.found || !result.task) {
        return textResult(buildUnknownTaskBanner(String((params as { taskId?: unknown }).taskId ?? '')))
      }
      const task = result.task
      if (task.status === 'failed') return textResult(buildFailedBanner(task))
      if (task.status === 'succeeded') return doneContent(task)
      return textResult(buildRunningBanner(task))
    } catch (error) {
      return textResult(buildErrorBanner('check_video_task', error))
    }
  })
}
