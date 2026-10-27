// src/renderer/src/features/voice/tts/ttsRegistry.ts
/**
 * 朗读引擎注册表(对应 Shinsekai `TTSAdapterFactory._adapters`):内置千问实时合成与
 * seed-audio,其它引擎用 `registerTtsAdapter` 写进同一张表。
 */

import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'
import type { TtsAdapter, TtsVoiceInfo } from './ttsAdapter'
import { SeedAudioTtsAdapter, type SpeechAudioApi } from './seedAudioTtsAdapter'
import { QwenRealtimeTtsAdapter } from './qwenRealtimeTtsAdapter'
import { openDesktopRealtime } from '../realtime/realtimeSocket'
import { QWEN_TTS_PROVIDER, SEED_AUDIO_TTS_PROVIDER } from '../voiceDefaults'

export type TtsAdapterFactory = (voice: TtsVoiceInfo) => TtsAdapter

export interface TtsProvider {
  id: string
  label: string
  factory: TtsAdapterFactory
}

const providers = new Map<string, TtsProvider>([
  [
    QWEN_TTS_PROVIDER,
    {
      id: QWEN_TTS_PROVIDER,
      label: '千问实时合成(平台余额)',
      factory: (voice) => new QwenRealtimeTtsAdapter(openDesktopRealtime, voice.voice),
    },
  ],
  [
    SEED_AUDIO_TTS_PROVIDER,
    {
      id: SEED_AUDIO_TTS_PROVIDER,
      label: '豆包音频(平台余额)',
      factory: (voice) =>
        new SeedAudioTtsAdapter(
          () => ServiceRegistry.getRequired<SpeechAudioApi>(SERVICE_KEYS.API),
          voice.voicePrompt,
        ),
    },
  ],
])

export function registerTtsAdapter(provider: TtsProvider): void {
  const id = provider.id.trim().toLowerCase()
  if (!id) throw new Error('朗读引擎需要非空 id')
  if (providers.has(id)) throw new Error(`朗读引擎重复注册: ${id}`)
  providers.set(id, { ...provider, id })
}

export function ttsProviders(): TtsProvider[] {
  return [...providers.values()]
}

export function createTtsAdapter(providerId: string, voice: TtsVoiceInfo): TtsAdapter {
  const provider = providers.get(providerId.trim().toLowerCase())
  if (!provider) {
    const supported = [...providers.keys()].join(', ')
    throw new Error(`不支持的朗读引擎 ${providerId},可选: ${supported}`)
  }
  return provider.factory(voice)
}
