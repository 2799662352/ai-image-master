import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { CodexLocalBackend, mapServerNotification } from '../CodexLocalBackend'
import type { AgentStreamEvent } from '../../../types/agent'
import type { AgentInput } from '../types'

interface FakeServerOptions {
  autoCompleteTurn?: boolean
}

interface FakeServer {
  url: string
  receivedFromClient: any[]
  pushNotification: (method: string, params: any) => void
  pushServerRequest: (id: number, method: string, params?: any) => void
  socket: () => WebSocket | null
  close: () => Promise<void>
}

async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  const url = `ws://127.0.0.1:${port}`
  const received: any[] = []
  let activeSocket: WebSocket | null = null
  const autoComplete = opts.autoCompleteTurn ?? true

  const fake: FakeServer = {
    url,
    receivedFromClient: received,
    pushNotification(method, params) {
      activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    },
    pushServerRequest(id, method, params = {}) {
      activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    },
    socket: () => activeSocket,
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      received.push(msg)
      if (msg.method === 'initialize' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      } else if (msg.method === 'thread/start' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { thread: { id: 'fake-thread', preview: '', cwd: '/' } },
        }))
      } else if (msg.method === 'turn/start' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { turn: { id: 'fake-turn', status: 'running' } },
        }))
        if (autoComplete) {
          setImmediate(() => {
            fake.pushNotification('item/agentMessage/delta', { threadId: 'fake-thread', turnId: 'fake-turn', itemId: 'i1', delta: 'hel' })
            fake.pushNotification('item/agentMessage/delta', { threadId: 'fake-thread', turnId: 'fake-turn', itemId: 'i1', delta: 'lo' })
            fake.pushNotification('item/reasoning/textDelta', { threadId: 'fake-thread', turnId: 'fake-turn', itemId: 'i2', delta: 'thinking' })
            fake.pushNotification('turn/completed', { threadId: 'fake-thread', turn: { id: 'fake-turn', status: 'completed' } })
          })
        }
      } else if (msg.method === 'turn/interrupt' && msg.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
        setImmediate(() => {
          fake.pushNotification('turn/completed', { threadId: 'fake-thread', turn: { id: 'fake-turn', status: 'interrupted' } })
        })
      }
    })
  })

  return fake
}

const baseInput: AgentInput = {
  threadId: undefined,
  content: 'hi',
  attachments: [],
  model: 'gpt-5.4',
  cwd: '/tmp',
  items: [{ type: 'text', text: 'hi' }],
}

describe('mapServerNotification', () => {
  it('maps item/agentMessage/delta to message_delta', () => {
    expect(
      mapServerNotification('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hi' }),
    ).toEqual({ type: 'message_delta', threadId: 't', turnId: 'u', delta: 'hi' })
  })

  it('maps item/reasoning/textDelta to reasoning_delta', () => {
    expect(
      mapServerNotification('item/reasoning/textDelta', { threadId: 't', turnId: 'u', delta: 'r' }),
    ).toEqual({ type: 'reasoning_delta', threadId: 't', turnId: 'u', delta: 'r' })
  })

  it('also maps item/reasoning/summaryTextDelta to reasoning_delta', () => {
    expect(
      mapServerNotification('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', delta: 's' }),
    ).toEqual({ type: 'reasoning_delta', threadId: 't', turnId: 'u', delta: 's' })
  })

  it('maps turn/completed using turn.id for turnId', () => {
    expect(
      mapServerNotification('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } }),
    ).toEqual({ type: 'turn_completed', threadId: 't', turnId: 'u' })
  })

  it('maps error notifications to error events', () => {
    expect(
      mapServerNotification('error', { error: { message: 'kaboom' }, willRetry: false, threadId: 't', turnId: 'u' }),
    ).toEqual({ type: 'error', threadId: 't', turnId: 'u', error: 'kaboom' })
  })

  it('returns null for notifications we do not consume', () => {
    expect(mapServerNotification('account/updated', {})).toBeNull()
  })
})

