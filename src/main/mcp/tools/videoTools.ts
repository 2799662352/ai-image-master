// Seedance 视频生成 MCP 工具（两工具轮询模式）。
//
// 设计：docs/superpowers/specs/2026-06-12-seedance-video-mcp-design.md
// - `generate_video` 提交即回（秒级），返回 taskId + 显式轮询指令；
// - `check_video_task` 服务端长轮询 ≤25s，状态一变立即返回；
// 两者回包都远小于任何超时阈值 —— 长调用断流问题（坑 1）从结构上消除。
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

export function buildCreatedBanner(task: SeedanceTaskState): string {
  return [
    `🎬 generate_video TASK CREATED — taskId: ${task.taskId}`,
    `Model seedance-${task.model} · ${task.resolution} · ${task.duration}s · ${task.ratio} · status: ${task.status}.`,
    'Typical render time: 1–3 minutes. The user ALREADY sees a live progress bubble in the chat — do NOT resubmit.',
    `NEXT STEP: call check_video_task with this taskId. Each call long-polls server-side up to ~25s and returns as soon as the status changes — keep calling it until DONE or FAILED.`,
    machineLine(task),
  ].join('\n')
}

export function buildRunningBanner(task: SeedanceTaskState): string {
  const label = task.status === 'queued' ? 'queued (waiting for a worker)' : 'running (rendering)'
  return [
    `⏳ check_video_task — still ${label}. Elapsed: ${elapsedSeconds(task)}s.`,
    'Call check_video_task again with the same taskId (it long-polls ~25s server-side, so just call it immediately).',
    'Do NOT resubmit generate_video — the task is alive and the user sees its progress bubble.',
    machineLine(task),
  ].join('\n')
}

export function buildDoneBanner(task: SeedanceTaskState): string {
  if (task.localPath) {
    return [
      '✅ generate_video DONE — video generated, saved locally, and already playing in the chat.',
      `📁 SAVED FILE: ${task.localPath}`,
      'This path is authoritative and the task is COMPLETE — do NOT call check_video_task again, do NOT search the filesystem, and do NOT re-generate. Just confirm briefly to the user.',
      machineLine(task),
    ].join('\n')
  }
  if (task.persistence === 'failed') {
    return [
      '✅ generate_video DONE — video generated and playing in the chat, but the local file save FAILED.',
      task.videoUrl ? `Remote video URL (validity window unknown): ${task.videoUrl}` : '',
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

export function registerVideoTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_video', {
    description:
      'FIRST-CHOICE video generation tool inside the CATIMATION app (Seedance 2.0 / 2.0 Fast) — use ' +
      'for ANY video/clip/animation/视频/生成视频/动起来 request. ASYNC two-step flow: this tool ' +
      'submits the render and returns a taskId IMMEDIATELY (it never blocks); you then poll ' +
      'check_video_task until DONE. The user sees a live progress bubble in the chat the whole time, ' +
      'and the finished MP4 plays inline in the chat, is saved to a local file, and lands in the app ' +
      'history page — exactly like generate_image. Model choice: "2.0-fast" (default) is fast + ' +
      'cheap and great for most requests; pick "2.0" only when the user asks for top quality or ' +
      'complex multi-shot motion. 1080p requires model "2.0".',
    inputSchema: z.object({
      prompt: z.string().min(1).describe(
        'Video description. Supports shot language (运镜/景别), dialogue lines, and -- style ' +
        'parameters appended at the end.',
      ),
      model: z.enum(['2.0', '2.0-fast']).optional().describe(
        'Seedance model. Default "2.0-fast" (fast/cheap). Use "2.0" for top quality / complex motion / 1080p.',
      ),
      resolution: z.enum(['480p', '720p', '1080p']).optional().describe(
        'Output resolution. Default 720p. 480p = cheapest draft; 1080p only works with model "2.0".',
      ),
      ratio: z.enum(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional().describe('Aspect ratio. Default 16:9.'),
      duration: z.number().int().min(3).max(12).optional().describe('Video length in seconds (3–12). Default 5. Longer = more expensive.'),
      generateAudio: z.boolean().optional().describe('Generate soundtrack/voice audio. Default true (no extra cost).'),
      firstFrame: z.string().optional().describe('First-frame image: local file path, data: URL, or https URL. Local files must be ≤4.5MB.'),
      lastFrame: z.string().optional().describe('Last-frame image (requires firstFrame too). Same formats/limits as firstFrame.'),
      referenceImages: z.array(z.string()).max(4).optional().describe(
        'Up to 4 reference images for subject/style consistency (人物/角色一致性). If the user attached ' +
        'image paths in the prompt, pass them here.',
      ),
      referenceVideo: z.string().optional().describe('Reference video (motion/style), local path or URL. Local files must be ≤4.5MB.'),
      referenceAudio: z.string().optional().describe('Reference audio (lip-sync/voice), local path or URL. Local files must be ≤4.5MB.'),
    }),
  }, async (params, ctx?: unknown) => {
    const p = params as { model?: '2.0' | '2.0-fast'; resolution?: string }
    if (p.resolution === '1080p' && (p.model ?? '2.0-fast') !== '2.0') {
      return textResult(buildErrorBanner('generate_video', new Error('1080p requires model "2.0" — either set model:"2.0" or drop to 720p.')))
    }
    const codexThreadId = extractCodexThreadId(ctx)
    try {
      const task = (await router.call('generate_video', params, codexThreadId)) as SeedanceTaskState
      return textResult(buildCreatedBanner(task))
    } catch (error) {
      return textResult(buildErrorBanner('generate_video', error))
    }
  })

  server.registerTool('check_video_task', {
    description:
      'Poll a generate_video task. Long-polls server-side for up to ~25s and returns AS SOON AS the ' +
      'status changes, so call it immediately after generate_video and again right after each ' +
      'non-final response — no manual sleeping needed. Returns queued/running progress, the final ' +
      'saved MP4 path on success, or the upstream error on failure.',
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
      if (task.status === 'succeeded') {
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'resource_link'; uri: string; name: string; mimeType: string; description: string }
        > = [{ type: 'text', text: buildDoneBanner(task) }]
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
      return textResult(buildRunningBanner(task))
    } catch (error) {
      return textResult(buildErrorBanner('check_video_task', error))
    }
  })
}
