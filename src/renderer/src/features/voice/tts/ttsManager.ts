// src/renderer/src/features/voice/tts/ttsManager.ts
/**
 * 对应 Shinsekai `ai/tts/tts_manager.py::TTSManager.generate_tts`:
 * 同一句最多试两次,第二次前等 0.35 s;两次都没拿到音频就返回 null。
 */

import type { GeneratedSpeech, TtsAdapter, TtsVoiceInfo } from './ttsAdapter'

const ATTEMPTS = 2
const BACKOFF_MS = 350

export interface TtsManagerOptions {
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class TtsManager {
  private adapter: TtsAdapter | null = null
  private readonly sleep: (ms: number) => Promise<void>
  /** 最近一次失败的原因;成功后清空。 */
  lastError: string | null = null

  constructor(options: TtsManagerOptions = {}) {
    this.sleep = options.sleep ?? defaultSleep
  }

  setAdapter(adapter: TtsAdapter | null): void {
    this.adapter = adapter
  }

  switchModel(info: TtsVoiceInfo): void {
    this.adapter?.switchModel(info)
  }

  async generateTts(text: string, signal?: AbortSignal): Promise<GeneratedSpeech | null> {
    const adapter = this.adapter
    if (!adapter || !text.trim()) return null
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (signal?.aborted) return null
      try {
        const speech = await adapter.generateSpeech({ text, signal })
        if (speech?.url) {
          this.lastError = null
          return speech
        }
        this.lastError = '朗读引擎没有返回音频'
      } catch (error) {
        if (signal?.aborted) return null
        this.lastError = error instanceof Error ? error.message : String(error)
      }
      console.warn(`[voice] 朗读没拿到可用音频(第 ${attempt}/${ATTEMPTS} 次): ${this.lastError}`)
      if (attempt < ATTEMPTS) await this.sleep(BACKOFF_MS * attempt)
    }
    return null
  }
}
