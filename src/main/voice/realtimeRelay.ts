// src/main/voice/realtimeRelay.ts
/**
 * 千问实时识别 / 合成的 WebSocket 中转。
 *
 * 渲染层的 WebSocket 设不了 Authorization,平台令牌也不出主进程,所以连接开在这里:
 * 按白名单开到网关 `/v1/realtime?model=…`,贴上平台凭据,JSON 事件原样双向转发。
 * 协议本身(session.update / append / finish …)全在渲染层的适配器里。
 *
 * 不 import electron:凭据、网关地址、消费上报都由 `ipc.ts` 注入,单测对着本地
 * WebSocket 服务端跑真握手。
 */

import WebSocket from 'ws'
import type { VoiceRealtimeMessage, VoiceRealtimeModel } from '../../types/voice'

export const VOICE_REALTIME_MODELS: readonly VoiceRealtimeModel[] = [
  'qwen3-asr-flash-realtime',
  'qwen3-tts-flash-realtime',
]

const HANDSHAKE_TIMEOUT_MS = 10_000
/** 握手被拒时读多少响应体来拼错误信息;网关的错误 JSON 远小于这个数。 */
const ERROR_BODY_LIMIT = 4096

export interface RealtimeRelayDeps {
  gatewayOrigin: () => string
  /** 平台凭据头;没有可用令牌时返回 null。 */
  platformHeaders: () => Record<string, string> | null
  /** 一条连接结束 —— 网关在这之前已按用量落账,余额该刷新了。 */
  onSpend: () => void
  handshakeTimeoutMs?: number
}

export type RealtimeSink = (message: VoiceRealtimeMessage) => void

interface Connection {
  owner: number
  ws: WebSocket
}

export function realtimeUrl(origin: string, model: string): string {
  const url = new URL('/v1/realtime', origin)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.searchParams.set('model', model)
  return url.toString()
}

function isRealtimeModel(model: string): model is VoiceRealtimeModel {
  return (VOICE_REALTIME_MODELS as readonly string[]).includes(model)
}

function gatewayErrorText(status: number | undefined, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    const error = parsed.error
    const message = typeof error === 'string' ? error : (error?.message ?? parsed.message)
    if (typeof message === 'string') detail = message
  } catch {
    detail = body.trim().slice(0, 200)
  }
  return `网关拒绝了实时语音连接(HTTP ${status ?? '?'})${detail ? `:${detail}` : ''}`
}

export class RealtimeRelay {
  private readonly connections = new Map<string, Connection>()
  private seq = 0

  constructor(private readonly deps: RealtimeRelayDeps) {}

  async open(owner: number, model: string, sink: RealtimeSink): Promise<string> {
    if (!isRealtimeModel(model)) throw new Error(`不支持的实时语音模型: ${model}`)
    const headers = this.deps.platformHeaders()
    if (!headers) throw new Error('平台余额未就绪:请先选择计费池')

    const id = `rt_${++this.seq}`
    const ws = new WebSocket(realtimeUrl(this.deps.gatewayOrigin(), model), {
      headers,
      handshakeTimeout: this.deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    })
    // 监听要在握手完成前挂好:握手响应里夹带的首条事件、以及握手后立刻的关闭,
    // 都会在 nextTick 里发出,早于 await 之后的续体。
    let opened = false
    let lastError = ''
    ws.once('open', () => {
      opened = true
    })
    ws.on('message', (data, isBinary) => {
      if (!isBinary) sink({ id, kind: 'event', data: data.toString() })
    })
    ws.on('error', (error) => {
      lastError = error.message
    })
    ws.on('close', (code, reason) => {
      if (!opened) return
      this.connections.delete(id)
      this.deps.onSpend()
      sink({ id, kind: 'closed', code, reason: reason.toString() || lastError })
    })
    this.connections.set(id, { owner, ws })

    try {
      await this.handshake(ws)
    } catch (error) {
      this.connections.delete(id)
      throw error
    }
    return id
  }

  private handshake(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      // 挂了这个事件,ws 就把拒绝交给我们处理:读完响应体再中止请求。
      ws.once('unexpected-response', (request, response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          if (body.length < ERROR_BODY_LIMIT) body += chunk
        })
        response.on('end', () => {
          reject(new Error(gatewayErrorText(response.statusCode, body)))
          request.destroy()
        })
      })
    })
  }

  /** 连接不在、不属于这个调用方或已不可写时返回 false。 */
  send(owner: number, id: string, data: string): boolean {
    const connection = this.connections.get(id)
    if (!connection || connection.owner !== owner) return false
    if (connection.ws.readyState !== WebSocket.OPEN) return false
    connection.ws.send(data)
    return true
  }

  close(owner: number, id: string): void {
    const connection = this.connections.get(id)
    if (!connection || connection.owner !== owner) return
    connection.ws.close(1000)
  }

  /** 页面销毁或刷新时收掉它开的全部连接。 */
  closeOwner(owner: number): void {
    for (const connection of this.connections.values()) {
      if (connection.owner === owner) connection.ws.close(1000)
    }
  }

  openCount(): number {
    return this.connections.size
  }
}
