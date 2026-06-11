import type { GenerateImageParams, GenerateResult } from '../../services/api'
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import type { HistoryDataService } from '../history'
import type { ImageViewer } from '../image-viewer'
import { isTabName, useTabStore } from '../../stores/useTabStore'
import { useAgentChatStore } from './store'
import { recordCodexArtifact } from './codexArtifactPersistence'
import type { AttachmentRef } from '../../../../types/agent-timeline'
import type { AgentToolRequest, AgentToolResponse } from '../../../../types/agent'

type GenerateImageToolParams = GenerateImageParams

/**
 * The codex `generate_image` tool always renders on the stable VIP channel,
 * regardless of the globally selected model. (`gpt-image-2-codex` hit
 * org-level rate limits; vip is the documented drop-in with the same images
 * API + size/quality params.)
 */
const CODEX_IMAGE_MODEL = 'gpt-image-2-vip'
const CODEX_DEFAULT_RESOLUTION = '2K'

type AgentElectronApi = {
  agent?: {
    onToolRequest: (callback: (request: AgentToolRequest) => void) => () => void
    sendToolResponse: (response: AgentToolResponse) => void
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

type QueryHistoryToolParams = {
  query?: unknown
  limit?: unknown
}

const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 100

export class AgentToolExecutor {
  start(): () => void {
    const agent = this.getAgentApi()
    return agent.onToolRequest((request) => {
      void this.handle(request)
    })
  }

  private async handle(request: AgentToolRequest): Promise<void> {
    const response = await this.execute(request)
    this.getAgentApi().sendToolResponse(response)
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
      case 'generate_image':
        return this.generateImage(params as unknown as GenerateImageToolParams, threadId)
      case 'query_history':
        return this.queryHistory(params as QueryHistoryToolParams)
      case 'open_image_viewer':
        return this.openImageViewer(params as OpenImageViewerToolParams)
      case 'navigate_page':
        return this.navigatePage(params as NavigatePageToolParams)
      default:
        throw new Error(`Unknown renderer tool: ${toolName}`)
    }
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

    // Force the stable VIP channel; ignore any model the agent passed.
    const request: GenerateImageParams = {
      ...params,
      referenceImages,
      model: CODEX_IMAGE_MODEL,
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

    // Persist to history under the 'codex' type (base64 → R2 handled inside).
    const historyId = await this.recordHistory(request, images)

    // Persist into the watched uploads dir so the image both shows in the
    // ATTACHMENTS file panel AND gives us a concrete local file path to hand
    // back to the agent. This replicates codex's native `image_gen`
    // generate→save→read contract: that tool always reports the final saved
    // path so the agent can view / move / reference the file. We await here (the
    // chat bubble + history already settled, so UX is unaffected) to capture the
    // paths; a save failure just yields an empty `paths` list.
    const threadId = reqThreadId
    const paths = threadId ? await this.saveToFilePanel(threadId, request.prompt, images) : []

    // Anchor the bubble to the history record so it survives reload /
    // thread-switch. History URLs are preferred when available, but they can
    // remain `pending:*` until async R2/COS upload settles. Store the tiny local
    // saved paths too, so reload/edit can still restore thumbnail + address.
    if (historyId != null && threadId) {
      recordCodexArtifact(threadId, {
        id: `codex-artifact-${historyId}`,
        createdAt: Date.now(),
        prompt: request.prompt,
        historyId,
        paths,
      })
    }

    // Return a COMPACT result to the agent — never echo multi-MB base64 back
    // into the model context (token blowup + useless to the agent). `paths`
    // (the saved local files) + `historyId` let the agent read/move/reference
    // the result exactly like native `image_gen` output.
    return {
      ok: true,
      count: images.length,
      model: CODEX_IMAGE_MODEL,
      historyId,
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
        CODEX_IMAGE_MODEL,
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
