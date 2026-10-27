// @vitest-environment node
import type { AddressInfo } from 'node:net'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { VoiceRealtimeMessage } from '../../../types/voice'
import { RealtimeRelay, realtimeUrl } from '../realtimeRelay'

interface FakeGateway {
  origin: string
  upgrades: IncomingMessage[]
  sockets: WebSocket[]
  received: string[]
  /** 置上后,握手以这个状态码和响应体拒绝。 */
  reject: { status: number; body: string } | null
  onConnection: (socket: WebSocket) => void
}

let server: Server
let wss: WebSocketServer
let gateway: FakeGateway

beforeEach(async () => {
  gateway = { origin: '', upgrades: [], sockets: [], received: [], reject: null, onConnection: () => undefined }
  server = createServer()
  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    gateway.upgrades.push(request)
    if (gateway.reject) {
      const { status, body } = gateway.reject
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      gateway.sockets.push(ws)
      ws.on('message', (data) => gateway.received.push(data.toString()))
      gateway.onConnection(ws)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  gateway.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function makeRelay(overrides: Partial<ConstructorParameters<typeof RealtimeRelay>[0]> = {}) {
  const onSpend = vi.fn()
  const relay = new RealtimeRelay({
    gatewayOrigin: () => gateway.origin,
    platformHeaders: () => ({ Authorization: 'Bearer pool-token', 'X-Project-Id': '7' }),
    onSpend,
    ...overrides,
  })
  return { relay, onSpend }
}

function collector() {
  const messages: VoiceRealtimeMessage[] = []
  return { messages, sink: (message: VoiceRealtimeMessage) => messages.push(message) }
}

describe('realtimeUrl', () => {
  it('maps the gateway origin onto the realtime websocket endpoint', () => {
    expect(realtimeUrl('https://miauapi.example', 'qwen3-asr-flash-realtime')).toBe(
      'wss://miauapi.example/v1/realtime?model=qwen3-asr-flash-realtime',
    )
    expect(realtimeUrl('http://127.0.0.1:3000', 'qwen3-tts-flash-realtime')).toBe(
      'ws://127.0.0.1:3000/v1/realtime?model=qwen3-tts-flash-realtime',
    )
  })
})

describe('RealtimeRelay', () => {
  it('opens only whitelisted models and only with a platform token', async () => {
    const { relay } = makeRelay()
    await expect(relay.open(1, 'gpt-realtime', () => undefined)).rejects.toThrow('不支持的实时语音模型')

    const noToken = makeRelay({ platformHeaders: () => null }).relay
    await expect(noToken.open(1, 'qwen3-asr-flash-realtime', () => undefined)).rejects.toThrow('请先选择计费池')
    expect(gateway.upgrades).toHaveLength(0)
  })

  it('carries the platform credentials and relays events both ways', async () => {
    gateway.onConnection = (ws) => ws.send(JSON.stringify({ type: 'session.created' }))
    const { relay } = makeRelay()
    const { messages, sink } = collector()

    const id = await relay.open(1, 'qwen3-asr-flash-realtime', sink)
    expect(gateway.upgrades[0].url).toBe('/v1/realtime?model=qwen3-asr-flash-realtime')
    expect(gateway.upgrades[0].headers.authorization).toBe('Bearer pool-token')
    expect(gateway.upgrades[0].headers['x-project-id']).toBe('7')

    // 握手后立刻发出的首条事件也不能丢。
    await vi.waitFor(() => expect(messages).toContainEqual({ id, kind: 'event', data: '{"type":"session.created"}' }))

    expect(relay.send(1, id, '{"type":"session.finish"}')).toBe(true)
    await vi.waitFor(() => expect(gateway.received).toEqual(['{"type":"session.finish"}']))
  })

  it('reports the gateway error body when the handshake is rejected', async () => {
    gateway.reject = { status: 503, body: JSON.stringify({ error: { message: '当前分组下没有可用渠道' } }) }
    const { relay, onSpend } = makeRelay()
    await expect(relay.open(1, 'qwen3-tts-flash-realtime', () => undefined)).rejects.toThrow(
      '网关拒绝了实时语音连接(HTTP 503):当前分组下没有可用渠道',
    )
    expect(relay.openCount()).toBe(0)
    expect(onSpend).not.toHaveBeenCalled()
  })

  it('announces the close and reports spend once the upstream ends the session', async () => {
    const { relay, onSpend } = makeRelay()
    const { messages, sink } = collector()
    const id = await relay.open(1, 'qwen3-tts-flash-realtime', sink)

    gateway.sockets[0].close(1000, 'session finished')
    await vi.waitFor(() =>
      expect(messages).toContainEqual({ id, kind: 'closed', code: 1000, reason: 'session finished' }),
    )
    expect(onSpend).toHaveBeenCalledTimes(1)
    expect(relay.openCount()).toBe(0)
    expect(relay.send(1, id, '{}')).toBe(false)
  })

  it('keeps connections private to the page that opened them', async () => {
    const { relay } = makeRelay()
    const mine = collector()
    const theirs = collector()
    const a = await relay.open(1, 'qwen3-asr-flash-realtime', mine.sink)
    const b = await relay.open(2, 'qwen3-asr-flash-realtime', theirs.sink)

    expect(relay.send(2, a, '{"type":"x"}')).toBe(false)
    relay.close(2, a)
    relay.closeOwner(1)
    await vi.waitFor(() => expect(mine.messages.some((m) => m.kind === 'closed')).toBe(true))
    expect(theirs.messages.some((m) => m.kind === 'closed')).toBe(false)
    expect(relay.send(2, b, '{"type":"y"}')).toBe(true)
  })
})
