import type { GenerateImageParams, GenerateResult, UnderstandInput } from '../../services/api'
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import type { HistoryDataService } from '../history'
import type { ImageViewer } from '../image-viewer'
import { isTabName, useTabStore } from '../../stores/useTabStore'
import { useFileExplorerStore } from '../file-explorer/store'
import { useAgentChatStore } from './store'
import { recordCodexArtifact } from './codexArtifactPersistence'
import type { ArtifactSaveInfo, AttachmentRef, ChoiceAnswer, ChoiceOption } from '../../../../types/agent-timeline'
import type { AgentToolRequest, AgentToolResponse, ImageTaskUpdate } from '../../../../types/agent'
import { canvasBridge } from '../agent-workspace/canvas/canvasBridge'

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

/**
 * Default channel for the codex `generate_image` tool: the stable VIP channel.
 * (`gpt-image-2-codex` hit org-level rate limits; vip is the documented drop-in
 * with the same images API + size/quality params.)
 */
const CODEX_IMAGE_MODEL = 'gpt-image-2-vip'
const CODEX_DEFAULT_RESOLUTION = '2K'

/**
 * MCP-selectable image models. The agent MAY opt into one of these alternates
 * via the tool's `model` param; anything outside this allow-list (incl. a
 * hallucinated name) falls back to the default VIP channel so generation never
 * breaks. All three share the same ratio × resolution(1K/2K/4K) × quality
 * parameter surface, so the tool schema is identical regardless of choice.
 * - gpt-image-2-vip   : default, OpenAI 官逆，稳定
 * - custom-imagemodel-gt : 腾讯 image2（经 Miau 代理）
 * - wan2.7-image-pro  : 阿里万相 2.7 pro（超清/组图，经 Miau 代理）
 */
const MCP_SELECTABLE_IMAGE_MODELS: readonly string[] = [
  CODEX_IMAGE_MODEL,
  'custom-imagemodel-gt',
  'wan2.7-image-pro',
]

/** Resolve the agent-requested model to an allow-listed one (default = VIP). */
function resolveMcpImageModel(requested: unknown): string {
  return typeof requested === 'string' && MCP_SELECTABLE_IMAGE_MODELS.includes(requested)
    ? requested
    : CODEX_IMAGE_MODEL
}

