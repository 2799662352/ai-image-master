// src/renderer/src/features/voice/voiceStore.ts
/**
 * 语音输入 / 朗读的设置(持久化到 localStorage)与运行状态。
 * 默认值对齐 Shinsekai:长按说话关、分句关、分句上限 15 字;朗读默认关(花平台余额)。
 */

import { create } from 'zustand'
import type { VoiceModelProgress } from '../../../../types/voice'
import {
  DEFAULT_ASR_PROVIDER,
  DEFAULT_QWEN_VOICE,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_VOICE_PROMPT,
} from './voiceDefaults'

export interface VoiceSettings {
  asrProvider: string
  language: string
  holdToTalk: boolean
  /** 说完自动发出;关掉则识别结果只写进输入框,由用户自己点发送。 */
  autoSend: boolean
  /** 一句识别完后再等多久没有新话才算说完(持续收听模式)。 */
  sendDelayMs: number
  ttsEnabled: boolean
  ttsProvider: string
  ttsSplitEnabled: boolean
  ttsMaxSentenceLength: number
  /** 一条回复最多念多少字;超出按句子边界截断。 */
  ttsMaxChars: number
  /** 千问合成的系统音色。 */
  ttsVoice: string
  /** seed-audio 的声线描述。 */
  voicePrompt: string
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  asrProvider: DEFAULT_ASR_PROVIDER,
  language: 'zh',
  holdToTalk: false,
  autoSend: true,
  sendDelayMs: 2000,
  ttsEnabled: false,
  ttsProvider: DEFAULT_TTS_PROVIDER,
  ttsSplitEnabled: false,
  ttsMaxSentenceLength: 15,
  ttsMaxChars: 300,
  ttsVoice: DEFAULT_QWEN_VOICE,
  voicePrompt: DEFAULT_VOICE_PROMPT,
}

const STORAGE_KEY = 'catimation.voice.settings.v1'

export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof VoiceSettings, unknown>>
    const settings = { ...DEFAULT_VOICE_SETTINGS }
    for (const key of Object.keys(DEFAULT_VOICE_SETTINGS) as (keyof VoiceSettings)[]) {
      if (typeof parsed[key] === typeof DEFAULT_VOICE_SETTINGS[key]) {
        ;(settings as Record<string, unknown>)[key] = parsed[key]
      }
    }
    settings.ttsMaxSentenceLength = Math.max(1, Math.round(settings.ttsMaxSentenceLength))
    settings.ttsMaxChars = Math.max(1, Math.round(settings.ttsMaxChars))
    settings.sendDelayMs = Math.min(10_000, Math.max(0, Math.round(settings.sendDelayMs)))
    return settings
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS }
  }
}

function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 存不下只影响下次启动的默认值。
  }
}

export interface AsrRuntimeState {
  enabled: boolean
  loading: boolean
  running: boolean
}

export interface CommitPending {
  delayMs: number
  since: number
}

interface VoiceStore {
  settings: VoiceSettings
  asr: AsrRuntimeState
  /** 持续收听时一句已说完、正在等是否接着说。 */
  commitPending: CommitPending | null
  modelProgress: VoiceModelProgress | null
  speaking: boolean
  audioLocked: boolean
  error: string | null
  updateSettings: (patch: Partial<VoiceSettings>) => void
  setAsr: (state: AsrRuntimeState) => void
  setCommitPending: (pending: CommitPending | null) => void
  setModelProgress: (progress: VoiceModelProgress | null) => void
  setSpeaking: (speaking: boolean) => void
  setAudioLocked: (locked: boolean) => void
  setError: (error: string | null) => void
}

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  settings: loadVoiceSettings(),
  asr: { enabled: false, loading: false, running: false },
  commitPending: null,
  modelProgress: null,
  speaking: false,
  audioLocked: false,
  error: null,
  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch }
    saveVoiceSettings(settings)
    set({ settings })
  },
  setAsr: (asr) => set({ asr }),
  setCommitPending: (commitPending) => set({ commitPending }),
  setModelProgress: (modelProgress) => set({ modelProgress }),
  setSpeaking: (speaking) => set({ speaking }),
  setAudioLocked: (audioLocked) => set({ audioLocked }),
  setError: (error) => set({ error }),
}))
