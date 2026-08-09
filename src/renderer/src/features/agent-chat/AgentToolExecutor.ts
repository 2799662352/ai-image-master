import type { GenerateImageParams, GenerateResult, UnderstandInput } from '../../services/api'
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import type { HistoryDataService } from '../history'
import type { ImageViewer } from '../image-viewer'
import { isTabName, useTabStore } from '../../stores/useTabStore'
import { useFileExplorerStore } from '../file-explorer/store'
import { useAgentChatStore } from './store'
import {
  DEFAULT_IMAGE_CHANNEL_ID,
  isMiauOnlyChannel,
  isSelectableImageChannel,
  resolveImageChannel,
} from './imageChannels'
import { recordCodexArtifact } from './codexArtifactPersistence'
import { buildLightArtifacts } from './buildLightArtifacts'
import type { ArtifactSaveInfo, AttachmentRef, ChoiceAnswer, ChoiceOption } from '../../../../types/agent-timeline'
import type { AgentToolRequest, AgentToolResponse, ImageTaskUpdate } from '../../../../types/agent'
import type { AgentApiBridge } from '../../../../types/agentApi'
import { getAgentApi } from '../../utils/agentBridge'
import { canvasBridge } from '../agent-workspace/canvas/canvasBridge'
import { directorBridge } from '../../components/shared/image-editors/director/directorBridge'
import { resolveMediaSrcOnce } from '../../components/shared/media/useResolvedMediaSrc'
import { wantsInlineBase64ForModel } from '../../utils/refImageStrategy'
import { generateAudioToLibrary, type AudioGenerationApi } from '../audio/audioGeneration'
import { getAudioLibraryStore } from '../audio/AudioLibraryStore'
import { snapshotCard, snapshotWorkbench, useVideoWorkbenchStore } from '../video-workbench/store'
import { enrichAssetReferences } from '../video-workbench/assetPreview'
import { registerAgentBatch } from '../video-workbench/batchCompletion'
import type { VideoWorkbenchCardInput, WorkbenchIR } from '../../../../types/videoWorkbench'
import {
  WORKBENCH_STATUS_MAX_INDEX_ENTRIES,
  WORKBENCH_STATUS_MAX_PAGE_SIZE,
  WORKBENCH_STATUS_PAGE_SIZE,
} from '../../../../types/videoWorkbench'

type GenerateAudioToolParams = {
  input?: unknown
  format?: unknown
  speed?: unknown
  referenceAudios?: unknown
}

type GenerateImageToolParams = GenerateImageParams

type GenerateImagesToolParams = {
  prompts?: unknown
  model?: unknown
  ratio?: unknown
  resolution?: unknown
  quality?: unknown
  referenceImages?: unknown
}

/** Combined batch result shipped to main; shape matches imageTools' BatchTaskResult. */
interface ImageBatchResult {
  successes: unknown[]
  failures: Array<{ index: number; error: string }>
  savedPaths: string[]
}

const CODEX_DEFAULT_RESOLUTION = '2K'

/**
 * Site key (Miau API) that proxies the Miau-only channels. The renderer's
 * ApiService rewrites a model's endpoint host with the *currently selected*
 * site's host, so these channels only reach the gateway when this site is
 * active. We pin it per-request via `siteKey` (see generateImage) so codex
 * image generation works regardless of which site the user has selected — no
 * manual "switch to Miau API site" step required.
 */
const MIAU_SITE_KEY = 'antigravity'

/**
 * Resolve the channel a `generate_image` call renders on. Precedence:
 *
 *   1. The agent's explicit, valid `model` argument — AGENT AUTONOMY. The agent
 *      may deliberately override the channel when it has a concrete reason (e.g.
 *      switch to 万相 2.7 pro for a `count>1` 组图 series, or honor a user who
 *      asked for a specific channel mid-turn).
 *   2. The user's picker selection (`store.selectedImageChannel`) — the DEFAULT
 *      the picker sets. Used whenever the agent omits `model`.
 *   3. VIP — the hard fallback when both are absent/stale.
 *
 * So the composer picker sets the user's default AND serves as a reminder to the
 * agent, without stripping the agent's ability to pick a better channel for the
 * task. Channel metadata (allow-list + Miau-only flag) lives in
 * `imageChannels.ts`, so adding/renaming a channel flows to both the picker UI
 * and this resolver.
 */
function resolveEffectiveImageChannel(agentRequested: unknown): string {
  if (isSelectableImageChannel(agentRequested)) return agentRequested
  return resolveImageChannel(useAgentChatStore.getState().selectedImageChannel)
}

type AgentElectronApi = {
  attachments?: {
    save: (args: {
      threadId: string
      name: string
      mime: string
      base64: string
    }) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    saveFromUrl?: (args: {
      threadId: string
      name: string
      url: string
    }) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    readThumb: (
      p: string,
    ) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }>
    /**
     * Stream a local reference image to COS and get a submittable URL back.
     * Optional so older preloads (and tests that stub only `readThumb`)
     * degrade to the inline path instead of throwing.
     */
    resolveRefImage?: (
      p: string,
    ) => Promise<{ ok: true; url: string } | { ok: false; reason: string }>
  }
}

type OpenImageViewerToolParams = {
  urls?: unknown
  startIndex?: unknown
}

type NavigatePageToolParams = {
  tab?: unknown
}

type AskUserToolParams = {
  question?: unknown
  options?: unknown
  mode?: unknown
  allowFreeText?: unknown
  allowSkip?: unknown
}

function createChoiceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

type QueryHistoryToolParams = {
  query?: unknown
  limit?: unknown
}

const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 100

/**
 * Time budget for POST-generation persistence (history record + file-panel
 * save). Generation success is decided by the render alone — once the image
 * exists and is on screen, the tool call IS successful. Persistence normally
 * finishes in well under a second; this budget only matters when the local DB
 * wedges (e.g. Prisma P1017 against PGlite), which previously made the tool
 * response hang forever even though the user was already looking at the
 * image. On timeout we return success WITHOUT paths and let persistence keep
 * running in the background.
 */
const PERSISTENCE_BUDGET_MS = 10_000
/** Keep large batches parallel without opening an unbounded number of multi-minute HTTP uploads. */
const CODEX_IMAGE_BATCH_CONCURRENCY = 3

async function settleWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let nextIndex = 0

  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return results
}

export class AgentToolExecutor {
  start(): () => void {
    const agent = this.getAgentApi()
    if (!agent.onToolRequest) throw new Error('Electron agent API is unavailable')
    return agent.onToolRequest((request) => {
      void this.handle(request)
    })
  }

  private async handle(request: AgentToolRequest): Promise<void> {
    // Image tools are TRULY async: ack the kick immediately (so main's
    // `router.call` returns in ms instead of holding the IPC open for the whole
    // multi-minute render), run the render in the background, and broadcast ONE
    // terminal `image:task-update` when it settles. The renderer's own chat
    // bubble already shows progress to the user, so nothing about UX changes —
    // only the main↔renderer contract becomes non-blocking.
    if (request.toolName === 'generate_image' || request.toolName === 'generate_images') {
      const taskId = typeof request.params.__taskId === 'string' ? request.params.__taskId : ''
      this.getAgentApi().sendToolResponse?.({ id: request.id, ok: true, result: { accepted: true, taskId } })
      void this.runImageTaskInBackground(request, taskId)
      return
    }

    const response = await this.execute(request)
    this.getAgentApi().sendToolResponse?.(response)
  }

