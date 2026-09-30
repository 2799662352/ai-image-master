// src/renderer/src/features/voice/tts/ttsGeneration.ts
/**
 * 一条回复 → 按播放顺序产出的音频(对应 Shinsekai
 * `dialog_media/tts_generation.py::DefaultTtsGenerationStrategy`)。
 * 调用方拿到一段就交给播放队列再要下一段,于是播第 n 句时第 n+1 句已经在合成。
 */

import type { GeneratedSpeech } from './ttsAdapter'
import type { TtsManager } from './ttsManager'
import { splitSentences } from './speechText'

export interface TtsGenerationRequest {
  text: string
  splitEnabled: boolean
  maxSentenceLength: number
  signal?: AbortSignal
}

export async function* generateSpeechPieces(
  manager: TtsManager,
  request: TtsGenerationRequest,
): AsyncGenerator<GeneratedSpeech> {
  const text = request.text.trim()
  if (!text) return
  const sentences = request.splitEnabled ? splitSentences(text, request.maxSentenceLength) : []
  if (sentences.length <= 1) {
    const speech = await manager.generateTts(text, request.signal)
    if (speech) yield speech
    return
  }
  for (const sentence of sentences) {
    const speech = await manager.generateTts(sentence, request.signal)
    // 中间某句失败就停在这里,不跳句接着念(与原版一致)。
    if (!speech) return
    yield speech
  }
}
