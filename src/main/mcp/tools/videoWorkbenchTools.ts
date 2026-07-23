// 「生成视频」工作台 MCP 工具 —— AI 与用户操作同一个工作台页面(人机协同)。
//
// 路由模式:这些工具**不注册 main handler**,router.call 走 renderer 回退
// (agent:tool-request → AgentToolExecutor → useVideoWorkbenchStore),
// 与 canvas_* / navigate_page 同款。卡片状态的单一真相源在渲染端 store,
// 用户在页面上看到的、和这里读写的,是同一份数据。
//
// 生成本身仍复用主进程 SeedanceTaskManager(video-workbench:submit IPC),
// 所以 video_workbench_start 返回的 taskId 可以直接用 check_video_task 长轮询。
//
// 结构化输出(MCP 规范 2025-11-25):bundled @modelcontextprotocol/server
// (2.0.0-alpha.2)的 registerTool 原生支持 outputSchema + structuredContent,
// 这里全量接入 —— 每个工具声明 outputSchema,成功结果同时回
// structuredContent(权威)与 text JSON(兜底);执行错误回 isError: true +
// content 报错(SDK 对 isError 结果豁免 outputSchema 校验)。
// 快照体积纪律(Codex prompting 指南 + openai/codex #5544/#6426):prompt
// 截 120 字、素材只列名字(截 40 字),绝不把 URL/base64 全文倒进上下文。

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

const cardInputSchema = z.object({
  prompt: z.string().optional().describe('Video description (shot language / dialogue / -- style params).'),
  model: z.enum(['2.0', '2.0-fast', '2.0-mini']).optional().describe(
    'Seedance model. Default "2.0" (full quality); "2.0-fast" cheaper draft; "2.0-mini" cheapest (480p/720p only).',
  ),
  resolution: z.enum(['480p', '720p', '1080p']).optional().describe('Default 720p. 1080p requires model "2.0".'),
  ratio: z.enum(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional().describe('Aspect ratio. Default 16:9.'),
  duration: z.union([z.literal(-1), z.number().int().min(4).max(15)]).optional().describe(
    'Seconds (4-15), or -1 = smart duration (model decides). Default 5.',
  ),
  generateAudio: z.boolean().optional().describe('Generate soundtrack. Default true.'),
  referenceImages: z.array(z.string()).max(9).optional().describe(
    'Up to 9 reference images: local path / https URL / asset://assetId (portrait library) / data: URL.',
  ),
  referenceVideos: z.array(z.string()).max(3).optional().describe('Up to 3 reference videos (combined ≤15s).'),
  referenceAudios: z.array(z.string()).max(3).optional().describe('Up to 3 reference audios (combined ≤15s).'),
})

// ---------------------------------------------------------------------------
// outputSchema(镜像渲染端 snapshotCard / snapshotWorkbench 的形状;卡快照用
// looseObject 容忍渐进新增字段,不因加字段破坏协议校验)
// ---------------------------------------------------------------------------

const boardBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  cardCount: z.number(),
})

const statusCountsSchema = z.object({
  draft: z.number(),
  preparing: z.number(),
  queued: z.number(),
  running: z.number(),
  succeeded: z.number(),
  failed: z.number(),
})

/** 全局摘要:写操作统一回带,一眼看清全工作台现状。 */
const workbenchSummarySchema = z.object({
  activeBoardId: z.string(),
  boards: z.array(boardBriefSchema),
  statusCounts: statusCountsSchema.describe('Global card status tally across ALL boards.'),
})

/** 素材紧凑清单条目:只有截断后的展示名,无 URL 全文。 */
const materialBriefSchema = z.object({ name: z.string() })

