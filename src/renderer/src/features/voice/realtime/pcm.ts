// src/renderer/src/features/voice/realtime/pcm.ts
/** 实时识别的麦克风采集:16 kHz 单声道 → 16 位 PCM(base64 是实时接口规定的传输格式)。 */

export const PCM_SAMPLE_RATE = 16000
/** 每块 128 ms;太小 IPC 次数多,太大中间结果出得慢。 */
export const PCM_CHUNK_SAMPLES = 2048
export const PCM_CHUNK_MS = (PCM_CHUNK_SAMPLES / PCM_SAMPLE_RATE) * 1000

export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

export interface SpeechGateOptions {
  /** 高于这个 RMS 算有人在说话;约 -38 dBFS。 */
  threshold?: number
  /** 最后一块响声之后继续送多久静音,让服务端 VAD 判出句尾。 */
  hangoverMs?: number
  /** 开口前预录多久,免得吞掉第一个字的起音。 */
  prerollMs?: number
  chunkMs?: number
}

/**
 * 静音门:实时识别按送上去的音频时长计费,麦克风常开时没人说话的那些秒不送。
 * 服务端只看到拼起来的音频流,门关着的间隙对它不存在。
 */
export class SpeechGate {
  private readonly threshold: number
  private readonly hangoverChunks: number
  private readonly prerollChunks: number
  private preroll: Float32Array[] = []
  private quietChunks = Number.POSITIVE_INFINITY

  constructor(options: SpeechGateOptions = {}) {
    const chunkMs = options.chunkMs ?? PCM_CHUNK_MS
    this.threshold = options.threshold ?? 0.012
    this.hangoverChunks = Math.ceil((options.hangoverMs ?? 1500) / chunkMs)
    this.prerollChunks = Math.ceil((options.prerollMs ?? 380) / chunkMs)
  }

  /** 喂一块采样,返回现在该送出去的块(可能为空,也可能连带预录)。 */
  push(chunk: Float32Array): Float32Array[] {
    const loud = rms(chunk) >= this.threshold
    const open = this.quietChunks < this.hangoverChunks
    if (loud) {
      this.quietChunks = 0
      if (open) return [chunk]
      const out = [...this.preroll, chunk]
      this.preroll = []
      return out
    }
    if (open) {
      this.quietChunks += 1
      return [chunk]
    }
    this.preroll.push(chunk)
    if (this.preroll.length > this.prerollChunks) this.preroll.shift()
    return []
  }

  reset(): void {
    this.preroll = []
    this.quietChunks = Number.POSITIVE_INFINITY
  }
}

export interface MicCapture {
  stop: () => Promise<void>
}

export type StartMicCapture = (onChunk: (samples: Float32Array) => void) => Promise<MicCapture>

export const startMicCapture: StartMicCapture = async (onChunk) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: PCM_SAMPLE_RATE },
  })
  const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(PCM_CHUNK_SAMPLES, 1, 1)
  processor.onaudioprocess = (event) => onChunk(new Float32Array(event.inputBuffer.getChannelData(0)))
  source.connect(processor)
  // ScriptProcessor 只有接到 destination 才会被调度;它不写输出,接上也不会回放麦克风。
  processor.connect(context.destination)
  return {
    stop: async () => {
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      for (const track of stream.getTracks()) track.stop()
      await context.close().catch(() => undefined)
    },
  }
}