  /**
   * Run an image task in the background and broadcast its terminal status to
   * main. Never throws (the broadcast carries success/failure) — a stray throw
   * here would leave main's task waiting until its budget/poll expires.
   */
  private async runImageTaskInBackground(request: AgentToolRequest, taskId: string): Promise<void> {
    const kind: ImageTaskUpdate['kind'] = request.toolName === 'generate_images' ? 'batch' : 'single'
    try {
      const result =
        kind === 'batch'
          ? await this.generateImages(request.params as GenerateImagesToolParams, request.threadId)
          : await this.generateImage(request.params as unknown as GenerateImageToolParams, request.threadId)
      this.broadcastImageTask({ taskId, kind, status: 'succeeded', result })
    } catch (error) {
      this.broadcastImageTask({
        taskId,
        kind,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private broadcastImageTask(update: ImageTaskUpdate): void {
    if (!update.taskId) return
    try {
      this.getAgentApi().sendImageTaskUpdate?.(update)
    } catch (error) {
      console.error('[AgentToolExecutor] failed to broadcast image task update:', error)
    }
  }

  private async execute(request: AgentToolRequest): Promise<AgentToolResponse> {
    try {
      const result = await this.call(request.toolName, request.params, request.threadId)
      return { id: request.id, ok: true, result }
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async call(toolName: string, params: Record<string, unknown>, threadId?: string): Promise<unknown> {
    switch (toolName) {
      // generate_image / generate_images are handled out-of-band in `handle()`
      // (ack + background + broadcast), so they never reach this synchronous
      // dispatch path.
      case 'query_history':
        return this.queryHistory(params as QueryHistoryToolParams)
      case 'open_image_viewer':
        return this.openImageViewer(params as OpenImageViewerToolParams)
      case 'navigate_page':
        return this.navigatePage(params as NavigatePageToolParams)
      case 'ask_user':
        return this.askUser(params as AskUserToolParams, threadId)
      case 'canvas_open':
      case 'canvas_snapshot':
      case 'list_canvas_images':
      case 'get_canvas_image':
      case 'get_canvas_video':
      case 'prepare_image_generation':
      case 'create_image_holder':
      case 'insert_image_into_holder':
      case 'insert_video':
      case 'collect_annotations':
      case 'prepare_annotation_edit':
      case 'create_image_version':
      case 'save_snapshot':
      case 'save_checkpoint':
      case 'load_checkpoint':
      case 'list_checkpoints':
      case 'canvas_exec':
      case 'canvas_search':
      case 'canvas_focus_region':
      case 'canvas_arrange':
      case 'canvas_create_shape':
      case 'canvas_update_shape':
      case 'canvas_delete_shapes':
      // Internal helpers (no MCP surface): driven by the understand_canvas_video
      // main-side orchestrator via router.call to read the selected canvas video
      // and write the understanding result back as a canvas note.
      case 'get_selected_canvas_video':
      case 'add_canvas_note':
        return this.callCanvas(toolName, params)
      case 'director_open':
      case 'director_scene':
      case 'director_snapshot':
      case 'director_capture':
      case 'director_record':
      case 'director_exec':
        return this.callDirector(toolName, params)
      case 'understand_video':
      case 'understand_document':
      case 'web_research':
        return this.callUnderstand(toolName, params)
      case 'generate_audio':
        return this.generateAudio(params as GenerateAudioToolParams, threadId)
      case 'video_workbench_add_tasks':
      case 'video_workbench_update_task':
      case 'video_workbench_start':
      case 'video_workbench_status':
      case 'video_workbench_set_spec':
      case 'video_workbench_set_board_summary':
      case 'video_workbench_remove_tasks':
      case 'video_workbench_export':
      case 'video_workbench_apply':
        return this.callVideoWorkbench(toolName, params, threadId)
      default:
        throw new Error(`Unknown renderer tool: ${toolName}`)
    }
  }

  /**
   * video_workbench_*(生成视频工作台):AI 与用户操作同一个 zustand store
   * (useVideoWorkbenchStore),页面卡片实时反映 agent 的填写/启动。
   * 生成本身经 video-workbench:submit IPC 复用主进程 Seedance 链路。
   */
  private async callVideoWorkbench(
    toolName: string,
    params: Record<string, unknown>,
    threadId?: string,
  ): Promise<unknown> {
    const store = useVideoWorkbenchStore.getState()
    await store.ensureHydrated()

    const pickCards = (cardIds?: unknown) => {
      const ids = Array.isArray(cardIds)
        ? cardIds.filter((x): x is string => typeof x === 'string')
        : null
      const cards = useVideoWorkbenchStore.getState().cards
      return ids ? cards.filter((c) => ids.includes(c.id)) : cards
    }

    // 分页参数容错:zod 已在工具层挡过一遍,但这条路也被渲染端直调,坏值一律回退
    // 默认而不是抛 —— 读工具不该因为一个页码把整次调用变成错误。
    const toPositiveInt = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isInteger(n) && n >= 1 ? n : undefined
    }
    const clampPageSize = (v: unknown): number =>
      Math.min(toPositiveInt(v) ?? WORKBENCH_STATUS_PAGE_SIZE, WORKBENCH_STATUS_MAX_PAGE_SIZE)

    /**
     * 给整份筛选结果按页做目录,一页一条。
     *
     * 分批读取有个自带的坑:每次只回 3 张,agent 不知道第 4 页装的是什么,就只能
     * 一页页翻到底 —— 调用次数翻十倍,省下的上下文全赔进往返里。目录把「这一页
     * 大概是什么」提前摊开,让它一次跳到位。
     *
     * 每条只留 id 和 prompt 开头(24 字),不带素材/时长/rev —— 那些是「决定动手
     * 之后」才需要的,现在只是在挑页。
     */
    const buildPageIndex = (
      cards: ReturnType<typeof pickCards>,
      pageSize: number,
    ): Array<{ page: number; cardIds: string[]; digest: string }> => {
      const index: Array<{ page: number; cardIds: string[]; digest: string }> = []
      for (let start = 0; start < cards.length; start += pageSize) {
        const slice = cards.slice(start, start + pageSize)
        index.push({
          page: index.length + 1,
          cardIds: slice.map((c) => c.id),
          digest: slice
            .map((c) => {
              const head = (c.prompt ?? '').trim().replace(/\s+/g, ' ').slice(0, 24) || '(空)'
              // 状态只在「不是草稿」时才写 —— 草稿是绝大多数,标出来纯属噪音。
              return c.status && c.status !== 'draft' ? `${head} [${c.status}]` : head
            })
            .join(' / '),
        })
        // 目录本身也得有上限,否则 200 张卡 / 3 = 67 条,又变成一次性倒出去。
        if (index.length >= WORKBENCH_STATUS_MAX_INDEX_ENTRIES) break
      }
      return index
    }

    // 写操作统一回带的全局摘要(boards + 状态计数):每次写操作等于强制观测
    // 一次全局现状,agent 无需追加 status 调用。体积 O(页数),紧凑。
    const workbenchSummary = () => snapshotWorkbench(useVideoWorkbenchStore.getState())

    switch (toolName) {
      case 'video_workbench_add_tasks': {
        const rawTasks = Array.isArray(params.tasks) ? (params.tasks as Record<string, unknown>[]) : []
        if (rawTasks.length === 0) throw new Error('video_workbench_add_tasks: tasks is empty')
        // asset:// 引用 → 带 previewUrl 的 Material(人像库列表批量解析,
        // 失败/查不到保持字符串原样),新挂的素材缩略图直接有图。
        const tasks = await enrichAssetReferences(rawTasks)
        // 位置由稳定锚点 cardId 表达,不收下标 —— 下标在模型手里随时可能已经过期。
        const afterCardId = typeof params.afterCardId === 'string' ? params.afterCardId : undefined
        const beforeCardId = typeof params.beforeCardId === 'string' ? params.beforeCardId : undefined
        const anchor = afterCardId
          ? ({ afterCardId } as const)
          : beforeCardId
            ? ({ beforeCardId } as const)
            : undefined
        const cardIds = store.addCards(tasks, anchor)
        if (params.navigate !== false) {
          useTabStore.getState().switchTab('videoWorkbench')
        }
        let start: unknown
        if (params.autoStart === true) {
          const started = await useVideoWorkbenchStore.getState().startCards(cardIds)
          // 登记批次：跑完后由 batchCompletion watcher 主动推给本线程，
          // 模型不需要（也不应该）轮询 video_workbench_status 等结果。
          registerAgentBatch(started.started, threadId)
          start = started
        }
        return {
          cardIds,
          total: useVideoWorkbenchStore.getState().cards.length,
          ...(start ? { start } : {}),
          workbench: workbenchSummary(),
        }
      }
      case 'video_workbench_update_task': {
        const cardId = typeof params.cardId === 'string' ? params.cardId : ''
        if (!cardId) throw new Error('video_workbench_update_task: cardId is required')
        const [patch] = await enrichAssetReferences([params])
        const ok = store.updateCard(cardId, patch)
        const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === cardId)
        if (!card) throw new Error(`video_workbench_update_task: card not found: ${cardId}`)
        if (!ok) throw new Error(`video_workbench_update_task: card is rendering and cannot be edited: ${cardId}`)
        return { ok: true, card: snapshotCard(card), workbench: workbenchSummary() }
      }
      case 'video_workbench_start': {
        const ids = Array.isArray(params.cardIds)
          ? params.cardIds.filter((x): x is string => typeof x === 'string')
          : undefined
        const result = await store.startCards(ids)
        // 同上：批次跑完主动推送，取代轮询。
        registerAgentBatch(result.started, threadId)
        return { ...result, workbench: workbenchSummary() }
      }
      case 'video_workbench_set_spec': {
        // 「整板只改规格」的专用路径。此前 agent 只能抓 apply —— 那是**声明式整份 IR**,
        // 省略字段会被当成恢复默认,所以为了改三个字段,17 张卡的完整 prompt 和素材数组
        // 都得在模型里走一遍。用户看到的就是右边一直 RUNNING,而真正的改动一秒就能做完。
        const state = useVideoWorkbenchStore.getState()
        const boardId = typeof params.boardId === 'string' && params.boardId
          ? params.boardId
          : state.activeBoardId
        const explicitIds = Array.isArray(params.cardIds)
          ? params.cardIds.filter((x): x is string => typeof x === 'string')
          : null
        const targets = explicitIds
          ? state.cards.filter((c) => explicitIds.includes(c.id))
          : state.cards.filter((c) => c.boardId === boardId)

        // 只挑规格字段。**prompt 和素材进不来** —— 这是这个工具存在的理由:
        // 让「批量」和「重写内容」彻底分开,批量就不必再背着内容的体积。
        const SPEC_KEYS = [
          'model', 'resolution', 'ratio', 'duration', 'generateAudio', 'webSearch', 'mode',
        ] as const
        const patch: Record<string, unknown> = {}
        for (const k of SPEC_KEYS) if (params[k] !== undefined) patch[k] = params[k]
        if (Object.keys(patch).length === 0) {
          throw new Error('video_workbench_set_spec: 至少要给一个规格字段（model/resolution/ratio/duration/generateAudio/webSearch/mode）')
        }

        const updated: string[] = []
        const skipped: Array<{ cardId: string; reason: string }> = []
        for (const card of targets) {
          // 生成中的卡跳过而不是报错:一次扫板不该因为某张卡正好在渲染就整个失败,
          // 但也不能悄悄跳过 —— 回执里逐条列出,让 agent 有话可说。
          const ok = store.updateCard(card.id, patch as VideoWorkbenchCardInput)
          if (ok) updated.push(card.id)
          else skipped.push({ cardId: card.id, reason: '生成中或该卡不存在，未改动' })
        }
        return { updated, skipped, workbench: workbenchSummary() }
      }
      case 'video_workbench_set_board_summary': {
        const boardId = typeof params.boardId === 'string' ? params.boardId : ''
        if (!boardId) throw new Error('video_workbench_set_board_summary: boardId is required')
        const summary = typeof params.summary === 'string' ? params.summary : ''
        const ok = store.setBoardSummary(boardId, summary)
        if (!ok) {
          const ids = useVideoWorkbenchStore.getState().boards.map((b) => b.id).join(', ')
          throw new Error(
            `video_workbench_set_board_summary: board not found: ${boardId} (existing: ${ids})`,
          )
        }
        return { ok: true, workbench: workbenchSummary() }
      }
      case 'video_workbench_status': {
        const state = useVideoWorkbenchStore.getState()
        const boardId = typeof params.boardId === 'string' && params.boardId ? params.boardId : undefined
        if (boardId && !state.boards.some((b) => b.id === boardId)) {
          throw new Error(
            `video_workbench_status: board not found: ${boardId} (existing: ${state.boards.map((b) => b.id).join(', ')})`,
          )
        }
        // 默认**只看当前页**。此前省略 boardId = 倒出所有页的卡，一个装了十几页的
        // 工作台会把几百张卡的摘要一股脑塞进上下文，而用户九成时间只在看一页。
        // 要看别页得明说：给 boardId，或 allBoards:true。
        const allBoards = params.allBoards === true
        const scopeBoardId = boardId ?? (allBoards ? undefined : state.activeBoardId)
        let cards = pickCards(params.cardIds)
        // 点名了 cardIds 就按 id 取，不再按页收窄 —— 那是「我就要这几张」的意思。
        if (scopeBoardId && !Array.isArray(params.cardIds)) {
          cards = cards.filter((c) => c.boardId === scopeBoardId)
        }
        const summary = snapshotWorkbench(state)
        // 分页:一个工作台能装 200 张卡,整份倒出去会被客户端静默截断。口径与
        // list_portrait_library 一致(page 从 1 起 / pageSize 有上限 / hasMore)。
        const pageSize = clampPageSize(params.pageSize)
        const totalPages = Math.max(1, Math.ceil(cards.length / pageSize))
        const page = Math.min(Math.max(1, toPositiveInt(params.page) ?? 1), totalPages)
        const pageCards = cards.slice((page - 1) * pageSize, page * pageSize)
        return {
          // 每页一条的目录。**这才是分批读取能成立的前提** —— 只回 3 张卡而不告诉
          // 你剩下的是什么,agent 只能从第 1 页翻到最后一页,比一次性倒出去还费。
          // 有了目录它能直接跳到相关那一页。刻意做得很省:每张卡只留 id + 截断的
          // prompt 开头,不带素材/时长/rev,一条约等于四分之一张卡。
          pageIndex: buildPageIndex(cards, pageSize),
          // total 是**筛选后的全部**,不是本页数量 —— agent 得知道自己只看到了一部分。
          total: cards.length,
          // 明确告诉它这次的取值范围,否则「只看到 12 张」和「整个工作台只有 12 张」
          // 在回包里长得一样。boards 里的 cardCount 是各页真实总数,可据此判断
          // 要不要去看别页。
          scope: scopeBoardId ? { boardId: scopeBoardId } : { allBoards: true },
          activeBoardId: summary.activeBoardId,
          boards: summary.boards,
          // status 是**读**工具,不带 workbench 包装,所以选中态得在这一层平铺 ——
          // 否则「按需回读」在唯一一个专门用来回读的工具上反而看不到它。
          selectedCardIds: summary.selectedCardIds,
          cards: pageCards.map(snapshotCard),
          page,
          pageSize,
          totalPages,
          hasMore: page < totalPages,
        }
      }
      case 'video_workbench_remove_tasks': {
        const ids = Array.isArray(params.cardIds)
          ? params.cardIds.filter((x): x is string => typeof x === 'string')
          : []
        for (const id of ids) store.removeCard(id)
        return {
          removed: ids,
          total: useVideoWorkbenchStore.getState().cards.length,
          workbench: workbenchSummary(),
        }
      }
      case 'video_workbench_export': {
        const ir = store.exportIR()
        /**
         * skeleton:把每张卡剥成 `{id, rev}` 的占位条目。
         *
         * 补的是读侧的对称性 —— 写侧已经限了内容卡张数,读侧却还是整板全量:
         * 17 张卡的完整提示词约两万字符,模型要读完、改完、再吐一遍。而「重排」和
         * 「只改其中几张」这两类活**根本不需要看别人的提示词**,它们只需要 id 和顺序。
         *
         * 拿骨架 → 往要改的那几张里填内容 → 回写。顺序天然正确(每张卡都列了),
         * 体积与提示词长度无关。只有真要**读**现有提示词时才该拉全量。
         */
        const skeleton = params.skeleton === true
        /**
         * cardIds:只有点名的卡出全文，其余剥成占位。
         *
         * 补的是「分批读全文」这条路 —— status 截断到 120 字，而整板 export 是
         * 要么全给要么被体积闸拒，中间没有台阶。点名之后读多少由调用方定，
         * 而结果仍然**直接可回写**:每张卡都在，顺序不乱，只有点名的那几张计入
         * apply 的内容卡上限。
         */
        const pickIds = Array.isArray(params.cardIds)
          ? new Set(params.cardIds.filter((x): x is string => typeof x === 'string'))
          : null
        const strip = (src: WorkbenchIR): WorkbenchIR => ({
          ...src,
          boards: src.boards.map((b) => ({
            ...b,
            cards: b.cards.map((c) => (
              // skeleton 一律剥；否则只剥没被点名的。
              // IR 里的 id 是可选的（新建卡还没有 id），点名匹配前先确认它存在。
              !skeleton && !!c.id && pickIds?.has(c.id)
                ? c
                : { id: c.id, ...(typeof c.rev === 'number' ? { rev: c.rev } : {}) }
            )),
          })),
        })
        const trim = (src: WorkbenchIR): WorkbenchIR => (skeleton || pickIds ? strip(src) : src)
        // 默认只导**当前页**。整份导出带着每张卡的完整提示词和每条素材的完整路径,
        // 一个中等规模的工作台就能超出客户端肯收的体积,而截断后的 IR 回写会把被截
        // 掉的字段清成默认值(apply 是声明式不是 patch)。收窄默认是安全的:merge
        // 模式保证没列出的页原样不动。要跨页改动才显式传 allBoards。
        const explicitBoardId = typeof params.boardId === 'string' && params.boardId ? params.boardId : undefined
        if (!explicitBoardId && params.allBoards === true) return trim(ir)
        const boardId = explicitBoardId ?? ir.activeBoardId
        const board = boardId ? ir.boards.find((b) => b.id === boardId) : undefined
        if (!board) {
          // 只有**显式**要了一页却找不到才算调用方的错。隐式取当前页时解析不出
          // (activeBoardId 缺失或指向已删的页)是我们这边的状态问题,退回整份导出
          // 比抛一句「board not found: <一个 agent 没提过的 id>」有用。
          if (explicitBoardId) {
            throw new Error(
              `video_workbench_export: board not found: ${explicitBoardId} (existing: ${ir.boards.map((b) => b.id).join(', ')})`,
            )
          }
          return trim(ir)
        }
        // 单页导出仍带全局 revision —— 令牌是整个工作台的,不是这一页的。
        // 配 merge 模式回写是安全的:没列出的页原样保留。
        const scoped = { ...ir, boards: [board] }
        return trim(scoped)
      }
      case 'video_workbench_apply': {
        const raw = params.ir
        if (!raw || typeof raw !== 'object') {
          throw new Error('video_workbench_apply: ir is required (get one from video_workbench_export)')
        }
        const ir = raw as WorkbenchIR
        // asset:// 素材补 previewUrl:IR 里刻意不带这个展示派生物,不补的话
        // apply 完人像库素材的缩略图会空一片。批量一轮解析,失败保持原样。
        const boards = await Promise.all(
          (Array.isArray(ir.boards) ? ir.boards : []).map(async (board) => ({
            ...board,
            cards: (await enrichAssetReferences(
              (Array.isArray(board?.cards) ? board.cards : []) as Array<Record<string, unknown>>,
            )) as unknown as WorkbenchIR['boards'][number]['cards'],
          })),
        )
        const mode = params.mode === 'replace' ? 'replace' : 'merge'
        return await store.applyIR({ ...ir, boards }, { mode, force: params.force === true })
      }
      default:
        throw new Error(`Unknown video workbench tool: ${toolName}`)
    }
  }

  /**
   * generate_audio(seed-audio-1.0):codex MCP 出音频。薄层 —— 复用与音频页
   * 完全相同的「生成 + 三级持久化 + 落库」共享核心(features/audio/audioGeneration),
   * 所以 agent 出的音频和用户手动出的音频进同一个作品库、同一套存储/播放语义。
   * main 端 audioTools 把这里的结构体包成 banner;不抛异常。
   */
  private async generateAudio(
    params: GenerateAudioToolParams,
    requestThreadId?: string,
  ): Promise<
    | { success: true; prompt: string; format: string; duration: number; billedSeconds: number; filePath?: string; remoteUrl?: string }
    | { success: false; error: string }
  > {
    const api = ServiceRegistry.getRequired<AudioGenerationApi>(SERVICE_KEYS.API)
    const prompt = typeof params.input === 'string' ? params.input : ''
    const format = params.format === 'wav' || params.format === 'opus' ? params.format : 'mp3'
    const speed = typeof params.speed === 'number' ? params.speed : undefined
    const referenceAudios = Array.isArray(params.referenceAudios)
      ? params.referenceAudios.filter((s): s is string => typeof s === 'string')
      : undefined

    // Show a chat bubble (spinner → audio player) like generate_image/video, so
    // agent-generated audio is visible IN THE CONVERSATION, not only in the
    // 音频生成 library. Route to the requesting thread (parallel-chat safe).
    const chat = useAgentChatStore.getState()
    const reqThreadId = requestThreadId ?? chat.threadId
    const genId = chat.beginImageGeneration(prompt, reqThreadId, 'audio')

    const outcome = await generateAudioToLibrary(
      { prompt, format, speed, referenceAudios },
      api,
      getAudioLibraryStore(),
    )
    if (!outcome.success) {
      useAgentChatStore.getState().failImageGeneration(genId, outcome.error, reqThreadId)
      return { success: false, error: outcome.error }
    }
    const { item } = outcome
    // Prefer the network COS URL for the in-chat player (always renderable);
    // fall back to the local file path (toRenderableUri → local-file://).
    const playbackUri = item.remoteUrl || item.filePath || ''
    if (playbackUri) {
      useAgentChatStore.getState().resolveImageGeneration(
        genId,
        [{
          id: item.id,
          kind: 'file',
          name: `${item.prompt.slice(0, 24) || 'audio'}.${item.format.includes('opus') || item.format.includes('ogg') ? 'ogg' : item.format.includes('wav') ? 'wav' : 'mp3'}`,
          mime: item.format.includes('opus') || item.format.includes('ogg') ? 'audio/ogg' : item.format.includes('wav') ? 'audio/wav' : 'audio/mpeg',
          size: 0,
          uri: playbackUri,
        }],
        reqThreadId,
      )
    } else {
      // No renderable source (base64-only fallback) — settle the bubble as done
      // with no artifacts rather than leaving it spinning.
      useAgentChatStore.getState().resolveImageGeneration(genId, [], reqThreadId)
    }

    return {
      success: true,
      prompt: item.prompt,
      format: item.format,
      duration: item.duration,
      billedSeconds: item.billedSeconds,
      ...(item.filePath ? { filePath: item.filePath } : {}),
      ...(item.remoteUrl ? { remoteUrl: item.remoteUrl } : {}),
    }
  }

  /**
   * qwen3.7-max-dashscope 理解工具(视频/文档/联网)。薄层:解析媒体源 →
   * 调 ApiService.understand()。返回 `{success,…}` 结构体,由 main 端
   * understandTools 包成 banner;这里不抛异常(健壮性已在 understand() 内处理),
   * 仅当本机文件无法转成公网 URL 时返回结构化错误。
   */
  private async callUnderstand(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ success: true; text: string } | { success: false; error: string }> {
    const api = ServiceRegistry.getRequired<{
      understand: (
        input: UnderstandInput,
        opts?: { model?: string },
      ) => Promise<{ success: true; text: string } | { success: false; error: string }>
    }>(SERVICE_KEYS.API)

    // Optional model switch ('plus' | 'max' | full -dashscope name). Non-allow-listed
    // values fall back to the default (plus) inside ApiService.resolveUnderstandModel.
    const model = typeof params.model === 'string' ? params.model : undefined

    if (toolName === 'web_research') {
      const query = typeof params.query === 'string' ? params.query : ''
      if (!query) return { success: false, error: 'web_research 缺少 query。' }
      return api.understand({ kind: 'web', query }, { model })
    }

    const question = typeof params.question === 'string' ? params.question : ''
    if (!question) return { success: false, error: `${toolName} 缺少 question。` }

    const media = this.resolveMediaUrl(params, toolName === 'understand_video' ? 'video' : 'document')
    if (!media.ok) return { success: false, error: media.error }

    if (toolName === 'understand_video') {
      const fps = typeof params.fps === 'number' ? params.fps : undefined
      return api.understand({ kind: 'video', mediaUrl: media.url, question, fps }, { model })
    }
    // 追加图由主进程先逐张中转成公网 URL 再放进 file_urls,这里只透传 —— 顺序
    // 已在那一侧按输入序固定好,不要在这里重排或去重(去重在 understand() 里做,
    // 它同时要处理 mediaUrl 与追加图重复的情况)。
    const extraUrls = Array.isArray(params.file_urls)
      ? params.file_urls.filter((u): u is string => typeof u === 'string')
      : undefined
    return api.understand(
      { kind: 'document', mediaUrl: media.url, question, mediaUrls: extraUrls },
      { model },
    )
  }

  /**
   * 解析理解工具的媒体源。`*_url`(http/https/data)直接用。
   *
   * 注:本机 `*_path` → 公网 URL 的自动上传(走历史 COS 桶)已在 **main 端**
   * understandTools.runUnderstand 里完成 —— 调到这里时 main 已把本机路径转成
   * `*_url` 了,所以这里通常只会见到 URL。下面的本机路径分支是**防御性兜底**
   * (理论上不会命中:所有调用都经 main 的 router.call,而 main 先做了转换);
   * 万一未经 main 直达,则回结构化错误提示用 URL。
   */
  private resolveMediaUrl(
    params: Record<string, unknown>,
    kind: 'video' | 'document',
  ): { ok: true; url: string } | { ok: false; error: string } {
    const urlKey = kind === 'video' ? 'video_url' : 'file_url'
    const pathKey = kind === 'video' ? 'video_path' : 'file_path'
    const url = params[urlKey]
    if (typeof url === 'string' && /^(https?:|data:)/.test(url)) {
      return { ok: true, url }
    }
    const localPath = params[pathKey]
    if (typeof localPath === 'string' && localPath.length > 0) {
      return {
        ok: false,
        error: `本机文件 (${pathKey}) 未被 main 端转成公网 URL(异常路径);qwen 只接受公网可达 URL,请改用 ${urlKey}。`,
      }
    }
    return { ok: false, error: `缺少 ${urlKey} 或 ${pathKey}。` }
  }

  /**
   * 导演台工具:全部交给 directorBridge(挂载即注册的 DirectorStageHandle)。
   * 统一注入当前活跃聊天线程 —— capture/record/scene(export_pose_clip_glb)
   * 都会把导出文件落盘为线程附件(FK on threadId);没有线程时 bridge 返回
   * 结构化错误而不是丢文件。其余 action 忽略该字段,注入无副作用。
   */
  private async callDirector(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const threadId = useAgentChatStore.getState().threadId
    return directorBridge.handle(toolName, { ...params, threadId })
  }

  private async callCanvas(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    if (toolName === 'canvas_open') {
      // Open the Canvas surface directly in the Codex page's center display
      // (file-explorer viewer) so the tldraw editor mounts, then wait for it to
      // register with the bridge before reporting success — this lets the agent
      // call canvas_open and immediately follow with shape tools.
      useFileExplorerStore.getState().openCanvasTab()
      await canvasBridge.waitForEditor()
      return { opened: true }
    }
    // Cold-start self-heal: every other canvas tool needs the live editor. If
    // it's absent (canvas never opened this session), open the Canvas tab and
    // wait for the mount instead of failing with "Canvas is not open" — this
    // used to force a manual canvas_open→retry dance on the agent. With the
    // keep-alive mount in ViewerHost the editor survives tab switches, so this
    // only ever fires ONCE per session (true cold start); the deliberate tab
    // focus steal is confined to that case. canvas_search (curated API spec)
    // and list_checkpoints (IPC-only) don't touch the editor — skip for those
    // so read-only discovery never yanks the user's active tab.
    if (toolName !== 'canvas_search' && toolName !== 'list_checkpoints' && !canvasBridge.hasEditor()) {
      useFileExplorerStore.getState().openCanvasTab()
      await canvasBridge.waitForEditor()
    }
    if (
      toolName === 'canvas_snapshot' ||
      toolName === 'get_canvas_image' ||
      toolName === 'get_canvas_video' ||
      toolName === 'save_snapshot' ||
      toolName === 'canvas_focus_region'
    ) {
      // These persist an exported file as a thread-scoped attachment (FK on
      // threadId), so hand the bridge the active chat thread; without it the
      // image export is dropped (canvas_snapshot) / omitted (get_canvas_image) /
      // the get_canvas_video materialize fallback can't save a copy /
      // save_snapshot returns no imagePath. canvas_focus_region needs it too:
      // the agent's VIRTUAL viewport is keyed per thread so the next
      // canvas_snapshot (same thread) tiers around it.
      const threadId = useAgentChatStore.getState().threadId
      return canvasBridge.handle(toolName, { ...params, threadId })
    }
    return canvasBridge.handle(toolName, params)
  }

  /**
   * Interactive question: append a clickable card to the requesting chat and
   * block until the user answers/skips. The resolved {@link ChoiceAnswer} flows
   * straight back to the agent as the tool result (option ids + labels + any
   * free text), so the agent can act on the decision without re-asking.
   */
  private async askUser(params: AskUserToolParams, requestThreadId?: string): Promise<ChoiceAnswer> {
    const question = typeof params.question === 'string' ? params.question.trim() : ''
    if (!question) throw new Error('ask_user requires a question')

    const options: ChoiceOption[] = Array.isArray(params.options)
      ? params.options
          .filter((o): o is { id: unknown; label: unknown; description?: unknown } => !!o && typeof o === 'object')
          .map((o) => ({
            id: typeof o.id === 'string' && o.id.length > 0 ? o.id : createChoiceId(),
            label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
            ...(typeof o.description === 'string' ? { description: o.description } : {}),
          }))
          .filter((o) => o.label.length > 0)
      : []

    const mode: 'single' | 'multi' = params.mode === 'multi' ? 'multi' : 'single'
    // An option-less question is implicitly free-text (e.g. "片名叫什么?").
    const allowFreeText = options.length === 0 ? true : params.allowFreeText !== false
    const allowSkip = params.allowSkip !== false

    const chat = useAgentChatStore.getState()
    const reqThreadId = requestThreadId ?? chat.threadId
    return chat.ask({ question, options, mode, allowFreeText, allowSkip }, reqThreadId)
  }

  private async generateImage(
    params: GenerateImageToolParams,
    requestThreadId?: string,
    resolvedReferenceImages?: string[],
  ): Promise<unknown> {
    const api = ServiceRegistry.getRequired<{
      generateImage: (params: GenerateImageParams) => Promise<GenerateResult>
      getModelConfig?: (name: string) => { inlineRefImageAsBase64?: boolean } | undefined
    }>(SERVICE_KEYS.API)

    // Agent autonomy first (explicit valid `params.model` wins, e.g. 万相 for a
    // 组图 series), else the user's picked channel, else VIP.
    //
    // Resolved BEFORE the references below because the channel decides how refs
    // must travel: nano/gemini want base64 `inline_data`, everything else wants
    // a URL. See resolveReferenceImages.
    const model = resolveEffectiveImageChannel(params.model)

    // Resolve reference images BEFORE showing the in-progress bubble. Codex
    // passes uploads-dir file PATHS (e.g. `C:\...\agent\uploads\<hash>.jpg`),
    // which ApiService cannot `fetch()` — a raw path becomes
    // `data:image/jpeg;base64,C:\...` → ERR_INVALID_URL. Doing this before
    // `beginImageGeneration` keeps a bad path from leaving a dangling
    // "generating" bubble — it surfaces as a clean explicit error to the agent
    // instead. Only `await` when refs are actually present so the no-ref
    // (text-to-image) path still shows its in-progress bubble synchronously.
    const referenceImages =
      resolvedReferenceImages ??
      (Array.isArray(params.referenceImages) && params.referenceImages.length > 0
        ? await this.resolveReferenceImages(params.referenceImages, model)
        : undefined)

    const request: GenerateImageParams = {
      ...params,
      referenceImages,
      model,
      resolution: params.resolution ?? CODEX_DEFAULT_RESOLUTION,
      // Pin Miau-only channels to the Miau API site so they always reach the
      // gateway regardless of the user's currently selected site (the renderer
      // otherwise rewrites the endpoint host with the active site's host).
      ...(isMiauOnlyChannel(model) ? { siteKey: MIAU_SITE_KEY } : {}),
    }

    // Resolve the REQUESTING thread. Prefer the authoritative id Codex stamped
    // on the tool call's `_meta` (reverse-mapped to our db thread id in main,
    // arriving as `requestThreadId`) — that's correct even when several chats
    // generate in parallel. Fall back to the active thread at tool-start only
    // when the metadata is missing (older codex / manual calls). This is what
    // keeps a background turn's image in ITS chat instead of leaking into
    // whatever chat is active when the render finishes.
    const chat = useAgentChatStore.getState()
    const reqThreadId = requestThreadId ?? chat.threadId

    // Show a "generating" bubble immediately so the user sees in-progress
    // feedback during the (potentially long) request, then settle it in place.
    const genId = chat.beginImageGeneration(request.prompt, reqThreadId)

    let result: GenerateResult
    try {
      result = await api.generateImage(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      chat.failImageGeneration(genId, message, reqThreadId)
      throw error
    }

    if (!result.success) {
      const message = result.error || 'Image generation failed'
      chat.failImageGeneration(genId, message, reqThreadId)
      throw new Error(message)
    }

    const images = result.images ?? result.urls ?? []
    if (images.length === 0) {
      const message = 'Image generation returned no images'
      chat.failImageGeneration(genId, message, reqThreadId)
      throw new Error(message)
    }

    // Settle the bubble with the finished images (thumbnail + lightbox).
    chat.resolveImageGeneration(genId, this.toArtifacts(images), reqThreadId)

    // THE SUCCESS CRITERION ENDS HERE. The image is rendered and on screen, so
    // the tool call is a success no matter what happens to the bookkeeping
    // below. History + file-panel persistence (which yield `historyId` and the
    // local `paths`) run under a fixed time budget: if they finish in time, the
    // agent gets the full result; if the local DB hangs, we return success
    // immediately with empty paths and let persistence settle in the
    // background. Codex must NEVER wait on bookkeeping for an image the user
    // is already looking at.
    const persistence = this.persistArtifacts(request, images, reqThreadId)
    const settled = await Promise.race([
      persistence,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PERSISTENCE_BUDGET_MS)),
    ])

    if (!settled) {
      // Show the save-status banner on the bubble NOW (pending), and update the
      // SAME bubble whenever the background save eventually settles — so the
      // user sees "保存中" flip to the final folder without any new message.
      chat.annotateImageGeneration(genId, { status: 'pending' }, reqThreadId)
      void persistence
        .then((late) => {
          this.swapBubbleToSaved(genId, late, reqThreadId)
          useAgentChatStore
            .getState()
            .annotateImageGeneration(genId, this.toSaveInfo(late), reqThreadId)
        })
        .catch(() => {})
      return {
        ok: true,
        count: images.length,
        model,
        historyId: null,
        paths: [],
        persistencePending: true,
      }
    }

    this.swapBubbleToSaved(genId, settled, reqThreadId)
    chat.annotateImageGeneration(genId, this.toSaveInfo(settled), reqThreadId)

    // Return a COMPACT result to the agent — never echo multi-MB base64 back
    // into the model context (token blowup + useless to the agent). `paths`
    // (the saved local files) + `historyId` let the agent read/move/reference
    // the result exactly like native `image_gen` output.
    return {
      ok: true,
      count: images.length,
      model,
      historyId: settled.historyId,
      paths: settled.paths,
    }
  }

  /**
   * Batch render: run N single renders through a bounded worker pool (each drives
   * its OWN "generating" bubble in the requesting chat) and fold the outcomes
   * into one combined result. Settled outcomes preserve prompt order, so a
   * partial failure never sinks the whole batch and is still reported at the
   * correct index. Shared references are resolved once and reused by every job.
   */
  private async generateImages(
    params: GenerateImagesToolParams,
    requestThreadId?: string,
  ): Promise<ImageBatchResult> {
    const prompts = Array.isArray(params.prompts)
      ? params.prompts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : []
    if (prompts.length === 0) throw new Error('generate_images requires a non-empty prompts[]')

    // Resolve shared local references ONCE. The previous implementation
    // re-read and base64-encoded the same full-resolution files for every prompt,
    // multiplying IPC/memory pressure before N identical uploads.
    // Same channel every fan-out branch will resolve to, so the refs are
    // encoded once in the form that channel actually wants.
    const sharedReferenceImages =
      Array.isArray(params.referenceImages) && params.referenceImages.length > 0
        ? await this.resolveReferenceImages(
            params.referenceImages,
            resolveEffectiveImageChannel(params.model),
          )
        : undefined

    const settled = await settleWithConcurrency(
      prompts,
      CODEX_IMAGE_BATCH_CONCURRENCY,
      (prompt) =>
        this.generateImage(
          {
            prompt,
            model: params.model,
            ratio: params.ratio,
            resolution: params.resolution,
            quality: params.quality,
            referenceImages: sharedReferenceImages,
          } as unknown as GenerateImageToolParams,
          requestThreadId,
          sharedReferenceImages,
        ),
    )

    const successes: unknown[] = []
    const failures: Array<{ index: number; error: string }> = []
    const savedPaths: string[] = []
    settled.forEach((entry, i) => {
      if (entry.status === 'fulfilled') {
        successes.push(entry.value)
        const paths = (entry.value as { paths?: unknown } | null)?.paths
        if (Array.isArray(paths)) {
          for (const p of paths) if (typeof p === 'string' && p.length > 0) savedPaths.push(p)
        }
      } else {
        failures.push({
          index: i + 1,
          error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        })
      }
    })
    return { successes, failures, savedPaths }
  }

  /**
   * Post-generation bookkeeping: history record (base64 → R2 handled inside)
   * and file-panel save (uploads dir → concrete local paths, replicating
   * codex native `image_gen`'s generate→save→report-path contract). Never
   * rejects — generation success was already decided by the render, so any
   * failure here just degrades the returned metadata.
   */
  private async persistArtifacts(
    request: GenerateImageParams,
    images: string[],
    threadId: string | undefined,
  ): Promise<{ historyId: number | string | null; paths: string[] }> {
    try {
      const [historyId, paths] = await Promise.all([
        this.recordHistory(request, images),
        threadId ? this.saveToFilePanel(threadId, request.prompt, images) : Promise.resolve([]),
      ])

      // Anchor the bubble to the history record so it survives reload /
      // thread-switch. History URLs are preferred when available, but they can
      // remain `pending:*` until async R2/COS upload settles. Store the tiny
      // local saved paths too, so reload/edit can still restore thumbnail +
      // address.
      if (historyId != null && threadId) {
        recordCodexArtifact(threadId, {
          id: `codex-artifact-${historyId}`,
          createdAt: Date.now(),
          prompt: request.prompt,
          historyId,
          paths,
        })
      }
      return { historyId, paths }
    } catch (error) {
      console.error('[AgentToolExecutor] post-generation persistence failed:', error)
      return { historyId: null, paths: [] }
    }
  }

  /**
   * Once the image is safely on disk, rebuild the bubble from the tiny saved
   * paths so the inline multi-MB `data:` base64 (held by `toArtifacts` for the
   * instant on-screen render) can be garbage-collected instead of lingering in
   * the chat store for the whole session — the live-session half of the OOM /
   * "memory leak" fix. The local path then renders through `media:thumb` (512px
   * bubble) + full-fidelity lightbox; on reload the bubble upgrades to the COS
   * 数据万象 thumbnail. No-op when persistence produced no local paths (the
   * original base64 keeps the image visible; the save banner reports failure).
   */
  private swapBubbleToSaved(
    genId: string,
    settled: { historyId: number | string | null; paths: string[] },
    threadId: string | undefined,
  ): void {
    const light = buildLightArtifacts(settled.paths, 'image', genId)
    if (light.length > 0) {
      useAgentChatStore.getState().replaceImageArtifacts(genId, light, threadId)
    }
  }

  /** Map settled persistence results to the bubble's save-status banner payload. */
  private toSaveInfo(settled: { historyId: number | string | null; paths: string[] }): ArtifactSaveInfo {
    const { historyId, paths } = settled
    // No file paths AND no history record → the bookkeeping really failed.
    // Paths alone can legitimately be empty (e.g. no file-panel thread); the
    // history record still makes the image findable, so that's a save.
    if (paths.length === 0) {
      return historyId != null ? { status: 'saved' } : { status: 'failed' }
    }
    const first = paths[0]
    const cut = Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/'))
    return {
      status: 'saved',
      dir: cut > 0 ? first.slice(0, cut) : undefined,
      paths,
    }
  }

  private toArtifacts(images: string[]): AttachmentRef[] {
    return images.map((uri, i) => ({
      id: `codex-img-${Date.now()}-${i}`,
      kind: 'image' as const,
      name: `codex-image-${i + 1}.png`,
      mime: 'image/png',
      size: uri.startsWith('data:') ? uri.length : 0,
      uri,
    }))
  }

  /**
   * Normalize `referenceImages` into sources ApiService can submit.
   *
   * `data:`/`http(s):` entries pass through untouched. Anything else is a local
   * filesystem path (codex hands us uploads-dir paths), and how we turn it into
   * a submittable source depends on the CHANNEL:
   *
   *   - **nano/gemini** (`inlineRefImageAsBase64`): read the bytes and inline
   *     them as a data URL. These endpoints want base64 `inline_data`, so a COS
   *     round trip would only be undone later by ApiService fetching the URL
   *     back into base64.
   *
   *   - **everything else** (万相 / seedream / …): stream the file to COS and
   *     submit the URL. Same policy the UI has used all along — see
   *     `utils/refImageUpload` ("原图直传云端,不压缩"). Inlining here used to
   *     put multi-MB base64 in the request body, which bloats the payload and
   *     trips upstream's ~1MB `url is too long` limit.
   *
   * COS failures degrade to the inline path rather than failing the call, so a
   * bucket outage costs quality-of-implementation, not the generation.
   *
   * Returns `undefined` for no refs (text-to-image). If refs were provided but
   * NONE could be resolved, throws an explicit error so the agent learns the
   * path was bad instead of the request silently degrading to text-to-image.
   */
  private async resolveReferenceImages(
    refs: unknown,
    model?: string,
  ): Promise<string[] | undefined> {
    if (!Array.isArray(refs) || refs.length === 0) return undefined

    const electron = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI
    const api = electron?.attachments
    const apiService = ServiceRegistry.get<{
      getModelConfig?: (name: string) => { inlineRefImageAsBase64?: boolean } | undefined
    }>(SERVICE_KEYS.API)
    const preferInline =
      model !== undefined && wantsInlineBase64ForModel(apiService?.getModelConfig?.(model))

    // **不去重。** 每一次生图都是一次全新任务:调用方传了几张、按什么次序传,
    // 就原样解析几张、按原次序返回。折叠重复项会让数组变短,而提示词里的
    // 「图1 / 图2」是按下标对应的 —— 少一项,后面所有编号全体前移。
    const entries = refs.filter((raw): raw is string => typeof raw === 'string' && raw.length > 0)

    /** 一张参考图 → 可提交源。失败带上原因,交给下面统一决定整次成败。 */
    const resolveOne = async (raw: string): Promise<{ ok: true; src: string } | { ok: false; reason: string }> => {
      if (raw.startsWith('data:') || raw.startsWith('http://') || raw.startsWith('https://')) {
        return { ok: true, src: raw }
      }

      // URL channels: stream to COS in main (the file never enters this heap).
      if (!preferInline && api?.resolveRefImage) {
        const relayed = await api.resolveRefImage(raw)
        if (relayed.ok) return { ok: true, src: relayed.url }
        // Fall through to inline — a COS outage shouldn't sink the generation.
        console.warn(`[refImage] COS relay failed, inlining instead: ${raw} (${relayed.reason})`)
      }

      if (!api?.readThumb) return { ok: false, reason: 'attachments API unavailable' }
      const full = await api.readThumb(raw)
      return full.ok
        ? { ok: true, src: `data:${full.mime};base64,${full.base64}` }
        : { ok: false, reason: full.reason }
    }

    // **并发解析,但按入参次序收结果。**
    //
    // 原本是 `for...of` 里逐张 await:九张图就是九次串行往返,每次都要等上一张
    // 传完 COS 才开始下一张,而它们之间毫无依赖。
    //
    // 陷阱是别顺手写成「谁先完成谁 push」—— `Promise.all` 的返回数组按**输入**
    // 顺序排,与完成顺序无关,所以必须先整份收下来再按下标铺开。小图先传完就排到
    // 大图前面的话,「图1」指向什么每次运行都可能不一样,而且不报错。
    //
    // 并发度不用在这里管:`resolveRefImage` 落到主进程的 relayFileToCos,那里有
    // 4 路全局闸,渲染端一次发九个 invoke 也只会在主进程排队。内联那条不额外占
    // 峰值内存 —— 无论串行还是并发,九张的 base64 最终都同时躺在返回数组里。
    const outcomes = await Promise.all(entries.map(resolveOne))
    const failures = outcomes.flatMap((o, i) => (o.ok ? [] : [`${entries[i]} (${o.reason})`]))
    const resolved = outcomes.flatMap((o) => (o.ok ? [o.src] : []))

    // **位置有语义,所以宁可整次失败,也不能少一个继续。**
    //
    // 提示词里的「图1 / 图2」按 referenceImages 的下标对应(多图融合渠道尤其
    // 依赖这个)。三张里第二张读不出来时,旧实现返回 [第一张, 第三张] 并把
    // failures 丢掉 —— 于是「图2 的衣服」指向了原本的第三张,上游照单全收,
    // 画面看着「像那么回事」,没有任何报错告诉用户参考图少了一张、编号全移了位。
    //
    // 注意这不推翻上面那句「COS 挂了不该让整次生成沉船」:中转失败仍会降级内联,
    // 两条路都走不通才到这里。
    if (failures.length > 0) {
      throw new Error(`参考图无法读取：${failures.join('; ')}`)
    }
    return resolved.length > 0 ? resolved : undefined
  }

  private async recordHistory(
    request: GenerateImageParams,
    images: string[],
  ): Promise<number | string | null> {
    try {
      const history = ServiceRegistry.get<HistoryDataService>(SERVICE_KEYS.HISTORY_DATA)
      if (!history) return null
      await history.init()
      const saved = (await history.addToHistory(
        'codex',
        request.prompt,
        images,
        request.ratio,
        request.model ?? DEFAULT_IMAGE_CHANNEL_ID,
        request.referenceImages ? { referenceImages: request.referenceImages } : undefined,
      )) as { id?: number | string } | null
      return saved?.id ?? null
    } catch (error) {
      // History persistence is best-effort; never fail the generation over it.
      console.error('[AgentToolExecutor] failed to record codex image to history:', error)
      return null
    }
  }

  /**
   * Persist generated images into the ATTACHMENTS file panel (uploads dir) and
   * return the saved absolute file path(s).
   *
   * Each image is normalized to base64 then handed to the main `attachments:save`
   * IPC, which content-addresses + size-caps it, broadcasts a panel refresh, and
   * returns the canonical on-disk path. Returning those paths is what lets the
   * agent read/move/reference the result like codex's native `image_gen`.
   */
  private async saveToFilePanel(threadId: string, prompt: string, images: string[]): Promise<string[]> {
    const api = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.attachments
    if (!api?.save) return []
    const base = this.slugify(prompt) || 'codex-image'
    const stamp = Date.now()
    const paths: string[] = []
    for (let i = 0; i < images.length; i++) {
      const uri = images[i]
      const suffix = images.length > 1 ? `-${i + 1}` : ''
      try {
        // URL-returning channels: the result is a remote presigned link (COS/OSS)
        // that the renderer cannot `fetch()` (no Access-Control-Allow-Origin → the
        // `net::ERR_FAILED 200` CORS block). Hand the URL to MAIN, which downloads
        // it (no browser CORS) + ingests. Covers image AND video result URLs.
        if (/^https?:\/\//i.test(uri) && api.saveFromUrl) {
          const res = await api.saveFromUrl({
            threadId,
            name: `${base}-${stamp}${suffix}.bin`,
            url: uri,
          })
          if (res.ok) {
            paths.push(res.path)
            continue
          }
          console.warn('[AgentToolExecutor] saveFromUrl failed, falling back to base64:', res.reason)
          // Fall through to the base64 path (works for data: URLs / same-origin).
        }
        const decoded = await this.toBase64(uri)
        if (!decoded) continue
        const ext = decoded.mime === 'image/jpeg' ? 'jpg' : decoded.mime.split('/')[1] || 'png'
        const res = await api.save({
          threadId,
          name: `${base}-${stamp}${suffix}.${ext}`,
          mime: decoded.mime,
          base64: decoded.base64,
        })
        if (res.ok) paths.push(res.path)
      } catch (error) {
        console.error('[AgentToolExecutor] failed to save codex image to file panel:', error)
      }
    }
    return paths
  }

  /** Normalize a dataURL or http(s) image URL to `{ mime, base64 }`. */
  private async toBase64(uri: string): Promise<{ mime: string; base64: string } | null> {
    if (uri.startsWith('data:')) {
      // We only expect base64-encoded data URLs from the image API.
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri)
      if (!match) return null
      return { mime: match[1] || 'image/png', base64: match[2] ?? '' }
    }
    try {
      const res = await fetch(uri)
      if (!res.ok) return null
      const blob = await res.blob()
      const buf = await blob.arrayBuffer()
      const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png'
      return { mime, base64: this.bufferToBase64(buf) }
    } catch {
      return null
    }
  }

  private bufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
  }

  private async queryHistory(params: QueryHistoryToolParams): Promise<unknown> {
    const history = ServiceRegistry.getRequired<HistoryDataService>(SERVICE_KEYS.HISTORY_DATA)
    await history.init()

    const query = typeof params.query === 'string' ? params.query.trim() : ''
    const requestedLimit = typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.floor(params.limit)
      : DEFAULT_HISTORY_LIMIT
    const limit = Math.min(Math.max(requestedLimit, 1), MAX_HISTORY_LIMIT)
    const items = query ? history.search(query) : history.getAll()
    // Return a LEAN, base64-free projection. History records can hold multi-MB
    // base64 data URLs (codex images persist as base64 first, upload to R2/COS
    // only asynchronously); shipping those whole made this tool slow to
    // serialize over IPC→MCP→Codex AND blew past Codex's ~10 KiB / 256-line
    // tool-result cap (openai/codex#6544), so the model received a chopped,
    // unparseable blob. Strip every data: URL and oversized field here.
    return items.slice(0, limit).map((item) => this.slimHistoryItem(item as unknown as Record<string, unknown>))
  }

  /** Project a history record to a small, base64-free summary safe to hand to the agent. */
  private slimHistoryItem(item: Record<string, unknown>): Record<string, unknown> {
    const isLight = (u: unknown): u is string =>
      typeof u === 'string' && u.length > 0 && !u.startsWith('data:')
    const urls = Array.isArray(item.urls) ? item.urls.filter(isLight) : []
    const imageUrl = isLight(item.imageUrl) ? (item.imageUrl as string) : undefined
    const imageCount = Array.isArray(item.urls)
      ? item.urls.length
      : Array.isArray(item.images)
        ? item.images.length
        : imageUrl
          ? 1
          : 0
    return {
      id: item.id,
      type: item.type,
      prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 300) : undefined,
      model: item.model,
      ratio: item.ratio,
      timestamp: item.timestamp,
      imageCount,
      // Only http(s)/file URLs — never base64. May be empty if images are still
      // uploading; that's fine, the count above still tells the agent it exists.
      urls: urls.slice(0, 4),
      ...(imageUrl ? { imageUrl } : {}),
      uploading: item.uploading === true ? true : undefined,
    }
  }

