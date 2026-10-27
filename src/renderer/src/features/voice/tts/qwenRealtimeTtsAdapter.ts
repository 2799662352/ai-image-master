// src/renderer/src/features/voice/tts/qwenRealtimeTtsAdapter.ts
/**
 * 千问实时合成(qwen3-tts-flash-realtime),经 Miau 网关按平台余额计费(按字符)。
 *
 * 一句话一条连接:session.update → append → commit → session.finish,把
 * `response.audio.delta` 拼成一个 mp3,收到 session.finished(或连接关闭)后交给播放器。
 * 分句流水线在上层,这里不做边收边播。
 */

import { TtsAdapter, type GeneratedSpeech, type SpeechRequest, type TtsVoiceInfo } from './ttsAdapter'
import type { OpenRealtime, RealtimeConnection, RealtimeEvent } from '../realtime/realtimeSocket'
import { DEFAULT_QWEN_VOICE } from '../voiceDefaults'

export const QWEN_TTS_MODEL = 'qwen3-tts-flash-realtime'

/** 系统音色(Qwen-TTS 音色列表里 qwen3-tts-flash-realtime 可用、中文表现好的几个)。 */
export const QWEN_TTS_VOICES: readonly { id: string; label: string }[] = [
  { id: 'Cherry', label: '芊悦 · 阳光亲切的女声' },
  { id: 'Serena', label: '苏瑶 · 温柔女声' },
  { id: 'Chelsie', label: '千雪 · 二次元女声' },
  { id: 'Momo', label: '茉兔 · 撒娇搞怪女声' },
  { id: 'Vivian', label: '十三 · 拽拽的可爱女声' },
  { id: 'Ethan', label: '晨煦 · 阳光男声' },
  { id: 'Moon', label: '月白 · 率性男声' },
  { id: 'Kai', label: '凯 · 低沉男声' },
]

/** 合成超过这个时间还没结束就放弃,交给上层重试。 */
const SYNTHESIS_TIMEOUT_MS = 30_000

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function eventError(event: RealtimeEvent): Error {
  const error = event.error as { message?: unknown; code?: unknown } | undefined
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error?.code ?? '未知错误')
  return new Error(`千问合成失败: ${message}`)
}

function abortError(): Error {
  return new DOMException('朗读已取消', 'AbortError')
}

export class QwenRealtimeTtsAdapter extends TtsAdapter {
  private voice: string

  constructor(
    private readonly open: OpenRealtime,
    voice: string = DEFAULT_QWEN_VOICE,
  ) {
    super()
    this.voice = voice || DEFAULT_QWEN_VOICE
  }

  switchModel(info: TtsVoiceInfo): void {
    if (info.voice) this.voice = info.voice
  }

  async generateSpeech({ text, signal }: SpeechRequest): Promise<GeneratedSpeech | null> {
    if (signal?.aborted) throw abortError()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let connection: RealtimeConnection | null = null
    let settled = false

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('千问合成超时')), SYNTHESIS_TIMEOUT_MS)
      const onAbort = (): void => fail(abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
      function finish(error?: Error): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      function fail(error: Error): void {
        finish(error)
        connection?.close()
      }

      this.open(QWEN_TTS_MODEL, {
        onEvent: (event) => {
          if (event.type === 'response.audio.delta' && typeof event.delta === 'string') {
            chunks.push(base64ToBytes(event.delta))
          } else if (event.type === 'error') {
            fail(eventError(event))
          } else if (event.type === 'session.finished') {
            finish()
            connection?.close()
          }
        },
        onClose: ({ reason }) => {
          if (chunks.length) finish()
          else finish(new Error(reason ? `千问合成连接已断开: ${reason}` : '千问合成没有返回音频'))
        },
      }).then(
        (opened) => {
          connection = opened
          if (settled) {
            opened.close()
            return
          }
          opened.send({
            type: 'session.update',
            session: {
              voice: this.voice,
              mode: 'server_commit',
              language_type: 'Chinese',
              response_format: 'mp3',
              sample_rate: 24000,
            },
          })
          opened.send({ type: 'input_text_buffer.append', text })
          opened.send({ type: 'input_text_buffer.commit' })
          opened.send({ type: 'session.finish' })
        },
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      )
    })

    await done
    if (!chunks.length) throw new Error('千问合成没有返回音频')
    const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }))
    return { url, release: () => URL.revokeObjectURL(url) }
  }
}