const cardSnapshotSchema = z.looseObject({
  cardId: z.string(),
  boardId: z.string().optional().describe('Owning board id; board name lives in the top-level boards list.'),
  order: z.number(),
  prompt: z.string().describe('Truncated to 120 chars.'),
  model: z.string(),
  resolution: z.string(),
  ratio: z.string(),
  duration: z.number(),
  generateAudio: z.boolean(),
  mode: z.string(),
  seed: z.number().optional(),
  webSearch: z.boolean(),
  referenceCounts: z.object({ images: z.number(), videos: z.number(), audios: z.number() }),
  references: z.object({
    images: z.array(materialBriefSchema),
    videos: z.array(materialBriefSchema),
    audios: z.array(materialBriefSchema),
  }).describe('Compact material lists: display names only (≤40 chars, asset:// gets @assetId suffix).'),
  status: z.string().describe('draft/preparing/queued/running/succeeded/failed'),
  taskId: z.string().optional(),
  error: z.string().optional(),
  localPath: z.string().optional(),
  remoteUrl: z.string().optional(),
})

const startResultShape = {
  started: z.array(z.string()),
  skipped: z.array(z.object({ cardId: z.string(), reason: z.string() })),
}

const addTasksOutputSchema = z.looseObject({
  cardIds: z.array(z.string()),
  total: z.number().describe('Card count across all boards.'),
  start: z.object(startResultShape).optional(),
  workbench: workbenchSummarySchema,
})

const updateTaskOutputSchema = z.looseObject({
  ok: z.boolean(),
  card: cardSnapshotSchema,
  workbench: workbenchSummarySchema,
})

const startOutputSchema = z.looseObject({
  ...startResultShape,
  workbench: workbenchSummarySchema,
})

const statusOutputSchema = z.looseObject({
  total: z.number().describe('Number of cards returned (after cardIds/boardId filters).'),
  activeBoardId: z.string(),
  boards: z.array(boardBriefSchema),
  cards: z.array(cardSnapshotSchema),
})

const removeTasksOutputSchema = z.looseObject({
  removed: z.array(z.string()),
  total: z.number(),
  workbench: workbenchSummarySchema,
})

type WorkbenchToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** 成功:structuredContent 为权威结构化结果,text 同时带 banner + JSON 兜底。 */
function okResult(bannerLines: string[], structured: unknown): WorkbenchToolResult {
  return {
    content: [{ type: 'text', text: [...bannerLines, JSON.stringify(structured)].join('\n') }],
    structuredContent: structured as Record<string, unknown>,
  }
}

