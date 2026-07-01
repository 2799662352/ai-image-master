import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentInput } from '../types'

interface FakeCodexServer {
  url: string
  receivedFromClient: any[]
  close: () => Promise<void>
}

// Minimal app-server fake that responds to initialize / turn/start / turn/steer.
// turn/start deliberately does NOT stream a turn_completed so the turn stays
// "active", which is the precondition turn/steer requires.
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

function textInput(text: string): AgentInput {
  return { items: [{ type: 'text', text }] } as unknown as AgentInput
}

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('CodexProtocolClient.steer (turn/steer)', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('rejects when there is no active turn on the thread', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    await expect(client.steer('no-such-thread', textInput('hi'))).rejects.toThrow(/no active turn/i)
  })

  it('sends turn/steer with the active turnId as expectedTurnId', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    // Kick off a turn (registers turnIdByThread) but never await completion —
    // the fake server keeps the turn open.
    const iterator = client.send('thread-A', textInput('start'))[Symbol.asyncIterator]()
    void iterator.next()
    await waitUntil(() => server!.receivedFromClient.some((m) => m.method === 'turn/start'))

    const acceptedTurnId = await client.steer('thread-A', textInput('actually, focus on failing tests'))
    expect(acceptedTurnId).toBe('turn-1')

    const steerMsg = server.receivedFromClient.find((m) => m.method === 'turn/steer')
    expect(steerMsg?.params.threadId).toBe('thread-A')
    expect(steerMsg?.params.expectedTurnId).toBe('turn-1')
    expect(steerMsg?.params.input).toEqual([
      { type: 'text', text: 'actually, focus on failing tests', text_elements: [] },
    ])
  })
})
