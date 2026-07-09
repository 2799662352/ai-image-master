import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentInput } from '../types'

/**
 * `clientUserMessageId` passthrough — codex app-server v2:
 *
 *   turn/start:  { threadId, input, clientUserMessageId? }
 *   turn/steer:  { threadId, input, expectedTurnId, clientUserMessageId? }
 *
 * "clientUserMessageId is optional; when supplied, the corresponding
 *  userMessage item echoes it as clientId" (app-server README). We supply our
 * persisted AgentMessage row id so the rollout's userMessage items can be
 * reconciled back to our DB rows (dedupe on resume/reconnect).
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
      } else if (msg.method === 'turn/start') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }))
      } else if (msg.method === 'turn/steer') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn-1' } }))
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

function textInput(text: string, clientUserMessageId?: string): AgentInput {
  return { items: [{ type: 'text', text }], clientUserMessageId } as unknown as AgentInput
}

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('CodexProtocolClient clientUserMessageId passthrough', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('turn/start carries clientUserMessageId when the input provides one', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    const iterator = client.send('thread-A', textInput('hi', 'msg_abc123'))[Symbol.asyncIterator]()
    void iterator.next()
    await waitUntil(() => server!.receivedFromClient.some((m) => m.method === 'turn/start'))

    const turnStart = server.receivedFromClient.find((m) => m.method === 'turn/start')
    expect(turnStart?.params.clientUserMessageId).toBe('msg_abc123')
  })

  it('turn/start omits the field entirely when no id is supplied (older binaries reject unknown nulls)', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    const iterator = client.send('thread-B', textInput('hi'))[Symbol.asyncIterator]()
    void iterator.next()
    await waitUntil(() => server!.receivedFromClient.some((m) => m.method === 'turn/start'))

    const turnStart = server.receivedFromClient.find((m) => m.method === 'turn/start')
    expect('clientUserMessageId' in turnStart!.params).toBe(false)
  })

  it('turn/steer carries clientUserMessageId alongside expectedTurnId', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    const iterator = client.send('thread-C', textInput('start'))[Symbol.asyncIterator]()
    void iterator.next()
    await waitUntil(() => server!.receivedFromClient.some((m) => m.method === 'turn/start'))

    await client.steer('thread-C', textInput('interject', 'msg_steer42'))

    const steerMsg = server.receivedFromClient.find((m) => m.method === 'turn/steer')
    expect(steerMsg?.params.clientUserMessageId).toBe('msg_steer42')
    expect(steerMsg?.params.expectedTurnId).toBe('turn-1')
  })
})
