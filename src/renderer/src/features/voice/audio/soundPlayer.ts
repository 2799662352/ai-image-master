// src/renderer/src/features/voice/audio/soundPlayer.ts
/**
 * 人声播放队列(对应 Shinsekai `chat-stage/audio/soundPlayer.ts` 的 voice 部分;
 * 背景音乐与音效这里用不上,没有搬)。一次只放一段,后来的排队;
 * 被浏览器拦下自动播放时进入 locked,由用户点一下 `unlock()` 放行。
 */

import { VoiceAnalyser, type MouthListener } from './voiceAnalyser'

export type SoundPlayerLockListener = (locked: boolean) => void
export type VoicePlaybackState = 'started' | 'finished' | 'interrupted' | 'failed'
export interface VoicePlaybackSignal {
  error?: string
  playbackId: string
  state: VoicePlaybackState
}
export type VoicePlaybackSignalListener = (signal: VoicePlaybackSignal) => void

type AudioFactory = (url: string) => HTMLAudioElement
type QueuedVoice = { playbackId: string; url: string; volume: number; characterName: string }
type ActiveVoice = QueuedVoice & { audio: HTMLAudioElement; started: boolean }

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1))
}

function isAutoplayBlock(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'NotAllowedError'
    : typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: unknown }).name === 'NotAllowedError'
}

function stopAudio(audio: HTMLAudioElement | null | undefined): void {
  if (!audio) return
  audio.pause()
  try {
    audio.currentTime = 0
  } catch {
    // 元数据还没加载时有的内核拒绝 seek。
  }
}

export class SoundPlayer {
  private readonly createAudio: AudioFactory
  private readonly analyser: VoiceAnalyser | null
  private currentVoice: ActiveVoice | null = null
  private readonly listeners = new Set<SoundPlayerLockListener>()
  private locked = false
  private readonly voiceQueue: QueuedVoice[] = []
  private readonly voiceSignalListeners = new Set<VoicePlaybackSignalListener>()

  constructor(createAudio: AudioFactory = (url) => new Audio(url), onMouth?: MouthListener) {
    this.createAudio = createAudio
    this.analyser = onMouth ? new VoiceAnalyser(onMouth) : null
  }

  subscribeLock(listener: SoundPlayerLockListener): () => void {
    this.listeners.add(listener)
    listener(this.locked)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeVoiceSignal(listener: VoicePlaybackSignalListener): () => void {
    this.voiceSignalListeners.add(listener)
    return () => {
      this.voiceSignalListeners.delete(listener)
    }
  }

  playVoice(playbackId: string, url: string, volume = 1, characterName = ''): void {
    const nextUrl = url.trim()
    if (!nextUrl) return
    const voice = { playbackId: playbackId.trim(), url: nextUrl, volume: clampVolume(volume), characterName }
    if (this.currentVoice) {
      this.voiceQueue.push(voice)
      return
    }
    this.startVoice(voice)
  }

  stopVoice(playbackId = ''): void {
    const targetId = playbackId.trim()
    if (targetId && this.currentVoice?.playbackId !== targetId) {
      const queuedIndex = this.voiceQueue.findIndex((voice) => voice.playbackId === targetId)
      if (queuedIndex >= 0) this.voiceQueue.splice(queuedIndex, 1)
      return
    }
    this.voiceQueue.length = 0
    this.analyser?.stop()
    stopAudio(this.currentVoice?.audio)
    this.currentVoice = null
  }

  async unlock(): Promise<void> {
    const audio = this.currentVoice?.audio
    if (!audio?.paused) return
    try {
      await this.play(audio)
      if (this.currentVoice?.audio === audio) this.markVoiceStarted(this.currentVoice)
      this.setLocked(false)
    } catch (error) {
      this.setLocked(isAutoplayBlock(error))
    }
  }

  dispose(): void {
    this.stopVoice()
    this.analyser?.dispose()
    this.listeners.clear()
    this.voiceSignalListeners.clear()
  }

  private startVoice(voice: QueuedVoice): void {
    const audio = this.createAudio(voice.url)
    audio.crossOrigin = 'anonymous'
    audio.preload = 'auto'
    audio.volume = voice.volume
    const activeVoice: ActiveVoice = { ...voice, audio, started: false }
    this.currentVoice = activeVoice
    audio.onended = () => this.finishVoice(activeVoice, 'finished')
    audio.onerror = () => this.finishVoice(activeVoice, 'failed', 'audio playback failed')
    this.requestPlay(
      audio,
      () => this.markVoiceStarted(activeVoice),
      (error) => this.finishVoice(activeVoice, 'failed', String(error)),
    )
  }

  private requestPlay(audio: HTMLAudioElement, onStarted?: () => void, onFailed?: (error: unknown) => void): void {
    void this.play(audio)
      .then(() => {
        this.setLocked(false)
        onStarted?.()
      })
      .catch((error) => {
        if (isAutoplayBlock(error)) {
          this.setLocked(true)
          return
        }
        onFailed?.(error)
      })
  }

  private play(audio: HTMLAudioElement): Promise<void> {
    try {
      return Promise.resolve(audio.play())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private setLocked(locked: boolean): void {
    if (this.locked === locked) return
    this.locked = locked
    for (const listener of this.listeners) listener(locked)
  }

  private markVoiceStarted(voice: ActiveVoice): void {
    if (this.currentVoice !== voice || voice.started) return
    voice.started = true
    this.analyser?.start(voice.audio, voice.characterName)
    this.emitVoiceSignal(voice.playbackId, 'started')
  }

  private finishVoice(voice: ActiveVoice, state: 'finished' | 'failed', error = ''): void {
    if (this.currentVoice !== voice) return
    this.currentVoice = null
    this.analyser?.stop()
    this.emitVoiceSignal(voice.playbackId, state, error)
    const next = this.voiceQueue.shift()
    if (next) this.startVoice(next)
  }

  private emitVoiceSignal(playbackId: string, state: VoicePlaybackState, error = ''): void {
    if (!playbackId) return
    const signal: VoicePlaybackSignal = { playbackId, state, ...(error ? { error } : {}) }
    for (const listener of this.voiceSignalListeners) listener(signal)
  }
}
