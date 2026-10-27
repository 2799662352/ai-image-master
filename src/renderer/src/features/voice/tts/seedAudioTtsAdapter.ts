// src/renderer/src/features/voice/tts/seedAudioTtsAdapter.ts
/**
 * 内置朗读引擎:seed-audio-1.0,经 Miau 网关按平台余额计费(约 ¥1/分钟)。
 *
 * seed-audio 是「按场景描述出音频」的模型,不是纯 TTS,所以提示词要写清楚
 * 声线、逐字朗读、不加配乐音效。返回的 base64 只在本地转成 Blob URL 播放,
 * 不落音频库、不上传。
 */

import type { GenerateAudioParams, GenerateAudioResult } from '../../../services/api'
import { SEED_AUDIO_SITE_KEY } from '../../../services/api/ApiService'
import { TtsAdapter, type GeneratedSpeech, type SpeechRequest, type TtsVoiceInfo } from './ttsAdapter'
import { DEFAULT_VOICE_PROMPT } from '../voiceDefaults'

export interface SpeechAudioApi {
  generateAudio: (params: GenerateAudioParams) => Promise<GenerateAudioResult>
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg_opus: 'audio/ogg',
  opus: 'audio/ogg',
}

export function buildSpeechPrompt(voicePrompt: string, text: string): string {
  const voice = voicePrompt.trim() || DEFAULT_VOICE_PROMPT
  return `${voice},一字不差地朗读下面这段话,只有人声,不要背景音乐和音效:${text}`
}

function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class SeedAudioTtsAdapter extends TtsAdapter {
  private voicePrompt: string

  constructor(
    private readonly resolveApi: () => SpeechAudioApi,
    voicePrompt: string = DEFAULT_VOICE_PROMPT,
  ) {
    super()
    this.voicePrompt = voicePrompt
  }

  switchModel(info: TtsVoiceInfo): void {
    if (typeof info.voicePrompt === 'string') this.voicePrompt = info.voicePrompt
  }

  async generateSpeech({ text, signal }: SpeechRequest): Promise<GeneratedSpeech | null> {
    const result = await this.resolveApi().generateAudio({
      input: buildSpeechPrompt(this.voicePrompt, text),
      responseFormat: 'mp3',
      signal,
      siteKey: SEED_AUDIO_SITE_KEY,
    })
    if (!result?.success || !result.audioBase64) {
      throw new Error(result?.error || '朗读音频生成失败')
    }
    const type = MIME_BY_FORMAT[result.format || 'mp3'] ?? 'audio/mpeg'
    const url = URL.createObjectURL(new Blob([base64ToBytes(result.audioBase64)], { type }))
    return { url, release: () => URL.revokeObjectURL(url) }
  }
}
