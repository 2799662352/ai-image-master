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
    'Up to 9 reference images: local path / https URL / asset://assetId (portrait library) / data: URL. '
    + 'LOOK BEFORE YOU WRITE: view_image ONE representative reference first and write the prompt from what '
    + 'you actually see (subject, framing, palette, wardrobe) — a prompt inferred from the filename '
    + 'contradicts the picture, and the model follows the picture. This does NOT conflict with the rule '
    + 'against batch-opening generated OUTPUTS: those the user is already looking at, this is your INPUT.',
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

// ---------------------------------------------------------------------------
// 看板 JSON IR(export / apply)—— 声明式整体重排
// ---------------------------------------------------------------------------

const irMaterialSchema = z.looseObject({
  name: z.string().describe('Display name only; has no effect on what gets submitted.'),
  src: z.string().describe(
    'local path / https URL / asset://assetId / data: URL, or a wbref://<cardId>/<kind>/<index> '
    + 'placeholder standing for an embedded material already on a card. Copy a wbref:// verbatim to '
    + 'keep or reuse that material — never invent one.',
  ),
})

/** 规格字段全部可选:IR 是声明式快照,省略即回默认值(不是 patch)。 */
const irCardSchema = z.looseObject({
  id: z.string().optional().describe('Existing card id. Omit to CREATE a new card. Unknown id = error.'),
  rev: z.number().optional().describe(
    "This card's spec version from export. Echo it back verbatim. If the user edited THIS card meanwhile, "
    + 'only this card is skipped (reported in `skipped`) — the rest of your apply still lands.',
  ),
  prompt: z.string().optional(),
  model: z.enum(['2.0', '2.0-fast', '2.0-mini']).optional(),
  resolution: z.enum(['480p', '720p', '1080p']).optional(),
  ratio: z.enum(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional(),
  duration: z.union([z.literal(-1), z.number().int().min(4).max(15)]).optional(),
  generateAudio: z.boolean().optional(),
  mode: z.enum([
    'text2video', 'first_frame', 'first_last_frame', 'reference_images',
    'multimodal_ref', 'edit_video', 'extend_video',
  ]).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  webSearch: z.boolean().optional(),
  referenceImages: z.array(irMaterialSchema).max(9).optional(),
  referenceVideos: z.array(irMaterialSchema).max(3).optional(),
  referenceAudios: z.array(irMaterialSchema).max(3).optional(),
  result: z.looseObject({
    status: z.string(),
    taskId: z.string().optional(),
    error: z.string().optional(),
    localPath: z.string().optional(),
    remoteUrl: z.string().optional(),
  }).optional().describe('READ-ONLY annotation from export; ignored on apply.'),
})

const irBoardSchema = z.looseObject({
  id: z.string().optional().describe('Existing board id. Omit to CREATE a new board. Unknown id = error.'),
  name: z.string().min(1),
  cards: z.array(irCardSchema).describe('Array order IS the in-board order.'),
})

const irSchema = z.looseObject({
  irVersion: z.number().describe('Must match the version returned by video_workbench_export.'),
  structureRevision: z.number().describe(
    'Structure token from export (card set / positions / boards). The WHOLE apply is rejected if cards were '
    + 'added, deleted or reordered meanwhile, because positions here are expressed as array order. '
    + 'Per-card spec edits do NOT invalidate this — see each card\'s `rev`.',
  ),
  activeBoardId: z.string().optional(),
  boards: z.array(irBoardSchema).min(1).describe('Array order IS the board (tab) order.'),
})

const applyOutputSchema = z.looseObject({
  ok: z.boolean(),
  conflict: z.object({ expected: z.number(), actual: z.number() }).optional().describe(
    'Set when the STRUCTURE token was stale (cards added/deleted/reordered) — NOTHING was written. '
    + 'Re-export, redo your edits, apply again. Single-card conflicts never land here; they appear in '
    + '`skipped` while everything else is applied.',
  ),
  boards: z.object({
    created: z.array(z.string()),
    renamed: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  cards: z.object({
    created: z.array(z.string()),
    updated: z.array(z.string()),
    moved: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  skipped: z.array(z.object({
    cardId: z.string().optional(),
    boardId: z.string().optional(),
    reason: z.string(),
  })).describe(
    'Per-item rejections (a card the user edited meanwhile, rendering cards whose spec is frozen, unknown '
    + 'ids, unresolvable wbref, …). Everything not listed here was applied.',
  ),
  structureRevision: z.number().describe('New structure token; carry it into the next apply.'),
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
      '填好任务; for a single quick video in chat, prefer generate_video. ' +
      'WHEN A CARD CARRIES REFERENCE IMAGES, view_image ONE of them BEFORE writing that card\'s prompt — ' +
      'the render follows the picture, so a prompt written from a filename argues with it. Viewing an ' +
      'INPUT is not the batch-opening of generated OUTPUTS that other tools warn against.',
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
      'card snapshot plus a compact `workbench` overview (boards + global status counts). ' +
      'If you are attaching or replacing reference images here, view_image one of them before rewriting ' +
      'the prompt — same reason as on add_tasks: the render follows the picture, not the filename.',
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

  server.registerTool('video_workbench_export', {
    description:
      'Export the whole 「生成视频」 workbench as an editable JSON IR (boards → cards, array order = '
      + 'display order). Use this whenever the user asks for a change that spans more than one card — '
      + '重排/整理/拆成两页/给这一页所有卡换成 1080p/把这几镜挪到新页 —— then edit the JSON and send it '
      + 'back via video_workbench_apply. That is one round trip instead of a dozen per-card calls, and it '
      + 'is the only way to reorder cards or create/rename/delete boards.\n'
      + 'The IR carries two concurrency tokens, both of which apply must echo back: `structureRevision` '
      + '(whole-IR — stale means cards were added/deleted/reordered, so the apply is rejected outright) and '
      + "a per-card `rev` (stale means the user edited THAT card, so only that card is skipped). "
      + 'Embedded (data:) materials appear as '
      + '`wbref://<cardId>/<kind>/<index>` placeholders — copy them verbatim to keep a material, or copy '
      + 'one onto another card to reuse that material without re-uploading.',
    inputSchema: z.object({
      boardId: z.string().optional().describe(
        'Export only this board (keeps the payload small on a large workbench). Omit = every board. '
        + 'Safe to apply back with the default merge mode: boards you did not list are left alone.',
      ),
    }),
    outputSchema: irSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_export', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return okResult([
        '✅ video_workbench_export — edit this JSON and send it back through video_workbench_apply '
        + '(keep `irVersion`, `structureRevision` and every card `rev` unchanged).',
      ], result)
    } catch (error) {
      return errorResult('video_workbench_export', error)
    }
  })

  server.registerTool('video_workbench_apply', {
    description:
      'Apply an edited workbench IR (from video_workbench_export) in ONE shot: create/update/reorder/'
      + 'delete cards and boards together. This is the preferred way to make multi-card changes.\n'
      + 'Rules that matter:\n'
      + '• DECLARATIVE, NOT A PATCH — a card omitting `resolution` gets the DEFAULT resolution, not its '
      + 'old one. Always start from a fresh export and keep the fields you are not changing.\n'
      + '• `id` present = edit that existing card/board; `id` omitted = create a new one; unknown id = error.\n'
      + '• Array order is the order: reordering cards means reordering the array (there is no order field).\n'
      + '• Two tokens, two failure modes. Stale `structureRevision` (cards added/deleted/reordered) → '
      + 'rejected with `conflict`, NOTHING written; re-export, redo your edits, apply again. Stale card '
      + '`rev` (the user edited that one card) → only that card is skipped, everything else lands; read '
      + '`skipped` and tell the user which card you could not change. Do not pass force unless the user '
      + 'accepted that their concurrent edits get overwritten.\n'
      + '• mode "merge" (default) leaves boards/cards you did not list untouched — safe. mode "replace" '
      + 'DELETES every card and board missing from the IR; only use it when the user asked to clear things.\n'
      + '• Cards that are currently rendering keep their frozen spec (they can still be moved), and are '
      + 'never deleted. Read `skipped` in the result to see exactly what did not happen.',
    inputSchema: z.object({
      ir: irSchema.describe('The edited IR, including the original irVersion, structureRevision and card revs.'),
      mode: z.enum(['merge', 'replace']).optional().describe(
        'merge (default): unlisted boards/cards are kept. replace: unlisted boards/cards are DELETED.',
      ),
      force: z.boolean().optional().describe(
        'Skip BOTH token checks, overwriting whatever the user changed meanwhile. Requires explicit user consent.',
      ),
    }),
    outputSchema: applyOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_apply', params as Record<string, unknown>, extractCodexThreadId(ctx)) as {
        ok: boolean
        conflict?: { expected: number; actual: number }
        skipped: Array<{ reason: string }>
        structureRevision: number
      }
      if (!result.ok) {
        return okResult([
          result.conflict
            ? `⚠️ video_workbench_apply — REJECTED, nothing was written: cards were added, deleted or reordered since your export (structureRevision ${result.conflict.expected} → ${result.conflict.actual}), so the array positions in your IR no longer line up. Call video_workbench_export again, redo your edits on the fresh IR, then apply.`
            : '⚠️ video_workbench_apply — REJECTED, nothing was written (see skipped reasons).',
        ], result)
      }
      return okResult([
        `✅ video_workbench_apply — applied. New structureRevision ${result.structureRevision}; use it for your next apply.`,
        ...(result.skipped.length > 0
          ? [`⚠️ ${result.skipped.length} item(s) skipped — read \`skipped\` and tell the user what did not happen.`]
          : []),
      ], result)
    } catch (error) {
      return errorResult('video_workbench_apply', error)
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
