// 「生成视频」工作台 MCP 工具 —— AI 与用户操作同一个工作台页面(人机协同)。
//
// 路由模式:这些工具**不注册 main handler**,router.call 走 renderer 回退
// (agent:tool-request → AgentToolExecutor → useVideoWorkbenchStore),
// 与 canvas_* / navigate_page 同款。卡片状态的单一真相源在渲染端 store,
// 用户在页面上看到的、和这里读写的,是同一份数据。
//
// 生成本身仍复用主进程 SeedanceTaskManager(video-workbench:submit IPC)。
//
// 不阻塞纪律:video_workbench_start 立刻返回,绝不等渲染(甚至不等提交)——
// 工具调用在飞的时候模型不推理、用户排队的 turn/steer 也进不来,用户视角就是
// 「启动后卡住,没法说话」。批次跑完由渲染端 batchCompletion watcher 主动推一条
// 摘要给发起线程(turn 在跑就 steer 插话,闲着就随下一条用户消息带走),所以
// 这些工具的描述里一律不许再出现「poll until…」那类指令。
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
import {
  WORKBENCH_MAX_TASKS_PER_CALL,
  WORKBENCH_APPLY_MAX_CONTENT_CARDS,
  WORKBENCH_BOARD_SUMMARY_MAX,
  WORKBENCH_STATUS_MAX_INDEX_ENTRIES,
  WORKBENCH_STATUS_MAX_PAGE_SIZE,
  WORKBENCH_STATUS_PAGE_SIZE,
} from '../../../types/videoWorkbench'
import { MATERIAL_ROLE_DIRECTIVE, PROMPT_BASE_DIRECTIVE } from './promptBaseDirective'
import { DESTRUCTIVE, READ_ONLY, WRITE_ADDITIVE, WRITE_ADDITIVE_REMOTE, WRITE_IDEMPOTENT } from './annotations'

