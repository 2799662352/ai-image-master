// src/renderer/src/features/voice/asr/qwenRealtimeAsrAdapter.ts
/**
 * 千问实时识别(qwen3-asr-flash-realtime),经 Miau 网关按平台余额计费。
 *
 * 服务端 VAD 断句:中间结果是 `text`(已确认)+ `stash`(还会改的尾巴),每句的最终
 * 结果在 `…transcription.completed`。按住说话松手时发 `session.finish`,服务端把
 * 缓冲里剩下的音频识别完再回 `session.finished`。
 *
 * 暂停只是停止送音频,连接保持;等回复期间连接被服务端收掉的话,下次开口再连。
 */

import { AsrAdapter, type TranscriptionCallback } from './asrAdapter'
import type { OpenRealtime, RealtimeConnection, RealtimeEvent } from '../realtime/realtimeSocket'
import {
  PCM_SAMPLE_RATE,
  SpeechGate,
  pcm16Base64,
  startMicCapture,
  type MicCapture,
  type StartMicCapture,
} from '../realtime/pcm'

export const QWEN_ASR_MODEL = 'qwen3-asr-flash-realtime'
/** 松手后等最后一句结果的上限;网络慢时按已有中间结果收尾。 */
const FINISH_TIMEOUT_MS = 4000
/** 连接还没建好时最多攒多少块音频(约 13 秒)。 */
const QUEUE_LIMIT = 100

export interface QwenAsrOptions {
  open: OpenRealtime
  startCapture?: StartMicCapture
  gate?: SpeechGate
  /** 收听途中出的错(连接被拒、余额不足……);适配器接口本身没有报错的通道。 */
  onFault?: (error: Error) => void
}

function eventError(event: RealtimeEvent): Error {
  const error = event.error as { message?: unknown; code?: unknown } | undefined
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error?.code ?? event.type)
  return new Error(message)
}

export class QwenRealtimeAsrAdapter extends AsrAdapter {
  private readonly open: OpenRealtime
  private readonly startCapture: StartMicCapture
  private readonly gate: SpeechGate
  private readonly onFault?: (error: Error) => void
  private connection: RealtimeConnection | null = null
  private connecting: Promise<RealtimeConnection> | null = null
  private capture: MicCapture | null = null
  private running = false
  private paused = false
  private audioSent = false
  private error: Error | null = null
  private queue: string[] = []
  private sessionFinished: (() => void) | null = null

  constructor(language: string, callback: TranscriptionCallback, options: QwenAsrOptions) {
    super(language, callback)
    this.open = options.open
    this.startCapture = options.startCapture ?? startMicCapture
    this.gate = options.gate ?? new SpeechGate()
    this.onFault = options.onFault
  }

  async start(): Promise<void> {
    if (this.running) return
    this.error = null
    this.paused = false
    this.gate.reset()
    await this.connect()
    this.running = true
    try {
      this.capture = await this.startCapture((samples) => this.handleSamples(samples))
    } catch (error) {
      this.running = false
      this.closeConnection()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.running = false
    this.queue = []
    await this.stopCapture()
    this.closeConnection()
  }

  async finish(): Promise<void> {
    this.running = false
    await this.stopCapture()
    const connection = this.connection ?? (await this.connecting?.catch(() => null)) ?? null
    if (connection && this.audioSent) {
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          clearTimeout(timer)
          this.sessionFinished = null
          resolve()
        }
        const timer = setTimeout(settle, FINISH_TIMEOUT_MS)
        this.sessionFinished = settle
        connection.send({ type: 'session.finish' })
      })
    }
    this.queue = []
    this.closeConnection()
    if (this.error) throw new Error('千问实时识别没能完成这段语音', { cause: this.error })
  }

  getStatus(): string {
    return this.running ? 'Running' : 'Stopped'
  }

  pause(): void {
    if (!this.running) return
    this.paused = true
    this.gate.reset()
  }

  resume(): void {
    if (this.running) this.paused = false
  }

  private connect(): Promise<RealtimeConnection> {
    if (this.connection) return Promise.resolve(this.connection)
    if (this.connecting) return this.connecting
    let current: RealtimeConnection | null = null
    this.connecting = this.open(QWEN_ASR_MODEL, {
      onEvent: (event) => this.handleEvent(event),
      onClose: () => {
        if (current && this.connection === current) {
          this.connection = null
          this.audioSent = false
        }
        this.sessionFinished?.()
      },
    })
      .then((connection) => {
        current = connection
        connection.send({
          type: 'session.update',
          session: {
            input_audio_format: 'pcm',
            sample_rate: PCM_SAMPLE_RATE,
            input_audio_transcription: { language: this.language },
            turn_detection: { type: 'server_vad', threshold: 0.0, silence_duration_ms: 400 },
          },
        })
        this.connection = connection
        for (const audio of this.queue.splice(0)) this.append(connection, audio)
        return connection
      })
      .finally(() => {
        this.connecting = null
      })
    return this.connecting
  }

  private handleSamples(samples: Float32Array): void {
    if (!this.running || this.paused) return
    for (const chunk of this.gate.push(samples)) {
      const audio = pcm16Base64(chunk)
      if (this.connection) {
        this.append(this.connection, audio)
        continue
      }
      this.queue.push(audio)
      if (this.queue.length > QUEUE_LIMIT) this.queue.shift()
      this.connect().catch((error: unknown) => this.fault(error instanceof Error ? error : new Error(String(error))))
    }
  }

  private append(connection: RealtimeConnection, audio: string): void {
    connection.send({ type: 'input_audio_buffer.append', audio })
    this.audioSent = true
  }

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'conversation.item.input_audio_transcription.text': {
        const partial = `${typeof event.text === 'string' ? event.text : ''}${typeof event.stash === 'string' ? event.stash : ''}`
        if (partial) this.callback(partial, true)
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (typeof event.transcript === 'string' && event.transcript) this.callback(event.transcript, false)
        return
      }
      case 'conversation.item.input_audio_transcription.failed':
      case 'error':
        this.fault(eventError(event))
        return
      case 'session.finished':
        this.sessionFinished?.()
        return
    }
  }

  private fault(error: Error): void {
    this.error = error
    if (this.running) this.onFault?.(error)
  }

  private async stopCapture(): Promise<void> {
    const capture = this.capture
    this.capture = null
    await capture?.stop()
  }

  private closeConnection(): void {
    const connection = this.connection
    this.connection = null
    this.audioSent = false
    connection?.close()
  }
}