describe('CodexLocalBackend (with a fake codex app-server)', () => {
  let server: FakeServer | null = null
  let backend: CodexLocalBackend | null = null

  afterEach(async () => {
    if (backend) {
      await backend.stop()
      backend = null
    }
    if (server) {
      await server.close()
      server = null
    }
  })

  it('send(undefined, input) emits thread_created then deltas in order', async () => {
    server = await startFakeServer()
    backend = new CodexLocalBackend({ wsUrl: server.url })
    await backend.start()

    const events: AgentStreamEvent[] = []
    for await (const event of backend.send(undefined, baseInput)) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'thread_created', threadId: 'fake-thread' },
      { type: 'message_delta', threadId: 'fake-thread', turnId: 'fake-turn', delta: 'hel' },
      { type: 'message_delta', threadId: 'fake-thread', turnId: 'fake-turn', delta: 'lo' },
      { type: 'reasoning_delta', threadId: 'fake-thread', turnId: 'fake-turn', delta: 'thinking' },
      { type: 'turn_completed', threadId: 'fake-thread', turnId: 'fake-turn' },
    ])

    const methodsCalled = server.receivedFromClient.map((m) => m.method)
    expect(methodsCalled).toContain('initialize')
    expect(methodsCalled).toContain('thread/start')
    expect(methodsCalled).toContain('turn/start')
  })

  it('send(existingThreadId, input) skips thread/start and does not emit thread_created', async () => {
    server = await startFakeServer()
    backend = new CodexLocalBackend({ wsUrl: server.url })
    await backend.start()

    const events: AgentStreamEvent[] = []
    for await (const event of backend.send('fake-thread', baseInput)) {
      events.push(event)
    }

    const methodsCalled = server.receivedFromClient.map((m) => m.method)
    expect(methodsCalled).not.toContain('thread/start')
    expect(events.find((e) => e.type === 'thread_created')).toBeUndefined()
    expect(events[0]).toEqual({ type: 'message_delta', threadId: 'fake-thread', turnId: 'fake-turn', delta: 'hel' })
    expect(events[events.length - 1]).toEqual({ type: 'turn_completed', threadId: 'fake-thread', turnId: 'fake-turn' })
  })

  it('cancel sends turn/interrupt with the active turnId and the iterable closes', async () => {
    server = await startFakeServer({ autoCompleteTurn: false })
    backend = new CodexLocalBackend({ wsUrl: server.url })
    await backend.start()

    const events: AgentStreamEvent[] = []
    const consumer = (async () => {
      for await (const event of backend!.send(undefined, baseInput)) {
        events.push(event)
      }
    })()

    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (server.receivedFromClient.some((m) => m.method === 'turn/start')) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(server.receivedFromClient.some((m) => m.method === 'turn/start')).toBe(true)

    await backend.cancel('fake-thread')
    await consumer

    const interruptCall = server.receivedFromClient.find((m) => m.method === 'turn/interrupt')
    expect(interruptCall).toBeDefined()
    expect(interruptCall.params).toEqual({ threadId: 'fake-thread', turnId: 'fake-turn' })
    expect(events.find((e) => e.type === 'turn_completed')).toBeDefined()
  })

  it('replies to server-initiated requests with a JSON-RPC response', async () => {
    server = await startFakeServer()
    backend = new CodexLocalBackend({ wsUrl: server.url })
    await backend.start()

    server.pushServerRequest(999, 'applyPatchApproval', {})

    const deadline = Date.now() + 1000
    let reply: any | undefined
    while (Date.now() < deadline) {
      reply = server.receivedFromClient.find((m) => m && m.id === 999 && m.method === undefined)
      if (reply) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(reply).toBeDefined()
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 999 })
    expect(reply.result !== undefined || reply.error !== undefined).toBe(true)
  })
})