const cardInputSchema = z.object({
  prompt: z.string().optional().describe('Video description (shot language / dialogue / -- style params).'),
  model: z.enum(['2.0', '2.0-fast', '2.0-mini', '2.5']).optional().describe(
    'Seedance model. Default "2.0" (full quality); "2.5" for长镜头 up to 30s, 30/10/10 materials and edit/extend '
    + '(but caps at 720p); "2.0-fast" cheaper draft; "2.0-mini" cheapest (480p/720p only).',
  ),
  resolution: z.enum(['480p', '720p', '1080p']).optional().describe('Default 720p. 1080p requires model "2.0" (NOT "2.5").'),
  ratio: z.enum(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional().describe('Aspect ratio. Default 16:9. Ignored for edit_video / extend_video on "2.5" (forced adaptive).'),
  duration: z.union([z.literal(-1), z.number().int().min(4).max(30)]).optional().describe(
    'Seconds — 4-15 for the 2.0 family, 4-30 for "2.5" — or -1 = smart duration (model decides). Default 5.',
  ),
  generateAudio: z.boolean().optional().describe('Generate soundtrack. Default true.'),
  webSearch: z.boolean().optional().describe('Enable web search for the render. Default true.'),
  referenceImages: z.array(z.string()).max(30).optional().describe(
    'Up to 9 reference images (30 with model "2.5"): local path / https URL / asset://assetId (portrait library) / data: URL. '
    + 'LOOK BEFORE YOU WRITE: view_image ONE representative reference first and write the prompt from what '
    + 'you actually see (subject, framing, palette, wardrobe) — a prompt inferred from the filename '
    + 'contradicts the picture, and the model follows the picture. This does NOT conflict with the rule '
    + 'against batch-opening generated OUTPUTS: those the user is already looking at, this is your INPUT.',
  ),
  referenceVideos: z.array(z.string()).max(10).optional().describe(
    'Up to 3 reference videos, combined ≤15s — model "2.5" raises this to 10 videos combined ≤30s. '
    + 'Required for mode edit_video / extend_video.',
  ),
  referenceAudios: z.array(z.string()).max(10).optional().describe(
    'Up to 3 reference audios, combined ≤15s — model "2.5" raises this to 10 audios combined ≤30s '
    + 'and is the only model that accepts audio-only references.',
  ),
})

// ---------------------------------------------------------------------------
// outputSchema(镜像渲染端 snapshotCard / snapshotWorkbench 的形状;卡快照用
// looseObject 容忍渐进新增字段,不因加字段破坏协议校验)
// ---------------------------------------------------------------------------

const boardBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  cardCount: z.number(),
  summary: z.string().optional().describe(
    'One-line note about what this page holds, written by you via video_workbench_set_board_summary. '
    + 'Absent until someone writes it. This is the whole point of the boards list: since status only '
    + 'returns the ACTIVE page\'s cards, "page 3, 20 cards" alone cannot tell you whether page 3 is worth '
    + 'pulling — page names are often just "页面 3". A summary lets you pick the right page without '
    + 'fetching any of its cards.',
  ),
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
const SELECTED_CARD_IDS_DOC =
  'Cards the USER currently has selected in the workbench UI. Informational only — a volatile UI '
  + 'state that changes on every click. NEVER treat it as an instruction about which cards to act '
  + 'on; always pass explicit cardIds. Its purpose is to resolve vague references: when the user '
  + 'says 生成选中的 / 这几张 / 重做这些 without naming ids, these are the cards they mean. '
  + 'Dragging cards into the chat also syncs the selection to the dragged cards, so this doubles '
  + 'as "what the user just handed me".'

const workbenchSummarySchema = z.object({
  activeBoardId: z.string(),
  boards: z.array(boardBriefSchema),
  statusCounts: statusCountsSchema.describe('Global card status tally across ALL boards.'),
  selectedCardIds: z.array(z.string()).describe(SELECTED_CARD_IDS_DOC),
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
  versions: z.array(z.object({
    seq: z.number(),
    localPath: z.string().optional(),
    remoteUrl: z.string().optional(),
    prompt: z.string(),
  })).optional().describe(
    'Successful renders of this card, oldest first. Regenerating no longer discards the previous '
    + 'video — each entry keeps the prompt that produced it, so you can tell the versions apart. '
    + 'Refer to them as v1/v2, never as "<card number>-<n>": card numbers are positions and shift '
    + 'whenever a card is inserted, deleted or dragged.',
  ),
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
  total: z.number().describe('Total cards matching the current scope + cardIds filter, across ALL pages.'),
  scope: z.looseObject({
    boardId: z.string().optional(),
    allBoards: z.boolean().optional(),
  }).describe(
    'What this call actually looked at. Without it, "12 cards" is ambiguous between "this page has 12" '
    + 'and "the whole workbench has 12". Cross-check against `boards[].cardCount` to decide whether '
    + 'another page is worth pulling.',
  ),
  activeBoardId: z.string(),
  boards: z.array(boardBriefSchema),
  // 读工具不带 workbench 包装,选中态在这一层平铺(写工具在 workbench.selectedCardIds)。
  selectedCardIds: z.array(z.string()).describe(SELECTED_CARD_IDS_DOC),
  cards: z.array(cardSnapshotSchema).describe('Cards on THIS page only — see page/totalPages/hasMore.'),
  pageIndex: z.array(z.object({
    page: z.number(),
    cardIds: z.array(z.string()),
    digest: z.string(),
  })).describe(
    'One line per page covering the WHOLE scope, so you can jump straight to the page you need instead '
    + 'of walking every page. Each entry holds the page number, its card ids, and the opening ~24 chars of '
    + 'each prompt (plus status when it is not draft). Read this first, pick the page, then fetch it. '
    + `Capped at ${WORKBENCH_STATUS_MAX_INDEX_ENTRIES} entries — beyond that, page numbers still work.`,
  ),
  page: z.number().describe('1-based page number of `cards`.'),
  pageSize: z.number(),
  totalPages: z.number(),
  hasMore: z.boolean().describe('More cards exist beyond this page; fetch them with page:N+1.'),
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
  // 枚举与区间都取**全模型并集**，逐模型收窄交给 validateSeedanceRequest。
  // 漏掉 '2.5' 不只是「设不了 2.5」：export 一块含 2.5 卡片的板子再 apply，
  // 会被 zod 当场拒掉 —— 往返路径整条断，而卡片本身完全合法。
  model: z.enum(['2.0', '2.0-fast', '2.0-mini', '2.5']).optional(),
  resolution: z.enum(['480p', '720p', '1080p']).optional(),
  ratio: z.enum(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']).optional(),
  duration: z.union([z.literal(-1), z.number().int().min(4).max(30)]).optional(),
  generateAudio: z.boolean().optional(),
  mode: z.enum([
    'text2video', 'first_frame', 'first_last_frame', 'reference_images',
    'multimodal_ref', 'edit_video', 'extend_video',
  ]).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  webSearch: z.boolean().optional(),
  // 上限取全模型最宽（2.5 的 30/10/10）；按模型收窄由渲染端 canStart 与主进程
  // validateSeedanceRequest 负责 —— schema 写死 9/3/3 会让 2.5 的卡片直接被拒。
  referenceImages: z.array(irMaterialSchema).max(30).optional(),
  referenceVideos: z.array(irMaterialSchema).max(10).optional(),
  referenceAudios: z.array(irMaterialSchema).max(10).optional(),
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
    current: z.object({
      prompt: z.string(),
      model: z.string(),
      resolution: z.string(),
      ratio: z.string(),
      duration: z.number(),
      rev: z.number(),
    }).optional().describe(
      "Present when the skip was a per-card version conflict: this is the card AS IT IS NOW, so you do "
      + 'NOT need another export just to see what the user changed. Decide from it — if only duration/model '
      + 'moved, rewrite your version against the new value and send again; if the prompt itself was '
      + 'replaced, ask the user rather than overwriting what they just wrote. To overwrite deliberately, '
      + "copy `current.rev` into that card's `rev` and re-apply.",
    ),
  })).describe(
    'Per-item rejections (a card the user edited meanwhile, rendering cards whose spec is frozen, unknown '
    + 'ids, unresolvable wbref, …). Everything not listed here was applied. A per-card conflict is NOT a '
    + 'failure of the whole call — the other cards landed.',
  ),
  structureRevision: z.number().describe('New structure token; carry it into the next apply.'),
})

