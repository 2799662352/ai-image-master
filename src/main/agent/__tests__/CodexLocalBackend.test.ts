import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { buildCodexSpawnEnv, CodexLocalBackend, mapServerNotification, resolveStableCodexHome } from '../CodexLocalBackend'
import { resolveWorkspacePaths } from '../codexConfigStore'
import type { AgentStreamEvent, CodexApprovalRequest } from '../../../types/agent'
import type { AgentInput } from '../types'

interface FakeServerOptions {
  autoCompleteTurn?: boolean
  delayTurnStartMs?: number
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
  const delayTurnStartMs = opts.delayTurnStartMs ?? 0

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
        const sendTurnStart = () => {
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
        }
        if (delayTurnStartMs > 0) setTimeout(sendTurnStart, delayTurnStartMs)
        else sendTurnStart()
      } else if (msg.method === 'thread/resume' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { thread: { id: msg.params.threadId, preview: '', cwd: '/' } },
        }))
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

async function createWorkspacePaths() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-restart-'))
  const home = path.join(tmp, 'home')
  const cwd = path.join(tmp, 'workspace')
  await mkdir(path.join(home, '.codex'), { recursive: true })
  await mkdir(path.join(cwd, '.codex'), { recursive: true })
  await writeFile(
    path.join(home, '.codex', 'config.toml'),
    '[mcp_servers.foo]\ncommand = "personal"\nargs = []\n',
    'utf8',
  )
  await writeFile(
    path.join(cwd, '.codex', 'workspace-mcp.toml'),
    '[mcp_servers.foo]\ncommand = "workspace"\nargs = []\n',
    'utf8',
  )
  return { tmp, paths: resolveWorkspacePaths({ home, cwd, userData: tmp }) }
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
    ).toEqual({ type: 'error', threadId: 't', error: 'kaboom', willRetry: false })
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

  it('resumeThread pins thread/resume to the CURRENT provider (cross-channel switch fix)', async () => {
    // codex thread/resume restores the persisted model_provider from thread
    // metadata (openai/codex#19287); after a grok→gpt channel switch that old
    // provider is no longer in the launch config and resume dies with
    // "Model provider `<old>` not found". Explicit overrides suppress the
    // metadata restore and keep the thread on the current selection.
    server = await startFakeServer()
    backend = new CodexLocalBackend({
      wsUrl: server.url,
      provider: {
        id: 'rightcode-grok',
        name: 'Right.Codes Grok',
        baseUrl: 'https://rightapi.ai/grok/v1',
        envKey: 'OPENAI_API_KEY',
        model: 'grok-4.5',
      },
    })
    await backend.start()

    await backend.resumeThread('thread-1')
    // Channel switch: the coordinator calls setProvider before resuming.
    backend.setProvider({
      id: 'rightcode-standard',
      name: 'Right.Codes',
      baseUrl: 'https://rightapi.ai/codex/v1',
      envKey: 'OPENAI_API_KEY',
      model: 'gpt-5.6-sol',
    })
    await backend.resumeThread('thread-1')

    const resumes = server.receivedFromClient.filter((m) => m.method === 'thread/resume')
    expect(resumes.map((m) => m.params)).toEqual([
      { threadId: 'thread-1', model: 'grok-4.5', modelProvider: 'rightcode-grok' },
      { threadId: 'thread-1', model: 'gpt-5.6-sol', modelProvider: 'rightcode-standard' },
    ])
  })

  it('resumeThread pins the built-in openai provider when no custom provider is active', async () => {
    server = await startFakeServer()
    backend = new CodexLocalBackend({ wsUrl: server.url })
    await backend.start()

    await backend.resumeThread('thread-2')

    const resume = server.receivedFromClient.find((m) => m.method === 'thread/resume')
    expect(resume?.params).toEqual({ threadId: 'thread-2', modelProvider: 'openai' })
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

  it('exposes the protocol client in-flight state', async () => {
    server = await startFakeServer({ autoCompleteTurn: false })
    backend = new CodexLocalBackend({ wsUrl: server.url })
    await backend.start()
    expect(backend.hasInFlightWork()).toBe(false)
    expect(backend.hasActiveTurns()).toBe(false)

    const consumer = (async () => {
      for await (const _event of backend!.send(undefined, baseInput)) {
        // Consume until the fake server completes the turn.
      }
    })()

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (server.receivedFromClient.some((message) => message.method === 'turn/start')) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(backend.hasInFlightWork()).toBe(true)
    expect(backend.hasActiveTurns()).toBe(true)

    server.pushNotification('turn/completed', {
      threadId: 'fake-thread',
      turn: { id: 'fake-turn', status: 'completed' },
    })
    await consumer

    expect(backend.hasInFlightWork()).toBe(false)
    expect(backend.hasActiveTurns()).toBe(false)
  })

  it('rejects restart while an active turn is running without closing the stream', async () => {
    const workspace = await createWorkspacePaths()
    try {
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

      const socketBeforeRestart = server.socket()
      await expect(backend.restartCodex(workspace.paths)).rejects.toThrow(
        /current turn.*running.*retry/i,
      )

      expect(backend.isConfigDirty()).toBe(true)
      expect(server.socket()).toBe(socketBeforeRestart)
      expect(socketBeforeRestart?.readyState).toBe(WebSocket.OPEN)
      expect(server.receivedFromClient.filter((m) => m.method === 'initialize')).toHaveLength(1)
      expect(events.find((e) => e.type === 'error' || e.type === 'cancelled')).toBeUndefined()

      server.pushNotification('item/agentMessage/delta', {
        threadId: 'fake-thread',
        turnId: 'fake-turn',
        itemId: 'i1',
        delta: 'still running',
      })
      server.pushNotification('turn/completed', {
        threadId: 'fake-thread',
        turn: { id: 'fake-turn', status: 'completed' },
      })
      await consumer

      expect(events).toContainEqual({
        type: 'item_delta',
        threadId: 'fake-thread',
        itemId: 'i1',
        itemType: 'text',
        patch: { kind: 'appendText', field: 'content', text: 'still running' },
      })
      expect(events).toContainEqual({ type: 'turn_completed', threadId: 'fake-thread', turnId: 'fake-turn' })
      expect(events.find((e) => e.type === 'error' || e.type === 'cancelled')).toBeUndefined()
    } finally {
      await rm(workspace.tmp, { recursive: true, force: true })
    }
  })

  it('rejects restart while turn/start is still pending without closing the stream', async () => {
    const workspace = await createWorkspacePaths()
    try {
      // Keep turn/start pending long enough to remain deterministic even when
      // this suite runs in parallel with CPU-heavy renderer tests.
      server = await startFakeServer({ delayTurnStartMs: 3_000 })
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
      expect(backend.hasActiveTurns()).toBe(false)
      expect(backend.hasInFlightWork()).toBe(true)

      const socketBeforeRestart = server.socket()
      await expect(backend.restartCodex(workspace.paths)).rejects.toThrow(
        /current turn.*running.*retry/i,
      )

      expect(backend.isConfigDirty()).toBe(true)
      expect(server.socket()).toBe(socketBeforeRestart)
      expect(socketBeforeRestart?.readyState).toBe(WebSocket.OPEN)
      expect(server.receivedFromClient.filter((m) => m.method === 'initialize')).toHaveLength(1)

      await consumer

      expect(events).toContainEqual({ type: 'thread_created', threadId: 'fake-thread' })
      expect(events).toContainEqual({ type: 'turn_completed', threadId: 'fake-thread', turnId: 'fake-turn' })
      expect(events.find((e) => e.type === 'error' || e.type === 'cancelled')).toBeUndefined()
    } finally {
      await rm(workspace.tmp, { recursive: true, force: true })
    }
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

  it('sets CODEX_HOME when codexHome is provided', () => {
    const env = buildCodexSpawnEnv({ FOO: 'bar' } as NodeJS.ProcessEnv, undefined, '/tmp/runtime-home')
    expect(env.CODEX_HOME).toBe('/tmp/runtime-home')
    expect(env.FOO).toBe('bar')
  })

  it('merges non-empty extraEnv (e.g. MIAU_API_KEY) and skips blank values', () => {
    const env = buildCodexSpawnEnv(
      { FOO: 'bar' } as NodeJS.ProcessEnv,
      'sk-active',
      undefined,
      { MIAU_API_KEY: '  miau-123  ', EMPTY_ONE: '   ', UNDEF_ONE: undefined },
    )
    expect(env.MIAU_API_KEY).toBe('miau-123')
    expect(env.EMPTY_ONE).toBeUndefined()
    expect(env.UNDEF_ONE).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe('sk-active')
  })

  it('prepends extraPathDirs to an existing PATH using the platform delimiter', () => {
    const env = buildCodexSpawnEnv(
      { PATH: `/usr/bin${path.delimiter}/bin` } as NodeJS.ProcessEnv,
      undefined,
      undefined,
      undefined,
      ['/opt/ffmpeg'],
    )
    expect(env.PATH).toBe(`/opt/ffmpeg${path.delimiter}/usr/bin${path.delimiter}/bin`)
  })

  it('updates the existing PATH key case-insensitively (Windows stores it as `Path`)', () => {
    const env = buildCodexSpawnEnv(
      { Path: 'C:\\Windows\\System32' } as NodeJS.ProcessEnv,
      undefined,
      undefined,
      undefined,
      ['C:\\app\\ffmpeg'],
    )
    expect(env.Path).toBe(`C:\\app\\ffmpeg${path.delimiter}C:\\Windows\\System32`)
    // Must not create a second, divergent PATH key that the OS would ignore.
    expect(env.PATH).toBeUndefined()
  })

  it('sets PATH to just the extra dirs when none pre-exists, and ignores blank dirs', () => {
    const env = buildCodexSpawnEnv(
      { FOO: 'bar' } as NodeJS.ProcessEnv,
      undefined,
      undefined,
      undefined,
      ['   ', 'C:\\app\\ffmpeg'],
    )
    expect(env.PATH).toBe('C:\\app\\ffmpeg')
  })

  it('leaves PATH untouched when extraPathDirs is omitted or empty', () => {
    const omitted = buildCodexSpawnEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, undefined)
    expect(omitted.PATH).toBe('/usr/bin')
    const empty = buildCodexSpawnEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, undefined, undefined, undefined, [])
    expect(empty.PATH).toBe('/usr/bin')
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

  function makeFakeCodexServerChildProc(args: string[]): any {
    const proc = makeFakeChildProc()
    const listenUrl = args[args.indexOf('--listen') + 1]
    const parsed = new URL(listenUrl)
    const wss = new WebSocketServer({ host: parsed.hostname, port: Number(parsed.port) })

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        if (msg.method === 'initialize' && msg.id !== undefined) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
          }))
        }
      })
    })

    const originalKill = proc.kill
    proc.kill = (signal?: NodeJS.Signals): boolean => {
      try { wss.close() } catch { /* ignore */ }
      return originalKill(signal)
    }

    return proc
  }

  it('reads a throwing context getter before production log/resource creation', async () => {
    const spawnFactory = vi.fn()
    const createLogStream = vi.fn(() => new PassThrough())
    const backend = new CodexLocalBackend({
      getModelContextConfig: () => {
        throw new Error('context getter unavailable')
      },
      spawnFactory: spawnFactory as any,
      createLogStream: createLogStream as any,
    })

    await expect(backend.start()).rejects.toThrow('context getter unavailable')

    expect(createLogStream).not.toHaveBeenCalled()
    expect(spawnFactory).not.toHaveBeenCalled()
    expect(backend.currentEpoch()).toBe(0)
    expect(backend.isHealthy()).toBe(false)
  })

  it.each([
    ['NaN', { modelContextWindow: Number.NaN, modelAutoCompactTokenLimit: 1 }],
    ['negative', { modelContextWindow: -1, modelAutoCompactTokenLimit: 1 }],
    [
      'unsafe',
      {
        modelContextWindow: Number.MAX_SAFE_INTEGER + 1,
        modelAutoCompactTokenLimit: 1,
      },
    ],
    [
      'mismatched',
      { modelContextWindow: 372_000, modelAutoCompactTokenLimit: 334_799 },
    ],
  ])('rejects %s context config before spawn and epoch mutation', async (_label, config) => {
    const spawnFactory = vi.fn()
    const createLogStream = vi.fn(() => new PassThrough())
    const backend = new CodexLocalBackend({
      getModelContextConfig: () => config,
      spawnFactory: spawnFactory as any,
      createLogStream: createLogStream as any,
    })

    await expect(backend.start()).rejects.toThrow(/invalid.*model context config/i)

    expect(createLogStream).not.toHaveBeenCalled()
    expect(spawnFactory).not.toHaveBeenCalled()
    expect(backend.currentEpoch()).toBe(0)
    expect(backend.isHealthy()).toBe(false)
  })

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

  it('injects the qwen understanding provider (env + model_providers.qwen) when getUnderstandProvider returns a config', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    let capturedArgs: string[] | undefined
    const fakeProc = makeFakeChildProc()
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      getApiKey: () => 'sk-active',
      getUnderstandProvider: () => ({
        provider: {
          id: 'qwen',
          name: 'Qwen Understanding',
          baseUrl: 'https://miauapi.13797248455.xyz/v1',
          envKey: 'MIAU_API_KEY',
          model: 'qwen3.7-max-dashscope',
          wireApi: 'responses',
        },
        token: 'miau-secret',
      }),
      spawnFactory: ((_bin: string, args: string[], opts: any) => {
        capturedArgs = args
        capturedEnv = opts?.env
        return fakeProc
      }) as any,
      connectTimeoutMs: 100,
    })
    await expect(backend.start()).rejects.toThrow()
    expect(capturedEnv?.MIAU_API_KEY).toBe('miau-secret')
    expect(capturedEnv?.OPENAI_API_KEY).toBe('sk-active')
    expect(capturedArgs).toContain('model_providers.qwen.env_key="MIAU_API_KEY"')
    expect(capturedArgs).toContain('model_providers.qwen.wire_api="responses"')
    // Must NOT seize the active model_provider.
    expect(capturedArgs?.join(' ')).not.toContain('model_provider="qwen"')
    await backend.stop()
  })

  it('routes bridged Responses providers through loopback compatibility proxies', async () => {
    let capturedArgs: string[] = []
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      provider: {
        id: 'apiyi-grok',
        name: 'API Yi Grok',
        baseUrl: 'https://api.apiyi.com/v1',
        envKey: 'OPENAI_API_KEY',
        model: 'grok-4.5',
        compatibilityPolicy: 'responses-namespace-bridge',
      },
      getUnderstandProvider: () => ({
        provider: {
          id: 'qwen',
          name: 'Qwen Understanding',
          baseUrl: 'https://miauapi.13797248455.xyz/v1',
          envKey: 'MIAU_API_KEY',
          model: 'qwen3.7-max-dashscope',
          wireApi: 'responses',
        },
        token: 'miau-secret',
      }),
      spawnFactory: ((_bin: string, args: string[]) => {
        capturedArgs = args
        return makeFakeCodexServerChildProc(args)
      }) as any,
      connectTimeoutMs: 500,
    })

    try {
      await backend.start()
      const activeBaseUrl = capturedArgs.find((arg) =>
        arg.startsWith('model_providers.apiyi-grok.base_url='))
      const extraBaseUrl = capturedArgs.find((arg) =>
        arg.startsWith('model_providers.qwen.base_url='))

      expect(activeBaseUrl).toMatch(
        /^model_providers\.apiyi-grok\.base_url="http:\/\/127\.0\.0\.1:\d+\/v1"$/,
      )
      expect(extraBaseUrl).toBe(
        'model_providers.qwen.base_url="https://miauapi.13797248455.xyz/v1"',
      )
      expect(activeBaseUrl).not.toContain('api.apiyi.com')
      expect(extraBaseUrl).not.toContain('127.0.0.1')
    } finally {
      await backend.stop()
    }
  })

  it('registers sibling Gateway channels as EXTRA provider tables with per-channel bridging (Plan B)', async () => {
    let capturedArgs: string[] = []
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      provider: {
        id: 'rightcode-standard',
        name: 'Right.Codes',
        baseUrl: 'https://rightapi.ai/codex/v1',
        envKey: 'OPENAI_API_KEY',
        model: 'gpt-5.5',
        requiresOpenaiAuth: true,
        compatibilityPolicy: 'none',
      },
      getGatewayChannelProviders: () => [
        // Includes the ACTIVE channel too — the backend must dedupe it by id
        // instead of registering it twice / double-proxying it.
        {
          id: 'rightcode-standard',
          name: 'Right.Codes',
          baseUrl: 'https://rightapi.ai/codex/v1',
          envKey: 'OPENAI_API_KEY',
          model: 'gpt-5.5',
          requiresOpenaiAuth: true,
          compatibilityPolicy: 'none',
        },
        {
          id: 'rightcode-grok',
          name: 'Right.Codes Grok',
          baseUrl: 'https://rightapi.ai/grok/v1',
          envKey: 'OPENAI_API_KEY',
          model: 'grok-4.5',
          requiresOpenaiAuth: true,
          compatibilityPolicy: 'responses-namespace-bridge',
        },
      ],
      spawnFactory: ((_bin: string, args: string[]) => {
        capturedArgs = args
        return makeFakeCodexServerChildProc(args)
      }) as any,
      connectTimeoutMs: 500,
    })

    try {
      await backend.start()
      const joined = capturedArgs.join(' ')

      // Active channel stays the top-level model_provider on its direct URL.
      expect(capturedArgs).toContain('model_provider="rightcode-standard"')
      expect(capturedArgs).toContain(
        'model_providers.rightcode-standard.base_url="https://rightapi.ai/codex/v1"',
      )
      // The sibling Grok channel is REGISTERED (extra table) but never seizes
      // the active provider slot.
      expect(joined).not.toContain('model_provider="rightcode-grok"')
      expect(capturedArgs).toContain('model_providers.rightcode-grok.name="Right.Codes Grok"')
      expect(capturedArgs).toContain('model_providers.rightcode-grok.requires_openai_auth=true')
      expect(capturedArgs).toContain('model_providers.rightcode-grok.wire_api="responses"')
      // Bridged sibling rides its own loopback compatibility proxy.
      const grokBaseUrl = capturedArgs.find((arg) =>
        arg.startsWith('model_providers.rightcode-grok.base_url='))
      expect(grokBaseUrl).toMatch(
        /^model_providers\.rightcode-grok\.base_url="http:\/\/127\.0\.0\.1:\d+\/grok\/v1"$/,
      )
      // Exactly ONE table per channel id — the active dupe was filtered out.
      const standardNameArgs = capturedArgs.filter((arg) =>
        arg.startsWith('model_providers.rightcode-standard.name='))
      expect(standardNameArgs).toHaveLength(1)
    } finally {
      await backend.stop()
    }
  })

  it('does NOT register the qwen provider when getUnderstandProvider returns undefined', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    let capturedArgs: string[] | undefined
    const fakeProc = makeFakeChildProc()
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      getApiKey: () => 'sk-active',
      getUnderstandProvider: () => undefined,
      spawnFactory: ((_bin: string, args: string[], opts: any) => {
        capturedArgs = args
        capturedEnv = opts?.env
        return fakeProc
      }) as any,
      connectTimeoutMs: 100,
    })
    await expect(backend.start()).rejects.toThrow()
    expect(capturedEnv?.MIAU_API_KEY).toBeUndefined()
    expect(capturedArgs?.some((a) => a.includes('model_providers.qwen'))).toBe(false)
    await backend.stop()
  })

  it('reads the latest model context config before every fresh spawn', async () => {
    const workspace = await createWorkspacePaths()
    const capturedArgs: string[][] = []
    let currentConfig = {
      modelContextWindow: 200_000,
      modelAutoCompactTokenLimit: 180_000,
    }
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      getModelContextConfig: () => ({ ...currentConfig }),
      spawnFactory: ((_bin: string, args: string[]) => {
        capturedArgs.push([...args])
        return makeFakeCodexServerChildProc(args)
      }) as any,
      connectTimeoutMs: 500,
    })

    try {
      await backend.start()
      currentConfig = {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
      }

      await backend.restartCodex(workspace.paths)

      expect(capturedArgs).toHaveLength(2)
      expect(capturedArgs[0]).toContain('model_context_window=200000')
      expect(capturedArgs[0]).toContain('model_auto_compact_token_limit=180000')
      expect(capturedArgs[1]).toContain('model_context_window=372000')
      expect(capturedArgs[1]).toContain('model_auto_compact_token_limit=334800')
    } finally {
      await backend.stop()
      await rm(workspace.tmp, { recursive: true, force: true })
    }
  })

  it('spawns WITHOUT a context pin when getModelContextConfig returns null (native metadata)', async () => {
    const capturedArgs: string[][] = []
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      getModelContextConfig: () => null,
      spawnFactory: ((_bin: string, args: string[]) => {
        capturedArgs.push([...args])
        return makeFakeCodexServerChildProc(args)
      }) as any,
      connectTimeoutMs: 500,
    })

    try {
      await backend.start()
      expect(capturedArgs).toHaveLength(1)
      const flat = capturedArgs[0].join(' ')
      expect(flat).not.toContain('model_context_window')
      expect(flat).not.toContain('model_auto_compact_token_limit')
    } finally {
      await backend.stop()
    }
  })

  it('pins ONE stable CODEX_HOME on BOTH the initial spawn and restartCodex (sessions never drift across launches)', async () => {
    // Root cause of "重启之后对话又没有记忆了": the FIRST spawn each launch left
    // CODEX_HOME unset → codex fell back to ~/.codex, while restartCodex (on a
    // provider switch) flipped it to <userData>/codex-runtime. A rollout written
    // after a switch therefore lived in codex-runtime but the next launch's fresh
    // (~/.codex) spawn looked elsewhere → thread/resume missed → amnesia. The fix
    // pins ONE home (resolveStableCodexHome) for every spawn. We inject an
    // explicit home here so the assertion is deterministic and host-independent.
    const workspace = await createWorkspacePaths()
    const stableHome = path.join(workspace.tmp, 'home', '.codex')
    const spawned: any[] = []
    const envs: NodeJS.ProcessEnv[] = []
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      codexHome: stableHome,
      spawnFactory: ((_bin: string, args: string[], opts: any) => {
        envs.push(opts?.env)
        const proc = makeFakeCodexServerChildProc(args)
        spawned.push(proc)
        return proc
      }) as any,
      connectTimeoutMs: 500,
    })

    try {
      await backend.start()
      expect(backend.isHealthy()).toBe(true)

      await backend.restartCodex(workspace.paths)

      expect(envs).toHaveLength(2)
      // The whole bug: these two used to differ (undefined vs codex-runtime).
      expect(envs[0].CODEX_HOME).toBe(stableHome)
      expect(envs[1].CODEX_HOME).toBe(stableHome)
      // restartCodex must NOT flip the home to the per-app runtime dir anymore.
      expect(envs[1].CODEX_HOME).not.toBe(path.dirname(workspace.paths.runtimeConfigToml))
      expect(spawned[0].exitCode).toBe(0)
      expect(spawned[1].exitCode).toBeNull()
      expect(backend.isHealthy()).toBe(true)
      expect(backend.isConfigDirty()).toBe(false)
    } finally {
      await backend.stop()
      await rm(workspace.tmp, { recursive: true, force: true })
    }
  })

  it('defaults the pinned CODEX_HOME to ~/.codex and honors a CODEX_HOME env override', () => {
    expect(resolveStableCodexHome({} as NodeJS.ProcessEnv, '/Users/alice')).toBe(
      path.join('/Users/alice', '.codex'),
    )
    expect(
      resolveStableCodexHome({ CODEX_HOME: '  /custom/home  ' } as NodeJS.ProcessEnv, '/Users/alice'),
    ).toBe('/custom/home')
    // Empty/whitespace env must fall back to the default (mirrors codex find_codex_home).
    expect(resolveStableCodexHome({ CODEX_HOME: '   ' } as NodeJS.ProcessEnv, '/Users/alice')).toBe(
      path.join('/Users/alice', '.codex'),
    )
  })

  it('keeps the old spawned backend running when replacement startup fails', async () => {
    const workspace = await createWorkspacePaths()
    const spawned: any[] = []
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      spawnFactory: ((_bin: string, args: string[]) => {
        const proc = spawned.length === 0
          ? makeFakeCodexServerChildProc(args)
          : makeFakeChildProc()
        spawned.push(proc)
        return proc
      }) as any,
      connectTimeoutMs: 50,
    })

    try {
      await backend.start()
      expect(backend.isHealthy()).toBe(true)

      await expect(backend.restartCodex(workspace.paths)).rejects.toThrow(/connectWithRetry timed out/)

      expect(spawned).toHaveLength(2)
      expect(spawned[0].exitCode).toBeNull()
      expect(spawned[1].exitCode).toBe(0)
      expect(backend.isHealthy()).toBe(true)
      expect(backend.isConfigDirty()).toBe(true)
    } finally {
      await backend.stop()
      await rm(workspace.tmp, { recursive: true, force: true })
    }
  })

  it('keeps the old spawned backend untouched when replacement context getter throws', async () => {
    const workspace = await createWorkspacePaths()
    const spawned: any[] = []
    let getterError: Error | null = null
    const backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      getModelContextConfig: () => {
        if (getterError) throw getterError
        return {
          modelContextWindow: 200_000,
          modelAutoCompactTokenLimit: 180_000,
        }
      },
      spawnFactory: ((_bin: string, args: string[]) => {
        const proc = makeFakeCodexServerChildProc(args)
        spawned.push(proc)
        return proc
      }) as any,
      connectTimeoutMs: 500,
    })

    try {
      await backend.start()
      const epochBeforeRestart = backend.currentEpoch()
      getterError = new Error('replacement context getter failed')

      await expect(backend.restartCodex(workspace.paths)).rejects.toThrow(
        'replacement context getter failed',
      )

      expect(spawned).toHaveLength(1)
      expect(spawned[0].exitCode).toBeNull()
      expect(backend.currentEpoch()).toBe(epochBeforeRestart)
      expect(backend.isHealthy()).toBe(true)
      expect(backend.isConfigDirty()).toBe(true)
    } finally {
      await backend.stop()
      await rm(workspace.tmp, { recursive: true, force: true })
    }
  })
})
