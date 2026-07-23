import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

/**
 * Cross-session memory RPCs (EXPERIMENTAL, app-server v2 — verified against
 * openai/codex rust-v0.145.0 `client_request_definitions!` @ common.rs):
 *
 *   thread/memoryMode/set:  { threadId, mode: "enabled"|"disabled" }  →  {}
 *   memory/reset:           params is `Option<()>` with
 *                           `skip_serializing_if = "Option::is_none"` —
 *                           the request must OMIT the params key    →  {}
 *
 * Both carry `#[experimental(...)]`, so they require the client to have
 * announced `capabilities.experimentalApi` at initialize (the same gate as
 * collaborationMode/list — production AgentManager already opts in).
 */

interface FakeCodexServer {
  url: string
  receivedFromClient: any[]
  close: () => Promise<void>
}

async function startFakeCodexServer(): Promise<FakeCodexServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  const received: any[] = []
  let activeSocket: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      received.push(msg)
      if (msg.id === undefined) return
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      } else if (msg.method === 'thread/memoryMode/set' || msg.method === 'memory/reset') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    receivedFromClient: received,
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

describe('CodexProtocolClient memory RPCs', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('setThreadMemoryMode sends thread/memoryMode/set with camelCase params', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    const result = await client.setThreadMemoryMode({ threadId: 'thread-1', mode: 'disabled' })

    const request = server.receivedFromClient.find((m) => m.method === 'thread/memoryMode/set')
    expect(request?.params).toEqual({ threadId: 'thread-1', mode: 'disabled' })
    expect(result).toEqual({})
  })

  it('setThreadMemoryMode round-trips the enabled mode too', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    await client.setThreadMemoryMode({ threadId: 'thread-2', mode: 'enabled' })

    const request = server.receivedFromClient.find((m) => m.method === 'thread/memoryMode/set')
    expect(request?.params).toEqual({ threadId: 'thread-2', mode: 'enabled' })
  })

  it('resetMemory sends memory/reset with the params key omitted entirely', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    const result = await client.resetMemory()

    const request = server.receivedFromClient.find((m) => m.method === 'memory/reset')
    expect(request).toBeDefined()
    // Upstream deserializes params as `Option<()>` — `{}` would be rejected,
    // so the wire payload must not contain a params key at all.
    expect('params' in request!).toBe(false)
    expect(result).toEqual({})
  })

  it('resetMemory surfaces server errors', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    const port = (wss.address() as AddressInfo).port
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        if (msg.id === undefined) return
        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
          }))
        } else {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32600, message: 'memory feature is disabled' },
          }))
        }
      })
    })
    client = new CodexProtocolClient({
      url: `ws://127.0.0.1:${port}`,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    await expect(client.resetMemory()).rejects.toThrow(/memory feature is disabled/)
    await client.stop()
    client = null
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })
})