// ---------------------------------------------------------------------------
// 渐进式披露的三个数
//
// codex 把**每次工具调用**的输出截到 10_000 token,而且是**静默**截断(只插一句
// `…N tokens truncated…`),模型可能拿着半截数据照样行动。那个上限是我们自己在
// codexLaunch 用 `-c tool_output_token_limit=10000` 钉死的,不能靠调大它绕过 ——
// 钉死的理由是防止用户级 config.toml 把它放大到 64K 撑爆网关字节上限。
//
// 所以工具这一侧必须自己守住体积。仓库里已有的家规见
// `docs/2026-06-12-mcp-stdio-bridge-pitfalls.md`「工具返回列表？→ 必须分页 +
// hasMore」,参考实现是 `portraitTools.ts` 的 list_portrait_library。
// ---------------------------------------------------------------------------

/**
 * 单次工具结果的字符预算。
 *
 * 10_000 token 换算成字符要看内容:纯 ASCII 约 4 字符/token,但 id / 路径 / URL
 * 接近 3,中文提示词接近 1.3。按最坏情况取 2.5 折算约 25_000,再留一点给 banner
 * 与结构开销。**宁可紧一点** —— 超了是静默丢数据,紧了只是多一次调用。
 */
const RESULT_CHAR_BUDGET = 20_000

type WorkbenchToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * 成功:structuredContent 为权威结构化结果,text 同时带 banner + JSON 兜底。
 *
 * **这份重复序列化是规范要求的,不要为了省体积删掉。** MCP SEP-2106 的向后兼容
 * 矩阵要求声明了 outputSchema 的服务端同时给一个序列化 JSON 的 TextContent 块,
 * 官方 tools.mdx 的示例也是这个形状 —— 不确定 codex 客户端读不读 structuredContent
 * 的前提下删掉它,就是七个工具集体只剩一行 banner。省体积的正确做法是**把数据本身
 * 变小**(分页 / 收窄默认范围 / 输入上限),那样两份副本一起变小。
 */
function okResult(bannerLines: string[], structured: unknown): WorkbenchToolResult {
  return {
    content: [{ type: 'text', text: [...bannerLines, JSON.stringify(structured)].join('\n') }],
    structuredContent: structured as Record<string, unknown>,
  }
}

/**
 * 结果超预算时**响亮地失败**,而不是交给 codex 静默截断。
 *
 * 对 `export` 尤其要命:`apply` 是声明式不是 patch(省略字段 = 恢复默认),所以
 * agent 拿到一份被截断的 IR 再回写,被截掉的卡片字段会被清成默认值 —— 那是数据
 * 丢失,不是性能问题。报错至少让 agent 知道要缩小范围。
 */