type AgentElectronApi = {
  agent?: {
    onToolRequest: (callback: (request: AgentToolRequest) => void) => () => void
    sendToolResponse: (response: AgentToolResponse) => void
    sendImageTaskUpdate: (update: ImageTaskUpdate) => void
  }
  attachments?: {
    save: (args: {
      threadId: string
      name: string
      mime: string
      base64: string
    }) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    readThumb: (
      p: string,
    ) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }>
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

export class AgentToolExecutor {
  start(): () => void {
    const agent = this.getAgentApi()
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
      this.getAgentApi().sendToolResponse({ id: request.id, ok: true, result: { accepted: true, taskId } })
      void this.runImageTaskInBackground(request, taskId)
      return
    }

    const response = await this.execute(request)
    this.getAgentApi().sendToolResponse(response)
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
      this.getAgentApi().sendImageTaskUpdate(update)
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
      // Internal helpers (no MCP surface): driven by the understand_canvas_video
      // main-side orchestrator via router.call to read the selected canvas video
      // and write the understanding result back as a canvas note.
      case 'get_selected_canvas_video':
      case 'add_canvas_note':
        return this.callCanvas(toolName, params)
      case 'understand_video':
      case 'understand_document':
      case 'web_research':
        return this.callUnderstand(toolName, params)
      default:
        throw new Error(`Unknown renderer tool: ${toolName}`)
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
    return api.understand({ kind: 'document', mediaUrl: media.url, question }, { model })
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
    if (
      toolName === 'canvas_snapshot' ||
      toolName === 'get_canvas_image' ||
      toolName === 'get_canvas_video' ||
      toolName === 'save_snapshot'
    ) {
      // These persist an exported file as a thread-scoped attachment (FK on
      // threadId), so hand the bridge the active chat thread; without it the
      // image export is dropped (canvas_snapshot) / omitted (get_canvas_image) /
      // the get_canvas_video materialize fallback can't save a copy /
      // save_snapshot returns no imagePath.
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

  private async generateImage(params: GenerateImageToolParams, requestThreadId?: string): Promise<unknown> {
    const api = ServiceRegistry.getRequired<{ generateImage: (params: GenerateImageParams) => Promise<GenerateResult> }>(
      SERVICE_KEYS.API,
    )

    // Resolve reference images BEFORE showing the in-progress bubble. Codex
    // passes uploads-dir file PATHS (e.g. `C:\...\agent\uploads\<hash>.jpg`),
    // but the renderer's ApiService can only `fetch()` data:/http URLs — a raw
    // path becomes `data:image/jpeg;base64,C:\...` → ERR_INVALID_URL. We read
    // each path's bytes through the mime+size-gated attachments IPC and inline
    // it as a data URL. Doing this before `beginImageGeneration` keeps a bad
    // path from leaving a dangling "generating" bubble — it surfaces as a clean
    // explicit error to the agent instead. Only `await` when refs are actually
    // present so the no-ref (text-to-image) path still shows its in-progress
    // bubble synchronously.
    const referenceImages =
      Array.isArray(params.referenceImages) && params.referenceImages.length > 0
        ? await this.resolveReferenceImages(params.referenceImages)
        : undefined

    // Honor an allow-listed model selection (vip / 腾讯 image2 / 万相 2.7 pro);
    // any other value falls back to the stable VIP default.
    const model = resolveMcpImageModel(params.model)
    const request: GenerateImageParams = {
      ...params,
      referenceImages,
      model,
      resolution: params.resolution ?? CODEX_DEFAULT_RESOLUTION,
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
   * Batch render: fan out N single renders concurrently (each drives its OWN
   * "generating" bubble in the requesting chat, identical UX to before) and
   * fold the outcomes into one combined result. Uses `allSettled` so a partial
   * failure never sinks the whole batch — failures are reported per-index in the
   * combined banner main builds from this. The reference images / model / ratio
   * / resolution / quality apply to every prompt.
   */
  private async generateImages(
    params: GenerateImagesToolParams,
    requestThreadId?: string,
  ): Promise<ImageBatchResult> {
    const prompts = Array.isArray(params.prompts)
      ? params.prompts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : []
    if (prompts.length === 0) throw new Error('generate_images requires a non-empty prompts[]')

    const settled = await Promise.allSettled(
      prompts.map((prompt) =>
        this.generateImage(
          {
            prompt,
            model: params.model,
            ratio: params.ratio,
            resolution: params.resolution,
            quality: params.quality,
            referenceImages: params.referenceImages,
          } as unknown as GenerateImageToolParams,
          requestThreadId,
        ),
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
   * Normalize `referenceImages` into browser-loadable sources for ApiService.
   *
   * `data:`/`http(s):` entries pass through untouched. Anything else is treated
   * as a local filesystem path (codex hands us uploads-dir paths) and read via
   * the `attachments.readThumb` IPC — the renderer cannot `fetch()` a raw OS
   * path, and that channel is the right security scope (mime + size whitelist)
   * for a file the user/agent already produced in the uploads dir.
   *
   * Returns `undefined` for no refs (text-to-image). If refs were provided but
   * NONE could be read, throws an explicit error so the agent learns the path
   * was bad instead of the request silently degrading to text-to-image.
   */
  private async resolveReferenceImages(refs: unknown): Promise<string[] | undefined> {
    if (!Array.isArray(refs) || refs.length === 0) return undefined

    const api = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.attachments
    const resolved: string[] = []
    const failures: string[] = []

    for (const raw of refs) {
      if (typeof raw !== 'string' || raw.length === 0) continue
      if (raw.startsWith('data:') || raw.startsWith('http://') || raw.startsWith('https://')) {
        resolved.push(raw)
        continue
      }
      if (!api?.readThumb) {
        failures.push(`${raw} (attachments API unavailable)`)
        continue
      }
      const res = await api.readThumb(raw)
      if (res.ok) {
        resolved.push(`data:${res.mime};base64,${res.base64}`)
      } else {
        failures.push(`${raw} (${res.reason})`)
      }
    }

    if (resolved.length === 0 && failures.length > 0) {
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
        request.model ?? CODEX_IMAGE_MODEL,
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
      try {
        const decoded = await this.toBase64(images[i])
        if (!decoded) continue
        const suffix = images.length > 1 ? `-${i + 1}` : ''
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

  private openImageViewer(params: OpenImageViewerToolParams): { opened: true; count: number } {
    const urls = this.parseUrls(params.urls)
    const startIndex = typeof params.startIndex === 'number' ? params.startIndex : 0
    const viewer = ServiceRegistry.get<ImageViewer>(SERVICE_KEYS.IMAGE_VIEWER)
    if (!viewer) throw new Error('Image viewer is not ready yet')
    viewer.open(urls, startIndex)
    return { opened: true, count: urls.length }
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

  private getAgentApi(): NonNullable<AgentElectronApi['agent']> {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent) throw new Error('Electron agent API is unavailable')
    return agent
  }
}

export function mountAgentToolExecutor(): () => void {
  return new AgentToolExecutor().start()
}
