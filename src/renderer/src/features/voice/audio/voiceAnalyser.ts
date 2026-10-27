// src/renderer/src/features/voice/audio/voiceAnalyser.ts
/**
 * 人声 → 口型开合(对应 Shinsekai `chat-stage/audio/voiceAnalyser.ts`)。
 * 只有人声经过这里;暂停、缓冲、结束、出错都会把口型归零。
 */

export type MouthListener = (characterName: string, value: number) => void

const RESET_EVENTS = ['pause', 'waiting', 'stalled', 'ended', 'error'] as const

export class VoiceAnalyser {
  private context: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private frame = 0
  private generation = 0
  private stopCurrent: (() => void) | null = null

  constructor(private readonly listener: MouthListener) {}

  start(audio: HTMLAudioElement, characterName: string): void {
    this.stop()
    if (!characterName || typeof AudioContext === 'undefined') return
    const generation = ++this.generation
    try {
      this.context ??= new AudioContext()
      const source = this.context.createMediaElementSource(audio)
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyser.connect(this.context.destination)
      this.source = source
      this.analyser = analyser
      const samples = new Float32Array(analyser.fftSize)
      let smooth = 0
      let stalled = false
      const reset = () => {
        stalled = true
        smooth = 0
        this.listener(characterName, 0)
      }
      const resume = () => {
        stalled = false
      }
      for (const type of RESET_EVENTS) audio.addEventListener(type, reset)
      audio.addEventListener('playing', resume)
      this.stopCurrent = () => {
        for (const type of RESET_EVENTS) audio.removeEventListener(type, reset)
        audio.removeEventListener('playing', resume)
        this.listener(characterName, 0)
      }
      const tick = () => {
        if (generation !== this.generation) return
        if (!stalled && !audio.paused && !audio.ended && this.context?.state === 'running') {
          analyser.getFloatTimeDomainData(samples)
          const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
          const target = Math.min(1, Math.max(0, (rms - 0.01) * 8)) * audio.volume
          smooth += (target - smooth) * (target > smooth ? 0.65 : 0.25)
          this.listener(characterName, smooth)
        } else {
          smooth = 0
          this.listener(characterName, 0)
        }
        this.frame = requestAnimationFrame(tick)
      }
      void this.context
        .resume()
        .then(() => {
          if (generation === this.generation) tick()
        })
        .catch(() => {
          if (generation === this.generation) this.stop()
        })
    } catch {
      // 不支持 WebAudio 时照常播放,只是没有口型。
      this.stop()
    }
  }

  stop(): void {
    ++this.generation
    cancelAnimationFrame(this.frame)
    this.stopCurrent?.()
    this.stopCurrent = null
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.source = null
    this.analyser = null
  }

  dispose(): void {
    this.stop()
    void this.context?.close()
    this.context = null
  }
}