function guardResultSize(tool: string, structured: unknown, howToNarrow: string): WorkbenchToolResult | null {
  const chars = JSON.stringify(structured)?.length ?? 0
  if (chars <= RESULT_CHAR_BUDGET) return null
  return {
    content: [{
      type: 'text',
      text:
        `❌ ${tool} failed: result is ~${chars} characters, over this tool's ${RESULT_CHAR_BUDGET} budget. `
        + 'Returning it would let the client silently truncate mid-JSON, and acting on half a payload is '
        + `worse than not getting one. ${howToNarrow}`,
    }],
    isError: true,
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
      'Batch output surface of the catimation-video skill — load that skill first, grade the request ' +
      '(快速/标准/专业/制片) and write the prompt with the same discipline as generate_video. ' +
      `${PROMPT_BASE_DIRECTIVE} ${MATERIAL_ROLE_DIRECTIVE} ` +
      'Per card the material caps are identical too: referenceImages ≤9, referenceVideos ≤3 and ' +
      'referenceAudios ≤3, each type ≤15s in total — model "2.5" raises all three to 30/10/10 with ' +
      '≤30s in total. ' +
      'Add one or more video task cards to the 「生成视频」 workbench page (the scroll-style concurrent ' +
      'video workbench the user sees). Cards land on the currently ACTIVE board (the workbench has ' +
      'multiple boards/pages — see video_workbench_status). Each card carries a prompt + Seedance spec ' +
      '(model/resolution/ratio/duration) + reference materials. By default this only FILLS the cards ' +
      '(user reviews and clicks generate); pass autoStart:true to start rendering immediately. The app ' +
      'auto-navigates to the workbench tab so the user watches the cards appear. The result includes a ' +
      'compact `workbench` overview (boards + global status counts) so you always see the whole ' +
      'workbench after writing. Use this when the user asks to 排卡片/批量准备视频任务/在生成视频页帮我' +
      '填好任务; for a single quick video in chat, prefer generate_video.\n' +
      `WRITE IN SMALL BATCHES — at most ${WORKBENCH_MAX_TASKS_PER_CALL} cards per call. For more, call this ` +
      'repeatedly (the cards append in order, so ten cards = two calls). This is deliberate: one giant ' +
      'call is minutes of silent JSON generation during which the user cannot interrupt you and sees ' +
      'nothing appear, whereas each small call makes its cards show up on the page immediately. ' +
      'With autoStart:true the earlier batch starts rendering while you write the next one. ' +
      'WHEN A CARD CARRIES REFERENCE IMAGES, view_image ONE of them BEFORE writing that card\'s prompt — ' +
      'the render follows the picture, so a prompt written from a filename argues with it. Viewing an ' +
      'INPUT is not the batch-opening of generated OUTPUTS that other tools warn against.',
    inputSchema: z.object({
      tasks: z.array(cardInputSchema).min(1).max(WORKBENCH_MAX_TASKS_PER_CALL).describe(
        `Cards to append, top-to-bottom order (1–${WORKBENCH_MAX_TASKS_PER_CALL} per call — `
        + 'call again for more rather than trying to fit everything in one request).',
      ),
      autoStart: z.boolean().optional().describe('Start rendering right after adding. Default false (fill only).'),
      navigate: z.boolean().optional().describe('Switch the app to the workbench tab. Default true.'),
      afterCardId: z.string().optional().describe(
        'Insert the new cards right AFTER this card instead of appending. Pass a stable card id from '
        + 'video_workbench_status — NOT a position number, those shift whenever anything is inserted, '
        + 'deleted or dragged. The cards land on the ANCHOR card\'s board, which may differ from the '
        + 'active one. Mutually exclusive with beforeCardId; omit both to append at the end of the '
        + 'active board. Note this changes the card set, so any structureRevision you are holding for '
        + 'video_workbench_apply becomes stale.',
      ),
      beforeCardId: z.string().optional().describe(
        'Insert right BEFORE this card. Mutually exclusive with afterCardId. Same rules as afterCardId.',
      ),
    }).refine(
      (v) => !(v.afterCardId && v.beforeCardId),
      { message: 'afterCardId and beforeCardId are mutually exclusive' },
    ),
    // 不是纯增：卡片总数超过 WORKBENCH_MAX_CARDS 时 store 会 evict() 淘汰最旧的终态卡
    // （store.ts 的 addCards 分支）。也就是说「加几张卡」在满板时会删掉别的卡 ——
    // 那是用户数据，标 additive 是错的。
    annotations: DESTRUCTIVE,
    outputSchema: addTasksOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_add_tasks', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return okResult([
        '✅ video_workbench_add_tasks — cards added to the workbench page (visible to the user).',
        (params as { autoStart?: boolean }).autoStart
          ? 'Rendering started — this returned IMMEDIATELY and a normal render takes 1–3 minutes. Do NOT poll and do NOT wait: a 「[视频工作台] 批次渲染完成」 summary is pushed to you automatically once every card settles. Results play inline on the workbench page and are saved locally + to COS automatically. Answer the user now and stay available.'
          : 'Cards are FILLED but not started. Ask the user to review, or call video_workbench_start to begin rendering.',
      ], result)
    } catch (error) {
      return errorResult('video_workbench_add_tasks', error)
    }
  })

  server.registerTool('video_workbench_set_spec', {
    description:
      'Apply the SAME spec change to many cards at once — resolution, ratio, model, duration, audio, '
      + 'webSearch, mode. This is the tool for "把整板都改成 480p / 都开联网 / 都换 2.5".\n'
      + 'USE THIS INSTEAD OF export+apply for spec-only sweeps. apply is declarative over the WHOLE board: '
      + 'omitted fields reset to defaults, so to change three fields you must round-trip every prompt and '
      + 'every material array of every card through the model — on a 17-card board that is the slowest '
      + 'thing in the session, and the user is just sitting there watching RUNNING. This tool carries only '
      + 'the fields you name.\n'
      + 'It CANNOT touch prompts or materials — that is the point, not a limitation. For those, use '
      + 'video_workbench_update_task (one card) or video_workbench_apply (restructuring).\n'
      + 'Omit cardIds to hit every card on the active board. Cards that are rendering are skipped and '
      + 'reported, not errored — a sweep should not fail because one card happens to be busy.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).optional().describe(
        'Cards to change. Omit = every card on the ACTIVE board (the common case for a sweep). '
        + 'Pass ids from `pageIndex` / status when you only want some of them.',
      ),
      boardId: z.string().optional().describe('Sweep this page instead of the active one. Ignored when cardIds is given.'),
      model: cardInputSchema.shape.model,
      resolution: cardInputSchema.shape.resolution,
      ratio: cardInputSchema.shape.ratio,
      duration: cardInputSchema.shape.duration,
      generateAudio: cardInputSchema.shape.generateAudio,
      webSearch: cardInputSchema.shape.webSearch,
      mode: cardInputSchema.shape.mode,
    }),
    // 与 update_task 同档:换模型/模式时按新上限截断素材(2.5 → 2.0 会掉 21 张),
    // 而这里是**批量**截断,一次能影响整板 —— 更该让客户端问一声。
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
    outputSchema: z.looseObject({
      updated: z.array(z.string()).describe('Card ids actually changed.'),
      skipped: z.array(z.object({ cardId: z.string(), reason: z.string() })).describe(
        'Cards left untouched (rendering, or the patch was a no-op for them).',
      ),
      workbench: workbenchSummarySchema,
    }),
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call(
        'video_workbench_set_spec',
        params as Record<string, unknown>,
        extractCodexThreadId(ctx),
      ) as { updated: string[]; skipped: Array<{ reason: string }> }
      return okResult([
        `✅ video_workbench_set_spec — ${result.updated.length} card(s) updated.`,
        ...(result.skipped.length > 0
          ? [`⚠️ ${result.skipped.length} skipped — read \`skipped\` and tell the user which ones and why.`]
          : []),
      ], result)
    } catch (error) {
      return errorResult('video_workbench_set_spec', error)
    }
  })

  server.registerTool('video_workbench_update_task', {
    description:
      'Update ONE existing card on the 「生成视频」 workbench page: prompt, spec (model/resolution/ratio/' +
      'duration/generateAudio) and/or reference materials. Cards that are currently rendering cannot be ' +
      'edited. Get cardIds from video_workbench_add_tasks or video_workbench_status. Returns the updated ' +
      'card snapshot plus a compact `workbench` overview (boards + global status counts). ' +
      'If you are attaching or replacing reference images here, view_image one of them before rewriting ' +
      'the prompt — same reason as on add_tasks: the render follows the picture, not the filename. ' +
      'THIS IS THE TOOL FOR CHANGING ONE CARD — reach for it whenever you are rewriting a single ' +
      "prompt, swapping that card's references, or adjusting its duration/model. It targets the card " +
      'by id, carries no board-wide version token, and cannot be invalidated by the user typing in ' +
      'another card. Do NOT export the whole board and re-apply it just to edit one card: that is far ' +
      'slower and any edit the user makes meanwhile can push your write aside. Reserve ' +
      'video_workbench_apply for RESTRUCTURING (adding/deleting/reordering cards or pages). And if you ' +
      'only want the same spec across many cards ("整板 480p / 都开联网"), use video_workbench_set_spec ' +
      '— NOT apply. Call it once per card — one focused call per card beats one giant IR. ' +
      'Material caps per card: referenceImages ≤9, referenceVideos ≤3 and referenceAudios ≤3, each ' +
      'type ≤15s in total — model "2.5" raises all three to 30/10/10 with ≤30s in total. ' +
      `${PROMPT_BASE_DIRECTIVE} ${MATERIAL_ROLE_DIRECTIVE}`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe('Target card id.'),
    }).merge(cardInputSchema),
    // 幂等（同参数重复调结果一致），但**会删素材**：切模型 / 切模式时 updateCard 按新
    // 上限截断超限的参考图与音视频（store.ts 的 modeLimit 截断），2.5 降回 2.0 就会掉 21 张。
    // 那是用户拖进去的东西，所以标破坏性而不是 additive。
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
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
      'Batch output surface of the catimation-video skill (load it for grading and prompt discipline). ' +
      'Start rendering workbench cards (concurrent). Omit cardIds to start EVERY startable card on the ' +
      'ACTIVE board (draft/failed/succeeded with a non-empty prompt); pass cardIds to start specific ones ' +
      '(any board). Renders run 1–3 minutes each, concurrently. Returns IMMEDIATELY (fire-and-forget) ' +
      'with started/skipped plus a compact `workbench` overview — it does NOT wait for the renders. ' +
      'Do NOT poll video_workbench_status afterwards: when every card in the batch settles you are ' +
      'pushed a 「[视频工作台] 批次渲染完成」 summary listing successes, failures and output paths. ' +
      'The user watches live progress on the workbench page meanwhile.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).optional().describe('Cards to start. Omit = all startable cards on the active board.'),
    }),
    annotations: WRITE_ADDITIVE_REMOTE,
    outputSchema: startOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_start', params as Record<string, unknown>, extractCodexThreadId(ctx)) as {
        started: string[]
        skipped: Array<{ cardId: string; reason: string }>
      }
      return okResult([
        result.started.length > 0
          ? `⏳ video_workbench_start — ${result.started.length} render(s) submitted and this call already returned. Do NOT poll, do NOT wait, do NOT resubmit: you will be pushed a 「[视频工作台] 批次渲染完成」 summary when the batch settles. Reply to the user now.`
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
      'saved localPath / permanent remoteUrl for finished videos. Use it to inspect what the user has ' +
      'set up before editing cards, or when the user explicitly asks how a render is going — NOT as a ' +
      'polling loop after video_workbench_start (batch completion is pushed to you automatically).\n' +
      'SCOPED TO THE ACTIVE BOARD BY DEFAULT. A workbench can hold a dozen pages; the user is looking at ' +
      'one of them, and that is the one you get. Reach wider only when the task actually needs it: pass ' +
      '`boardId` for a specific page, or `allBoards:true` for everything. The `boards` list always carries ' +
      "every page's id/name/cardCount, so you can see what else exists without pulling its cards. The " +
      'result echoes `scope` so you always know what you just looked at.\n' +
      `Cards come back a few at a time — ${WORKBENCH_STATUS_PAGE_SIZE} per page by default — because a `
      + 'full card is bulky and you usually care about one or two of them.\n'
      + 'READ `pageIndex` FIRST. It has one line per page across the whole scope (page number, card ids, '
      + 'the opening words of each prompt), so you can jump straight to the page you want instead of '
      + 'walking pages 1..N. Then fetch that page, or skip paging entirely by passing its cardIds.\n'
      + 'Do NOT raise pageSize just to avoid paging: paging is already cheap thanks to pageIndex, while '
      + 'cards you pull sit in your context for the rest of the session, and oversized results get '
      + 'silently truncated by the client. `total` counts every match in scope; hasMore/page/totalPages '
      + 'describe the slice you got.',
    inputSchema: z.object({
      cardIds: z.array(z.string()).optional().describe(
        'Limit to specific cards, ACROSS pages (an explicit id list means "just these", so it is not '
        + 'narrowed to the active board). Omit to list the scoped board.',
      ),
      boardId: z.string().optional().describe('Inspect one specific page. Omit = the ACTIVE page only.'),
      allBoards: z.boolean().optional().describe(
        'Set true to pull cards from EVERY page. Default false — the active page only. Use it when the '
        + 'task genuinely spans pages (a whole-film overview), not as a default reflex.',
      ),
      page: z.number().int().min(1).optional().describe('1-based page number (default 1).'),
      pageSize: z.number().int().min(1).max(WORKBENCH_STATUS_MAX_PAGE_SIZE).optional().describe(
        `Cards per page (default ${WORKBENCH_STATUS_PAGE_SIZE}, max ${WORKBENCH_STATUS_MAX_PAGE_SIZE}).`,
      ),
    }),
    annotations: READ_ONLY,
    outputSchema: statusOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_status', params as Record<string, unknown>, extractCodexThreadId(ctx)) as {
        cards: Array<{ status: string }>
        page: number
        totalPages: number
        hasMore: boolean
        total: number
      }
      const active = result.cards.filter((c) => c.status === 'preparing' || c.status === 'queued' || c.status === 'running').length
      const banner = active > 0
        ? `⏳ ${active} card(s) still rendering on this page. Report this to the user and move on — do NOT call this again in a loop; the batch-completion summary is pushed to you automatically. The user sees live progress on the page.`
        : '✅ No card on this page is rendering. Finished videos are playing on the workbench page and saved locally (localPath) + to COS (remoteUrl).'
      // 分页提示只在还有下一页时出现 —— 单页就装下的常见情况不该多占一行上下文。
      const paging = result.hasMore
        ? [`📄 Page ${result.page}/${result.totalPages} — ${result.cards.length} of ${result.total} cards shown. Use \`pageIndex\` to pick the page you actually need (or pass its cardIds); page:${result.page + 1} is just the next one, not necessarily the right one.`]
        : []
      return okResult([banner, ...paging], result)
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
      + 'one onto another card to reuse that material without re-uploading.\n'
      + 'SCOPE: by default this exports only the ACTIVE board, because a full export carries every card\'s '
      + 'full prompt and every material path and can exceed what the client will accept. That default is '
      + 'safe to apply back — merge mode leaves boards you did not list alone. Pass a specific boardId for '
      + 'another board, or allBoards:true only when the change genuinely spans boards (moving cards '
      + 'between pages, reordering the tabs).',
    inputSchema: z.object({
      boardId: z.string().optional().describe(
        'Export this board instead of the active one. Safe to apply back with the default merge mode: '
        + 'boards you did not list are left alone.',
      ),
      allBoards: z.boolean().optional().describe(
        'Export every board. Only needed for cross-board changes; the payload grows with the whole '
        + 'workbench and may be rejected as too large. Ignored when boardId is given.',
      ),
    }),
    annotations: READ_ONLY,
    outputSchema: irSchema,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call('video_workbench_export', params as Record<string, unknown>, extractCodexThreadId(ctx))
      const tooBig = guardResultSize(
        'video_workbench_export',
        result,
        'Export one board at a time (boardId), and drop allBoards. If a SINGLE board is still too large, '
        + 'it has too many cards to round-trip — edit those cards individually with '
        + 'video_workbench_update_task, or ask the user to split the board in two.',
      )
      if (tooBig) return tooBig
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
      'RESTRUCTURE the board: add / delete / reorder cards and pages in one shot, from an IR you got '
      + 'via video_workbench_export.\n'
      + 'CHECK THESE FIRST — reaching for this tool when one of them fits is the single most expensive '
      + 'mistake you can make here:\n'
      + '• Same spec across many cards ("整板 480p", "都开联网", "全部改 2.5") → '
      + 'video_workbench_set_spec. It patches only the fields you name, so a 17-card sweep is one small '
      + 'call. Doing it through this tool instead forces you to echo back every card\'s full prompt and '
      + 'material arrays (see DECLARATIVE below) — minutes of generation for a three-field change.\n'
      + '• One card (its prompt, references, duration) → video_workbench_update_task. Targets the card '
      + 'by id, needs no board token, and the user typing elsewhere cannot push it aside.\n'
      + '• Several cards, each needing DIFFERENT prompts → call update_task once per card. One focused '
      + 'call per card still beats one giant IR: it starts landing immediately, and a conflict on card 7 '
      + 'does not cost you cards 1-6.\n'
      + 'What is left for this tool: changing the SET or ORDER of cards/pages. That is the only thing '
      + 'the others cannot do.\n'
      + 'Rules that matter:\n'
      + '• DECLARATIVE, NOT A PATCH — a card omitting `resolution` gets the DEFAULT resolution, not its '
      + 'old one. Always start from a fresh export and keep the fields you are not changing.\n'
      + '• `id` present = edit that existing card/board; `id` omitted = create a new one; unknown id = error.\n'
      + '• Material caps per card: referenceImages ≤9, referenceVideos ≤3 and referenceAudios ≤3, each '
      + 'type ≤15s in total — model "2.5" raises all three to 30/10/10 with ≤30s in total.\n'
      + `• ${PROMPT_BASE_DIRECTIVE}\n`
      + `• ${MATERIAL_ROLE_DIRECTIVE}\n`
      + '• Array order is the order: reordering cards means reordering the array (there is no order field).\n'
      + '• POSITION-ONLY entries: a card with ONLY `id` (plus optional `rev`) keeps its content exactly '
      + 'as it is and just takes that slot. Use them for every card you are NOT editing.\n'
      + '• LISTED CARDS GO FIRST, OMITTED ONES GET APPENDED AFTER THEM. This bites silently: send 4 of '
      + '17 cards and those 4 jump to the head of the page. Never "batch" by sending a subset — send the '
      + 'whole page every time, the ones you edit with content and the rest as position-only `{id}`. '
      + 'Only content-bearing cards count against the per-call limit, so listing all 17 is free.\n'
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
    annotations: DESTRUCTIVE,
    outputSchema: applyOutputSchema,
  }, async (params, ctx?: unknown) => {
    try {
      // 入参也要守 —— 一份超预算的 IR 说明它来自一份**已经被截断**的 export,
      // 而 apply 是声明式的:照写下去等于把截掉的字段清成默认值。
      //
      // 这里刻意**不按卡片张数**设上限:IR 的数组顺序就是页内顺序,合并模式下没列出
      // 的卡会被追加到列出的卡后面(workbenchIR 的 placeExisting),所以限制张数会让
      // 「重排一个二十张卡的页」变成不可能 —— 只列前五张就把它们顶到最前、其余全部
      // 挤下去。按体积卡不会误伤那种正当用法。
      // 内容卡硬闸。数的是**携带内容的卡**,不是卡片总数 —— 只给 id 的占位条目
      // 不计入,所以「重排二十张卡」照样一次做完(按总数拦会把没列出的卡挤下去,
      // 见下面那段注释)。这里拦的是另一件事:一次回写十七段完整提示词。
      const irCards = ((params as { ir?: { boards?: Array<{ cards?: unknown[] }> } }).ir?.boards ?? [])
        .flatMap((b) => (Array.isArray(b?.cards) ? b.cards : []))
      const contentCards = irCards.filter((c) => {
        if (!c || typeof c !== 'object') return false
        const keys = Object.keys(c as Record<string, unknown>)
        // id / rev 是身份与令牌,不算内容。其余任何一个字段都算。
        return keys.some((k) => k !== 'id' && k !== 'rev')
      })
      if (contentCards.length > WORKBENCH_APPLY_MAX_CONTENT_CARDS) {
        return errorResult(
          'video_workbench_apply',
          new Error(
            `this IR carries content for ${contentCards.length} cards, over the limit of `
            + `${WORKBENCH_APPLY_MAX_CONTENT_CARDS}. Nothing was written. Rewriting many cards through `
            + 'apply is the slowest path in the session: apply is declarative, so every card must carry '
            + 'its full prompt and material arrays back through the model.\n'
            + 'Pick the tool that matches what you are actually doing:\n'
            + '• Same spec across many cards (480p / webSearch / model) → video_workbench_set_spec, one call.\n'
            + '• Different prompts per card → video_workbench_update_task, once per card. Best default: '
            + 'it never touches order, each call lands immediately, and a conflict on card 7 does not '
            + 'cost you cards 1-6.\n'
            + '• Pure reordering → keep using apply, but send POSITION-ONLY entries: a card object with '
            + 'ONLY `id` (plus optional `rev`) keeps its content untouched and just takes that slot. '
            + 'Those do not count against this limit, so a 20-card reorder is still one call.\n'
            + 'IF YOU BATCH THROUGH apply, LIST THE WHOLE PAGE EVERY TIME. Cards you list are placed in '
            + 'array order and cards you omit are appended AFTER them — so a batch of 4 silently jumps '
            + 'those 4 to the front and scrambles the page. Send all N cards: the few you are editing '
            + 'with content, every other one as a position-only `{id}`. Order stays correct, and only '
            + 'the edited ones count against the limit. Omitting the rest and "fixing the order later" '
            + 'costs you a second full-board write — the exact thing this limit exists to prevent.',
          ),
        )
      }

      const irChars = JSON.stringify((params as { ir?: unknown }).ir)?.length ?? 0
      if (irChars > RESULT_CHAR_BUDGET) {
        return errorResult(
          'video_workbench_apply',
          new Error(
            `the IR is ~${irChars} characters, over the ${RESULT_CHAR_BUDGET} budget. An IR this large `
            + 'almost certainly came from an export that the client truncated, and apply is declarative — '
            + 'writing a truncated IR back would reset the missing fields to defaults. Re-export ONE board '
            + '(boardId, no allBoards) and apply that; merge mode leaves the other boards alone.',
          ),
        )
      }
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

  server.registerTool('video_workbench_set_board_summary', {
    description:
      'Leave a one-line note on a workbench page saying what it holds ("追车戏 8 镜，全部夜景"). '
      + 'Cheap to write, and it is what makes progressive reading work: video_workbench_status returns '
      + "only the ACTIVE page's cards, so every other page shows up as just id/name/cardCount — and page "
      + 'names are usually "页面 3". A summary lets you (or the next session) pick the right page WITHOUT '
      + 'pulling its cards.\n'
      + 'Write one whenever you finish laying out a page, and refresh it when the page\'s content changes '
      + 'shape. Pass an empty string to clear it.\n'
      + `FORMAT — telegraphic, not prose. Hard limit ${WORKBENCH_BOARD_SUMMARY_MAX} characters; over that the `
      + 'call is REJECTED (not truncated), so compress rather than trail off. Use " · " between 2-4 facts, '
      + 'no verbs, no sentence, no trailing period: "追车 · 夜外 · 主角车vs追兵" / '
      + '"Hospital line · interior day · Mia + doctor". Say what the page CONTAINS; never counts or status '
      + '("8 cards, 3 done") — those are already in the boards list and go stale the moment a card changes.\n'
      + 'Why so short: this rides along with the boards list on EVERY workbench call, so ten pages means ten '
      + 'of these every time. A summary that costs more context than the cards it saves you from reading '
      + 'defeats its own purpose.\n'
      + 'This does NOT invalidate an IR you are holding: a summary is a signpost, not a spec change.',
    inputSchema: z.object({
      boardId: z.string().min(1).describe('Page to annotate. Get ids from the `boards` list.'),
      summary: z.string().max(WORKBENCH_BOARD_SUMMARY_MAX).describe(
        `Telegraphic index entry, max ${WORKBENCH_BOARD_SUMMARY_MAX} chars: 2-4 facts joined by " · ", `
        + 'no verbs, no period ("追车 · 夜外 · 主角车vs追兵"). Empty string clears it. Over the limit is '
        + 'rejected, not trimmed — compress instead of writing a sentence and letting it get cut.',
      ),
    }),
    outputSchema: z.looseObject({
      ok: z.boolean(),
      workbench: workbenchSummarySchema,
    }),
    annotations: WRITE_IDEMPOTENT,
  }, async (params, ctx?: unknown) => {
    try {
      const result = await router.call(
        'video_workbench_set_board_summary',
        params as Record<string, unknown>,
        extractCodexThreadId(ctx),
      ) as { ok: boolean }
      return okResult(
        [result.ok
          ? '✅ video_workbench_set_board_summary — saved.'
          : '⚠️ video_workbench_set_board_summary — board not found; check the `boards` list for valid ids.'],
        result,
      )
    } catch (error) {
      return errorResult('video_workbench_set_board_summary', error)
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
    annotations: DESTRUCTIVE,
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