/** 执行错误:isError: true + content 报错(MCP 规范的工具执行错误通道)。 */
function errorResult(tool: string, error: unknown): WorkbenchToolResult {
  const msg = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: `❌ ${tool} failed: ${msg}` }],
    isError: true,
  }
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
      'video workbench the user sees). Cards land on the currently ACTIVE board (the workbench has ' +
      'multiple boards/pages — see video_workbench_status). Each card carries a prompt + Seedance spec ' +
      '(model/resolution/ratio/duration) + reference materials. By default this only FILLS the cards ' +
      '(user reviews and clicks generate); pass autoStart:true to start rendering immediately. The app ' +
      'auto-navigates to the workbench tab so the user watches the cards appear. The result includes a ' +
      'compact `workbench` overview (boards + global status counts) so you always see the whole ' +
      'workbench after writing. Use this when the user asks to 排卡片/批量准备视频任务/在生成视频页帮我' +
      '填好任务; for a single quick video in chat, prefer generate_video.',
    inputSchema: z.object({
      tasks: z.array(cardInputSchema).min(1).max(20).describe('Cards to append, top-to-bottom order.'),
      autoStart: z.boolean().optional().describe('Start rendering right after adding. Default false (fill only).'),
      navigate: z.boolean().optional().describe('Switch the app to the workbench tab. Default true.'),
    }),
    outputSchema: addTasksOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_add_tasks', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return okResult([
        '✅ video_workbench_add_tasks — cards added to the workbench page (visible to the user).',
        (params as { autoStart?: boolean }).autoStart
          ? 'Rendering started: a normal render takes 1–3 minutes. Poll with video_workbench_status (or check_video_task per taskId) until every card is succeeded/failed. Results play inline on the workbench page and are saved locally + to COS automatically.'
          : 'Cards are FILLED but not started. Ask the user to review, or call video_workbench_start to begin rendering.',
      ], result)
    } catch (error) {
      return errorResult('video_workbench_add_tasks', error)
    }
  })

  server.registerTool('video_workbench_update_task', {
    description:
      'Update ONE existing card on the 「生成视频」 workbench page: prompt, spec (model/resolution/ratio/' +
      'duration/generateAudio) and/or reference materials. Cards that are currently rendering cannot be ' +
      'edited. Get cardIds from video_workbench_add_tasks or video_workbench_status. Returns the updated ' +
      'card snapshot plus a compact `workbench` overview (boards + global status counts).',
    inputSchema: z.object({
      cardId: z.string().min(1).describe('Target card id.'),
    }).merge(cardInputSchema),
    outputSchema: updateTaskOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_update_task', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return okResult([], result)
    } catch (error) {
      return errorResult('video_workbench_update_task', error)
    }
  })

  server.registerTool('video_workbench_start', {
    description:
      'Start rendering workbench cards (concurrent). Omit cardIds to start EVERY startable card on the ' +
      'ACTIVE board (draft/failed/succeeded with a non-empty prompt); pass cardIds to start specific ones ' +
      '(any board). Renders run 1–3 minutes each, concurrently. Returns started/skipped plus a compact ' +
      '`workbench` overview. After starting, poll video_workbench_status until all cards reach ' +
      'succeeded/failed — the user watches live progress on the workbench page either way.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).optional().describe('Cards to start. Omit = all startable cards on the active board.'),
    }),
    outputSchema: startOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_start', params as Record<string, unknown>, extractCodexThreadId(ctx)) as {
        started: string[]
        skipped: Array<{ cardId: string; reason: string }>
      }
      return okResult([
        result.started.length > 0
          ? `⏳ video_workbench_start — ${result.started.length} render(s) submitted. Poll video_workbench_status every ~20s until all cards are succeeded/failed; do NOT resubmit.`
          : '⚠️ video_workbench_start — nothing started (see skipped reasons).',
      ], result)
    } catch (error) {
      return errorResult('video_workbench_start', error)
    }
  })

  server.registerTool('video_workbench_status', {
    description:
      'Snapshot of the 「生成视频」 workbench. The workbench has multiple boards (pages): the result ' +
      'carries `boards` [{id,name,cardCount}] + `activeBoardId`, and every card carries its `boardId` ' +
      '(look up board names in the boards list). Each card: prompt, spec, status (draft/preparing/' +
      'queued/running/succeeded/failed), compact reference-material name lists, taskId, error, and the ' +
      'saved localPath / permanent remoteUrl for finished videos. Pass boardId to inspect one board; ' +
      'omit to see all boards. Use it to poll after video_workbench_start, or to inspect what the user ' +
      'has set up before editing cards.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).optional().describe('Limit to specific cards. Omit = all.'),
      boardId: z.string().optional().describe('Limit to one board (page). Omit = cards from all boards.'),
    }),
    outputSchema: statusOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_status', params as Record<string, unknown>, extractCodexThreadId(ctx)) as {
        cards: Array<{ status: string }>
      }
      const active = result.cards.filter((c) => c.status === 'preparing' || c.status === 'queued' || c.status === 'running').length
      const banner = active > 0
        ? `⏳ ${active} card(s) still rendering — poll video_workbench_status again in ~20s. The user sees live progress on the page.`
        : '✅ No card is rendering. Finished videos are playing on the workbench page and saved locally (localPath) + to COS (remoteUrl).'
      return okResult([banner], result)
    } catch (error) {
      return errorResult('video_workbench_status', error)
    }
  })

  server.registerTool('video_workbench_remove_tasks', {
    description:
      'Remove cards from the 「生成视频」 workbench page. Only use when the user explicitly asks to ' +
      'delete/clear cards — this discards their drafts/results from the page (saved local files are ' +
      'kept). Returns the removed ids plus a compact `workbench` overview.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).min(1).describe('Cards to remove.'),
    }),
    outputSchema: removeTasksOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_remove_tasks', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return okResult([], result)
    } catch (error) {
      return errorResult('video_workbench_remove_tasks', error)
    }
  })
}