  /**
   * Blob URLs created for the previous `open_image_viewer` call. The vanilla
   * ImageViewer never revokes its srcs, so we revoke the prior batch when the
   * agent opens a new one — the old modal is closed/replaced at that point.
   */
  private viewerBlobUrls: string[] = []

  private async openImageViewer(
    params: OpenImageViewerToolParams,
  ): Promise<{ opened: true; count: number; skipped?: number }> {
    const urls = this.parseUrls(params.urls)
    const startIndex = typeof params.startIndex === 'number' ? params.startIndex : 0
    const viewer = ServiceRegistry.get<ImageViewer>(SERVICE_KEYS.IMAGE_VIEWER)
    if (!viewer) throw new Error('Image viewer is not ready yet')
    // The agent routinely passes LOCAL paths (director_capture / generate_image
    // saves under %APPDATA%). The sandboxed renderer cannot load those via
    // `<img src>` (nor file://) — resolve to blob: URLs through the same
    // attachments IPC the chat Lightbox uses; web/data/blob URLs pass through.
    const resolved = await Promise.all(
      urls.map((u) => resolveMediaSrcOnce(u, 'image', { fullFidelity: true })),
    )
    const displayable = resolved.filter((u): u is string => typeof u === 'string' && u.length > 0)
    if (displayable.length === 0) {
      throw new Error(
        'open_image_viewer: none of the provided URLs could be loaded (files missing or unsupported)',
      )
    }
    for (const old of this.viewerBlobUrls) URL.revokeObjectURL(old)
    this.viewerBlobUrls = displayable.filter((u) => u.startsWith('blob:'))
    const skipped = urls.length - displayable.length
    viewer.open(displayable, Math.min(startIndex, displayable.length - 1))
    return { opened: true, count: displayable.length, ...(skipped > 0 ? { skipped } : {}) }
  }

