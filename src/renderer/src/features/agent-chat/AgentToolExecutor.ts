import type { GenerateImageParams, GenerateResult } from '../../services/api'
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import type { HistoryDataService } from '../history'
import type { ImageViewer } from '../image-viewer'
import { isTabName, useTabStore } from '../../stores/useTabStore'
import { useAgentChatStore } from './store'
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
const CODEX_DEFAULT_RESOLUTION = '1K'

type AgentElectronApi = {
  agent?: {
    onToolRequest: (callback: (request: AgentToolRequest) => void) => () => void
    sendToolResponse: (response: AgentToolResponse) => void
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
      const result = await this.call(request.toolName, request.params)
      return { id: request.id, ok: true, result }
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async call(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'generate_image':
        return this.generateImage(params as unknown as GenerateImageToolParams)
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

  private async generateImage(params: GenerateImageToolParams): Promise<unknown> {
    const api = ServiceRegistry.getRequired<{ generateImage: (params: GenerateImageParams) => Promise<GenerateResult> }>(
      SERVICE_KEYS.API,
    )

    // Force the stable VIP channel; ignore any model the agent passed.
    const request: GenerateImageParams = {
      ...params,
      model: CODEX_IMAGE_MODEL,
      resolution: params.resolution ?? CODEX_DEFAULT_RESOLUTION,
    }

    const result = await api.generateImage(request)
    if (!result.success) {
      throw new Error(result.error || 'Image generation failed')
    }

    const images = result.images ?? result.urls ?? []
    if (images.length === 0) {
      throw new Error('Image generation returned no images')
    }

    // Show the images as their own assistant bubble (thumbnail + lightbox).
    useAgentChatStore.getState().appendArtifactMessage(this.toArtifacts(images))

    // Persist to history under the 'codex' type (base64 → R2 handled inside).
    await this.recordHistory(request, images)

    // Return a COMPACT result to the agent — never echo multi-MB base64 back
    // into the model context (token blowup + useless to the agent).
    return { ok: true, count: images.length, model: CODEX_IMAGE_MODEL }
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

  private async recordHistory(request: GenerateImageParams, images: string[]): Promise<void> {
    try {
      const history = ServiceRegistry.get<HistoryDataService>(SERVICE_KEYS.HISTORY_DATA)
      if (!history) return
      await history.init()
      await history.addToHistory(
        'codex',
        request.prompt,
        images,
        request.ratio,
        CODEX_IMAGE_MODEL,
        request.referenceImages ? { referenceImages: request.referenceImages } : undefined,
      )
    } catch (error) {
      // History persistence is best-effort; never fail the generation over it.
      console.error('[AgentToolExecutor] failed to record codex image to history:', error)
    }
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
    return items.slice(0, limit)
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
