// src/renderer/src/features/voice/asr/asrRegistry.ts
/**
 * 识别引擎注册表(对应 Shinsekai `ASRAdapterFactory._adapters`):内置千问实时识别与
 * Vosk 离线识别,其它引擎用 `registerAsrAdapter` 写进同一张表。
 */

import type { AsrAdapter, TranscriptionCallback } from './asrAdapter'
import { VoskAdapter, type VoskModelSource } from './voskAdapter'
import { QwenRealtimeAsrAdapter } from './qwenRealtimeAsrAdapter'
import { openDesktopRealtime } from '../realtime/realtimeSocket'
import { DEFAULT_ASR_PROVIDER, QWEN_ASR_PROVIDER, VOSK_ASR_PROVIDER } from '../voiceDefaults'

export interface AsrAdapterOptions {
  /** 收听途中的错误;没有这个通道的引擎可以忽略。 */
  onFault?: (error: Error) => void
}

export type AsrAdapterFactory = (
  language: string,
  callback: TranscriptionCallback,
  options?: AsrAdapterOptions,
) => AsrAdapter | Promise<AsrAdapter>

export interface AsrProvider {
  id: string
  label: string
  factory: AsrAdapterFactory
}

const desktopVoskModel: VoskModelSource = {
  resolveModelUrl: async () => {
    const api = window.electronAPI?.voice
    if (!api) throw new Error('语音输入只在桌面客户端里可用')
    const result = await api.ensureAsrModel()
    if (!result.ok) throw new Error(result.error)
    return result.url
  },
}

const providers = new Map<string, AsrProvider>([
  [
    QWEN_ASR_PROVIDER,
    {
      id: QWEN_ASR_PROVIDER,
      label: '千问实时识别(平台余额)',
      factory: (language, callback, options) =>
        new QwenRealtimeAsrAdapter(language, callback, { open: openDesktopRealtime, onFault: options?.onFault }),
    },
  ],
  [
    VOSK_ASR_PROVIDER,
    {
      id: VOSK_ASR_PROVIDER,
      label: 'Vosk 离线识别(免费,首次下载约 44 MB)',
      factory: (language, callback) => VoskAdapter.create(language, callback, desktopVoskModel),
    },
  ],
])

function normalizeId(id: string): string {
  return id.trim().toLowerCase().replace(/-/g, '_')
}

export function registerAsrAdapter(provider: AsrProvider): void {
  const id = normalizeId(provider.id)
  if (!id) throw new Error('识别引擎需要非空 id')
  if (providers.has(id)) throw new Error(`识别引擎重复注册: ${id}`)
  providers.set(id, { ...provider, id })
}

export function asrProviders(): AsrProvider[] {
  return [...providers.values()]
}

/** 按设置里的引擎 id 建适配器;没注册的 id 回落到默认引擎(与原版一致)。 */
export function createAsrAdapter(
  providerId: string,
  language: string,
  callback: TranscriptionCallback,
  options?: AsrAdapterOptions,
): AsrAdapter | Promise<AsrAdapter> {
  const id = normalizeId(providerId || DEFAULT_ASR_PROVIDER)
  let provider = providers.get(id)
  if (!provider) {
    console.warn(`[voice] 识别引擎 ${id} 未注册,回落到 ${DEFAULT_ASR_PROVIDER}`)
    provider = providers.get(DEFAULT_ASR_PROVIDER)!
  }
  return provider.factory(language, callback, options)
}
