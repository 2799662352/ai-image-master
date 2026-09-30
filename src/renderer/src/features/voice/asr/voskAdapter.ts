// src/renderer/src/features/voice/asr/voskAdapter.ts
/**
 * Vosk 离线识别(对应 Shinsekai `ai/asr/asr_adapter.py::VoskAdapter`,同一个中文小模型)。
 *
 * 引擎是 vosk-browser 的 WASM 版,跑在它自己的 Worker 里;模型包由主进程准备好,
 * 经 `voice-model://` 交给 Worker,解开后缓存在 IndexedDB。pause 只是停止喂数据,
 * 麦克风保持打开(与原版暂停时不关 pyaudio 流一致)。
 */

import type { Model, KaldiRecognizer } from 'vosk-browser'
import { AsrAdapter, type TranscriptionCallback } from './asrAdapter'

const SAMPLE_RATE = 16000
const CHUNK_SIZE = 4096
/** finish 时等最后一句结果的上限;引擎迟迟不回就按已有中间结果收尾。 */
const FINAL_RESULT_TIMEOUT_MS = 1500

let modelPromise: Promise<Model> | null = null

export interface VoskModelSource {
  /** 确保模型在本地并返回 Worker 能取到的固定 URL。 */
  resolveModelUrl: () => Promise<string>
}

function loadModel(source: VoskModelSource): Promise<Model> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const [{ createModel }, url] = await Promise.all([import('vosk-browser'), source.resolveModelUrl()])
      return createModel(url, -1)
    })()
    modelPromise.catch(() => {
      modelPromise = null
    })
  }
  return modelPromise
}

interface Capture {
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  recognizer: KaldiRecognizer
}

export class VoskAdapter extends AsrAdapter {
  static async create(
    language: string,
    callback: TranscriptionCallback,
    source: VoskModelSource,
  ): Promise<VoskAdapter> {
    return new VoskAdapter(language, callback, await loadModel(source))
  }

  private capture: Capture | null = null
  private running = false
  private paused = false
  private captureError: unknown = null
  private pendingFinal: (() => void) | null = null

  private constructor(
    language: string,
    callback: TranscriptionCallback,
    private readonly model: Model,
  ) {
    super(language, callback)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.captureError = null
    this.paused = false
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: SAMPLE_RATE },
    })
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    const recognizer = new this.model.KaldiRecognizer(SAMPLE_RATE)
    recognizer.on('result', (message) => {
      if (message.event !== 'result') return
      const text = message.result.text
      if (text) this.callback(text, false)
      this.pendingFinal?.()
    })
    recognizer.on('partialresult', (message) => {
      if (message.event !== 'partialresult') return
      const partial = message.result.partial
      if (partial) this.callback(partial, true)
    })
    recognizer.on('error', (message) => {
      if (message.event === 'error') this.captureError = new Error(message.error)
    })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(CHUNK_SIZE, 1, 1)
    processor.onaudioprocess = (event) => {
      if (!this.running || this.paused) return
      try {
        recognizer.acceptWaveform(event.inputBuffer)
      } catch (error) {
        this.captureError = error
      }
    }
    source.connect(processor)
    // ScriptProcessor 只有接到 destination 才会被调度;它不写输出,接上也不会回放麦克风。
    processor.connect(context.destination)
    this.capture = { stream, context, source, processor, recognizer }
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
    const capture = this.capture
    this.capture = null
    if (!capture) return
    capture.processor.onaudioprocess = null
    capture.source.disconnect()
    capture.processor.disconnect()
    for (const track of capture.stream.getTracks()) track.stop()
    capture.recognizer.remove()
    await capture.context.close().catch(() => undefined)
  }

  getStatus(): string {
    return this.running ? 'Running' : 'Stopped'
  }

  async finish(): Promise<void> {
    const capture = this.capture
    if (capture && this.running) {
      this.paused = true
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, FINAL_RESULT_TIMEOUT_MS)
        function done(): void {
          clearTimeout(timer)
          resolve()
        }
        this.pendingFinal = done
        capture.recognizer.retrieveFinalResult()
      })
      this.pendingFinal = null
    }
    await this.stop()
    if (this.captureError) {
      throw new Error('Vosk 没能完成这段语音的识别', { cause: this.captureError })
    }
  }

  pause(): void {
    if (this.running) this.paused = true
  }

  resume(): void {
    if (this.running) this.paused = false
  }
}
