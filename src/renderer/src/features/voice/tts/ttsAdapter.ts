// src/renderer/src/features/voice/tts/ttsAdapter.ts
/**
 * 朗读引擎接口(对应 Shinsekai `ai/tts/tts_adapter.py::TTSAdapter`)。
 * 引擎只负责「一句文本 → 一段可播放的音频」;重试、分句、排队都在上层。
 */

export interface GeneratedSpeech {
  /** 可直接交给 `<audio>` 的地址。 */
  url: string
  /** 播完后释放本地资源(Blob URL 等);远端地址不需要。 */
  release?: () => void
}

export interface SpeechRequest {
  text: string
  signal?: AbortSignal
}

export interface TtsVoiceInfo {
  /** 声线描述,如「一位年轻女性,用自然亲切的语气」(seed-audio 用)。 */
  voicePrompt?: string
  /** 引擎的系统音色名,如千问的 `Cherry`。 */
  voice?: string
}

export abstract class TtsAdapter {
  /** 引擎在设置页里需要的字段;没有就返回空对象。 */
  static configSchema(): Record<string, unknown> {
    return {}
  }

  /** 引擎需要预热时在这里等;默认立即可用。 */
  async waitUntilReady(): Promise<void> {}

  /** 没拿到音频时返回 null 或抛错,两种都由上层按失败重试。 */
  abstract generateSpeech(request: SpeechRequest): Promise<GeneratedSpeech | null>

  abstract switchModel(info: TtsVoiceInfo): void
}