  private async navigatePage(params: NavigatePageToolParams): Promise<{ tab: string }> {
    if (typeof params.tab !== 'string' || !isTabName(params.tab)) {
      throw new Error('navigate_page requires a valid tab')
    }
    useTabStore.getState().switchTab(params.tab)
    return { tab: params.tab }
  }

  private parseUrls(value: unknown): string[] {
    if (typeof value === 'string' && value.length > 0) return [value]
    if (Array.isArray(value)) {
      const urls = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      if (urls.length > 0) return urls
    }
    throw new Error('open_image_viewer requires at least one image URL')
  }

  private getAgentApi(): AgentApiBridge {
    const agent = getAgentApi()
    if (!agent) throw new Error('Electron agent API is unavailable')
    return agent
  }
}

/**
 * 提示词的精确字符串替换。照 Claude Code 的 Edit 工具:精确匹配、不做正则、
 * 要求全文唯一。歧义时拒绝而不是猜 —— 改错一个词不会像代码那样编译失败，
 * 会安静地生成一条错的视频，而那是要花钱的。
 */
export function patchPromptText(
  prompt: string,
  oldText: string,
  newText: string,
): { ok: true; prompt: string } | { ok: false; count: number } {
  if (!oldText) return { ok: false, count: 0 }
  // split 计数而不是正则:提示词里括号/点/星号是常态，当成正则会误伤。
  const parts = prompt.split(oldText)
  const count = parts.length - 1
  if (count !== 1) return { ok: false, count }
  return { ok: true, prompt: parts[0] + newText + parts[1] }
}

export function mountAgentToolExecutor(): () => void {
  return new AgentToolExecutor().start()
}
