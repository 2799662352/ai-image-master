import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { buildCodexSpawnEnv, CodexLocalBackend, mapServerNotification } from '../CodexLocalBackend'
import type { AgentStreamEvent, CodexApprovalRequest } from '../../../types/agent'
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
  it('maps item/agentMessage/delta to item_delta', () => {
    expect(
      mapServerNotification('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hi' }),
    ).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'i',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'hi' },
    })
  })

  it('maps item/reasoning/textDelta to item_delta (reasoning)', () => {
    expect(
      mapServerNotification('item/reasoning/textDelta', { threadId: 't', turnId: 'u', itemId: 'r', delta: 'r' }),
    ).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'r',
      itemType: 'reasoning',
      patch: { kind: 'appendText', field: 'content', text: 'r' },
    })
  })

  it('also maps item/reasoning/summaryTextDelta to item_delta (reasoning)', () => {
    expect(
      mapServerNotification('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'r', delta: 's' }),
    ).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'r',
      itemType: 'reasoning',
      patch: { kind: 'appendText', field: 'content', text: 's' },
    })
  })

  it('maps turn/completed using turn.id for turnId', () => {
    expect(
      mapServerNotification('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } }),
    ).toEqual({ type: 'turn_completed', threadId: 't', turnId: 'u' })
  })

  it('maps error notifications to error events', () => {
    expect(
      mapServerNotification('error', { error: { message: 'kaboom' }, willRetry: false, threadId: 't', turnId: 'u' }),
    ).toEqual({ type: 'error', threadId: 't', error: 'kaboom' })
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
      {
        type: 'item_delta',
        threadId: 'fake-thread',
        itemId: 'i1',
        itemType: 'text',
        patch: { kind: 'appendText', field: 'content', text: 'hel' },
      },
      {
        type: 'item_delta',
        threadId: 'fake-thread',
        itemId: 'i1',
        itemType: 'text',
        patch: { kind: 'appendText', field: 'content', text: 'lo' },
      },
      {
        type: 'item_delta',
        threadId: 'fake-thread',
        itemId: 'i2',
        itemType: 'reasoning',
        patch: { kind: 'appendText', field: 'content', text: 'thinking' },
      },
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
    expect(events[0]).toEqual({
      type: 'item_delta',
      threadId: 'fake-thread',
      itemId: 'i1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'hel' },
    })
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

  it('surfaces server-initiated requests and waits for an explicit approval response', async () => {
    const approvals: CodexApprovalRequest[] = []
    server = await startFakeServer()
    backend = new CodexLocalBackend({
      wsUrl: server.url,
      onApprovalRequest: (request) => approvals.push(request),
    })
    await backend.start()

    server.pushServerRequest(999, 'applyPatchApproval', { reason: 'edit file' })

    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      if (approvals.length > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      id: '999',
      method: 'applyPatchApproval',
      params: { reason: 'edit file' },
    })
    expect(server.receivedFromClient.find((m) => m && m.id === 999 && m.method === undefined)).toBeUndefined()

    backend.respondToApprovalResponse({ id: '999', approved: false, message: 'not allowed' })

    let reply: any | undefined
    const replyDeadline = Date.now() + 1000
    while (Date.now() < replyDeadline) {
      reply = server.receivedFromClient.find((m) => m && m.id === 999 && m.method === undefined)
      if (reply) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 999,
      result: { approved: false, message: 'not allowed' },
    })
  })
})

describe('buildCodexSpawnEnv', () => {
  it('sets OPENAI_API_KEY when apiKey is non-empty', () => {
    const env = buildCodexSpawnEnv({ FOO: 'bar' } as NodeJS.ProcessEnv, 'sk-test-123')
    expect(env.OPENAI_API_KEY).toBe('sk-test-123')
    expect(env.FOO).toBe('bar')
  })

  it('omits OPENAI_API_KEY when apiKey is an empty string and strips any pre-existing value', () => {
    const env = buildCodexSpawnEnv(
      { FOO: 'bar', OPENAI_API_KEY: 'leftover' } as NodeJS.ProcessEnv,
      '',
    )
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.FOO).toBe('bar')
  })

  it('omits OPENAI_API_KEY when apiKey is undefined and strips any pre-existing value', () => {
    const env = buildCodexSpawnEnv(
      { FOO: 'bar', OPENAI_API_KEY: 'leftover' } as NodeJS.ProcessEnv,
      undefined,
    )
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.FOO).toBe('bar')
  })
})

describe('CodexLocalBackend spawn env injection', () => {
  function makeFakeChildProc(): any {
    const proc = new EventEmitter() as any
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    let exitCode: number | null = null
    proc.kill = (): boolean => {
      if (exitCode !== null) return false
      exitCode = 0
      setImmediate(() => proc.emit('exit', 0, null))
      return true
    }
    Object.defineProperty(proc, 'exitCode', { get: () => exitCode })
    return proc
  }

  it('passes OPENAI_API_KEY to spawn when getApiKey returns a value', async () => {
    let captured: NodeJS.ProcessEnv | undefined
    const fakeProc = makeFakeChildProc()
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      getApiKey: () => 'sk-itest',
      spawnFactory: ((_bin: string, _args: string[], opts: any) => {
        captured = opts?.env
        return fakeProc
      }) as any,
      connectTimeoutMs: 100,
    })
    await expect(backend.start()).rejects.toThrow()
    expect(captured?.OPENAI_API_KEY).toBe('sk-itest')
    await backend.stop()
  })
})
