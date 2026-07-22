// 「生成视频」工作台 MCP 工具 —— AI 与用户操作同一个工作台页面(人机协同)。
//
// 路由模式:这些工具**不注册 main handler**,router.call 走 renderer 回退
// (agent:tool-request → AgentToolExecutor → useVideoWorkbenchStore),
// 与 canvas_* / navigate_page 同款。卡片状态的单一真相源在渲染端 store,
// 用户在页面上看到的、和这里读写的,是同一份数据。
//
// 生成本身仍复用主进程 SeedanceTaskManager(video-workbench:submit IPC),
// 所以 video_workbench_start 返回的 taskId 可以直接用 check_video_task 长轮询。

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

const cardInputSchema = z.object({
  prompt: z.string().optional().describe('Video description (shot language / dialogue / -- style params).'),
  model: z.enum(['2.0', '2.0-fast']).optional().describe('Seedance model. Default "2.0" (full quality).'),
  resolution: z.enum(['480p', '720p', '1080p']).optional().describe('Default 720p. 1080p requires model "2.0".'),
  ratio: z.enum(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional().describe('Aspect ratio. Default 16:9.'),
  duration: z.number().int().min(4).max(15).optional().describe('Seconds (4-15). Default 5.'),
  generateAudio: z.boolean().optional().describe('Generate soundtrack. Default true.'),
  referenceImages: z.array(z.string()).max(9).optional().describe(
    'Up to 9 reference images: local path / https URL / asset://assetId (portrait library) / data: URL.',
  ),
  referenceVideos: z.array(z.string()).max(3).optional().describe('Up to 3 reference videos (combined ≤15s).'),
  referenceAudios: z.array(z.string()).max(3).optional().describe('Up to 3 reference audios (combined ≤15s).'),
})

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function errorBanner(tool: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return [`❌ ${tool} failed: ${msg}`, JSON.stringify({ ok: false, error: msg })].join('\n')
}

/** 与 videoTools.extractCodexThreadId 相同的 _meta 提取逻辑。 */
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

export function registerVideoWorkbenchTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('video_workbench_add_tasks', {
    description:
      'Add one or more video task cards to the 「生成视频」 workbench page (the scroll-style concurrent ' +
      'video workbench the user sees). Each card carries a prompt + Seedance spec (model/resolution/' +
      'ratio/duration) + reference materials. By default this only FILLS the cards (user reviews and ' +
      'clicks generate); pass autoStart:true to start rendering immediately. The app auto-navigates to ' +
      'the workbench tab so the user watches the cards appear. Use this when the user asks to 排卡片/' +
      '批量准备视频任务/在生成视频页帮我填好任务; for a single quick video in chat, prefer generate_video.',
    inputSchema: z.object({
      tasks: z.array(cardInputSchema).min(1).max(20).describe('Cards to append, top-to-bottom order.'),
      autoStart: z.boolean().optional().describe('Start rendering right after adding. Default false (fill only).'),
      navigate: z.boolean().optional().describe('Switch the app to the workbench tab. Default true.'),
    }),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_add_tasks', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return textResult([
        '✅ video_workbench_add_tasks — cards added to the workbench page (visible to the user).',
        (params as { autoStart?: boolean }).autoStart
          ? 'Rendering started: a normal render takes 1–3 minutes. Poll with video_workbench_status (or check_video_task per taskId) until every card is succeeded/failed. Results play inline on the workbench page and are saved locally + to COS automatically.'
          : 'Cards are FILLED but not started. Ask the user to review, or call video_workbench_start to begin rendering.',
        JSON.stringify(result),
      ].join('\n'))
    } catch (error) {
      return textResult(errorBanner('video_workbench_add_tasks', error))
    }
  })

  server.registerTool('video_workbench_update_task', {
    description:
      'Update ONE existing card on the 「生成视频」 workbench page: prompt, spec (model/resolution/ratio/' +
      'duration/generateAudio) and/or reference materials. Cards that are currently rendering cannot be ' +
      'edited. Get cardIds from video_workbench_add_tasks or video_workbench_status.',
    inputSchema: z.object({
      cardId: z.string().min(1).describe('Target card id.'),
    }).merge(cardInputSchema),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_update_task', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return textResult(JSON.stringify(result))
    } catch (error) {
      return textResult(errorBanner('video_workbench_update_task', error))
    }
  })

  server.registerTool('video_workbench_start', {
    description:
      'Start rendering workbench cards (concurrent). Omit cardIds to start EVERY startable card ' +
      '(draft/failed/succeeded with a non-empty prompt); pass cardIds to start specific ones. Renders run ' +
      '1–3 minutes each, concurrently. After starting, poll video_workbench_status until all cards reach ' +
      'succeeded/failed — the user watches live progress on the workbench page either way.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).optional().describe('Cards to start. Omit = all startable cards.'),
    }),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_start', params as Record<string, unknown>, extractCodexThreadId(ctx)) as {
        started: string[]
        skipped: Array<{ cardId: string; reason: string }>
      }
      const lines = [
        result.started.length > 0
          ? `⏳ video_workbench_start — ${result.started.length} render(s) submitted. Poll video_workbench_status every ~20s until all cards are succeeded/failed; do NOT resubmit.`
          : '⚠️ video_workbench_start — nothing started (see skipped reasons).',
        JSON.stringify(result),
      ]
      return textResult(lines.join('\n'))
    } catch (error) {
      return textResult(errorBanner('video_workbench_start', error))
    }
  })

  server.registerTool('video_workbench_status', {
    description:
      'Snapshot of all cards on the 「生成视频」 workbench page: prompt, spec, status (draft/preparing/' +
      'queued/running/succeeded/failed), taskId, error, and the saved localPath / permanent remoteUrl for ' +
      'finished videos. Use it to poll after video_workbench_start, or to inspect what the user has set up ' +
      'before editing cards.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).optional().describe('Limit to specific cards. Omit = all.'),
    }),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_status', params as Record<string, unknown>, extractCodexThreadId(ctx)) as {
        cards: Array<{ status: string }>
      }
      const active = result.cards.filter((c) => c.status === 'preparing' || c.status === 'queued' || c.status === 'running').length
      const banner = active > 0
        ? `⏳ ${active} card(s) still rendering — poll video_workbench_status again in ~20s. The user sees live progress on the page.`
        : '✅ No card is rendering. Finished videos are playing on the workbench page and saved locally (localPath) + to COS (remoteUrl).'
      return textResult([banner, JSON.stringify(result)].join('\n'))
    } catch (error) {
      return textResult(errorBanner('video_workbench_status', error))
    }
  })

  server.registerTool('video_workbench_remove_tasks', {
    description:
      'Remove cards from the 「生成视频」 workbench page. Only use when the user explicitly asks to ' +
      'delete/clear cards — this discards their drafts/results from the page (saved local files are kept).',
    inputSchema: z.object({
      cardIds: z.array(z.string()).min(1).describe('Cards to remove.'),
    }),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_remove_tasks', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return textResult(JSON.stringify(result))
    } catch (error) {
      return textResult(errorBanner('video_workbench_remove_tasks', error))
    }
  })
}
