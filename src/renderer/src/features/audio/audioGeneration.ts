// src/renderer/src/features/audio/audioGeneration.ts
/**
 * 音频「生成 + 三级持久化」共享核心。
 *
 * AudioPage(用户手动出音频)与 AgentToolExecutor(codex MCP generate_audio)
 * 都走这一条路,保证两条入口的存储/播放语义完全一致:
 *   ① COS 桶(主持久层):跨设备、可分享、不失效;
 *   ② 本地文件(缓存/离线):播放走 local-file://,秒开;
 *   ③ base64(兜底):仅当 COS 和本地都失败时写进 IndexedDB,保证永不丢。
 *
 * 只负责「生成→持久化→落库(store.add)」,不碰任何 UI(pending 卡/toast/
 * 按钮态由调用方管)。返回结构体不抛异常。
 */

import type { GenerateAudioParams, GenerateAudioResult } from '../../services/api'
import { SEED_AUDIO_SITE_KEY } from '../../services/api/ApiService'
import type { AudioLibraryItem, AudioLibraryStore } from './AudioLibraryStore'

export interface AudioGenerationApi {
  generateAudio: (params: GenerateAudioParams) => Promise<GenerateAudioResult>
}

interface AudioHistoryStorageApi {
  save?: (base64: string, format: string) => Promise<
    { success: true; filePath: string } | { success: false; error: string }
  >
  uploadCos?: (base64: string, format: string) => Promise<
    { success: true; url: string; key: string } | { success: false; error: string }
  >
}

export interface GenerateAudioToLibraryInput {
  /** 自然语言场景描述(多角色/环境音/配乐)。 */
  prompt: string
  format?: 'mp3' | 'wav' | 'opus'
  /** OpenAI speed 0.25~4.0;省略=1。 */
  speed?: number
  /** 参考音频(URL 或 data:audio base64),风格融合,≤2。 */
  referenceAudios?: string[]
  signal?: AbortSignal
  /** 落库用的 id(AudioPage 传 pending 卡 id 以复用同一卡片;省略则自动生成)。 */
  id?: string
}

export type GenerateAudioToLibraryResult =
  | { success: true; item: AudioLibraryItem }
  | { success: false; error: string }

function getAudioHistoryStorage(): AudioHistoryStorageApi | undefined {
  return (window as unknown as { electronAPI?: { audioHistory?: AudioHistoryStorageApi } })
    .electronAPI?.audioHistory
}

function newAudioId(): string {
  return `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 生成一段音频并三级持久化 + 落库。api 由调用方注入(AudioPage 用
 * `window.aiImageAPI`,AgentToolExecutor 用 ServiceRegistry 的 ApiService),
 * store 是共享的 AudioLibraryStore 单例。
 */
export async function generateAudioToLibrary(
  input: GenerateAudioToLibraryInput,
  api: AudioGenerationApi,
  store: AudioLibraryStore,
): Promise<GenerateAudioToLibraryResult> {
  const prompt = input.prompt?.trim() ?? ''
  if (!prompt) return { success: false, error: '请先描述你想要的音频' }

  const format = input.format || 'mp3'
  const result = await api.generateAudio({
    input: prompt,
    responseFormat: format,
    speed: input.speed,
    referenceAudios: input.referenceAudios,
    signal: input.signal,
    siteKey: SEED_AUDIO_SITE_KEY,
  })

  if (!result?.success || !result.audioBase64) {
    return { success: false, error: result?.error || '音频生成失败' }
  }

  const effectiveFormat = result.format || format
  const storage = getAudioHistoryStorage()

  // ① COS 桶(主持久层)
  let remoteUrl: string | undefined = result.url
  if (storage?.uploadCos) {
    try {
      const uploaded = await storage.uploadCos(result.audioBase64, effectiveFormat)
      if (uploaded?.success) remoteUrl = uploaded.url
      else console.warn('[audioGeneration] COS 上传失败,依赖本地/降级:', (uploaded as { error?: string })?.error)
    } catch (e) {
      console.warn('[audioGeneration] COS 上传异常,依赖本地/降级:', e)
    }
  }

  // ② 本地文件(缓存/离线)
  let filePath: string | undefined
  if (storage?.save) {
    try {
      const saved = await storage.save(result.audioBase64, effectiveFormat)
      if (saved?.success) filePath = saved.filePath
      else console.warn('[audioGeneration] 落盘失败:', (saved as { error?: string })?.error)
    } catch (e) {
      console.warn('[audioGeneration] 落盘异常:', e)
    }
  }

  // ③ base64 兜底:仅当 COS 和本地都没有时才存,避免 IndexedDB 背大字节
  const needsBase64Fallback = !filePath && !remoteUrl
  const item: AudioLibraryItem = {
    id: input.id || newAudioId(),
    prompt,
    format: effectiveFormat,
    duration: result.duration ?? 0,
    billedSeconds: result.originalDuration ?? result.duration ?? 0,
    createdAt: Date.now(),
    ...(filePath ? { filePath } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(needsBase64Fallback ? { audioBase64: result.audioBase64 } : {}),
  }
  await store.add(item)
  return { success: true, item }
}
