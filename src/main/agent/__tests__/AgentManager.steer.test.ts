import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'
import type { CodexProviderConfig } from '../codexLaunch'

// Codex mints a UUID thread id via thread/start; our DB rows are CUIDs. The
// manager translates between the two, and `steer` must reach the backend with
// the *codex* id it recorded from the `thread_created` event.
const CODEX_UUID = '11111111-2222-3333-4444-555555555555'

interface SteerCall {
  threadId: string
  input: AgentInput
}

interface ProviderBoundCall {
  client: string
  providerId: string
  apiKey: string
}

function makeSteerableBackend(script: AgentStreamEvent[]): IAgentBackend & {
  sendCalls: Array<string | undefined>
  steerCalls: SteerCall[]
} {
  const sendCalls: Array<string | undefined> = []
  const steerCalls: SteerCall[] = []
  return {
    sendCalls,
    steerCalls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel() {},
    async steer(threadId: string, input: AgentInput) {
      steerCalls.push({ threadId, input })
      return 'turn-1'
    },
    async *send(threadId: string | undefined) {
      sendCalls.push(threadId)
      for (const e of script) yield e
    },
  } as unknown as IAgentBackend & { sendCalls: Array<string | undefined>; steerCalls: SteerCall[] }
}

function flushMicrotasks(times = 20): Promise<void> {
  let p: Promise<void> = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

function makeDeferredProviderBackend(options: {
  failReplacement?: boolean
  noActiveTurn?: boolean
} = {}) {
  let releaseRestart!: () => void
  let markRestartStarted!: () => void
  const restartStarted = new Promise<void>((resolve) => {
    markRestartStarted = resolve
  })
  const restartGate = new Promise<void>((resolve) => {
    releaseRestart = resolve
  })
  let readApiKey = (): string => ''
  const steerCalls: ProviderBoundCall[] = []
  const sendCalls: ProviderBoundCall[] = []
  const backend = {
    healthy: false,
    epoch: 1,
    activeClient: 'old-client',
    providerId: 'apiyi-standard',
    async start() {},
    async stop() {},
    isHealthy() { return backend.healthy },
    currentEpoch() { return backend.epoch },
    setProvider(provider: CodexProviderConfig | undefined) {
      backend.providerId = provider?.id ?? 'apiyi-standard'
    },
    async restartCodex() {
      markRestartStarted()
      await restartGate
      if (options.failReplacement) throw new Error('replacement failed')
      backend.activeClient = 'new-client'
      backend.epoch += 1
    },
    async cancel() {},
    async steer() {
      steerCalls.push({
        client: backend.activeClient,
        providerId: backend.providerId,
        apiKey: readApiKey(),
      })
      if (options.noActiveTurn) {
        throw new Error('turn/steer: no active turn on thread db-provider')
      }
      return 'turn-provider'
    },
    async *send() {
      sendCalls.push({
        client: backend.activeClient,
        providerId: backend.providerId,
        apiKey: readApiKey(),
      })
      yield {
        type: 'turn_completed',
        threadId: CODEX_UUID,
        turnId: 'turn-provider',
      } as AgentStreamEvent
    },
  } as IAgentBackend & {
    healthy: boolean
    epoch: number
    activeClient: string
    providerId: string
  }
  return {
    backend,
    steerCalls,
    sendCalls,
    restartStarted,
    releaseRestart,
    bindManager(manager: AgentManager) {
      readApiKey = () => manager.getCodexApiKey()
    },
  }
}

const persistStubs = {
  addMessage: async () => ({ id: 'msg-stub' }),
  updateLastMessageAt: async () => undefined,
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-steer-test-'))
  await fs.writeFile(
    path.join(tmpDir, 'codex-agent.json'),
    JSON.stringify({ openaiApiKey: 'sk-test' }),
    'utf8',
  )
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager.steer (turn/steer)', () => {
  it('waits for Provider replacement before steering on the confirmed client and key', async () => {
    const fixture = makeDeferredProviderBackend()
    const added: unknown[] = []
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: fixture.backend,
      store: {
        ...persistStubs,
        addMessage: async (message: unknown) => {
          added.push(message)
          return { id: 'msg-provider' }
        },
      } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: () => {},
    })
    fixture.bindManager(manager)
    await manager.setCodexApiKey('sk-old')
    await manager.setProviderApiKey('rightcode', 'sk-new')
    fixture.backend.healthy = true

    const transition = manager.setActiveProvider('rightcode')
    await fixture.restartStarted
    const steering = manager.steer({
      threadId: 'db-provider',
      content: 'confirmed steer',
      attachments: [],
    })
    await flushMicrotasks()

    expect(fixture.steerCalls).toEqual([])
    fixture.releaseRestart()
    await transition
    await steering

    expect(fixture.steerCalls).toEqual([{
      client: 'new-client',
      providerId: 'rightcode-standard',
      apiKey: 'sk-new',
    }])
    expect(fixture.sendCalls).toEqual([])
    expect(added).toHaveLength(1)
  })

  it('keeps no-active fallback inside admission and sends fresh once on the confirmed client', async () => {
    const fixture = makeDeferredProviderBackend({ noActiveTurn: true })
    const added: unknown[] = []
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: fixture.backend,
      store: {
        ...persistStubs,
        addMessage: async (message: unknown) => {
          added.push(message)
          return { id: 'msg-fallback' }
        },
      } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: () => {},
    })
    fixture.bindManager(manager)
    await manager.setCodexApiKey('sk-old')
    await manager.setProviderApiKey('rightcode', 'sk-new')
    fixture.backend.healthy = true

    const transition = manager.setActiveProvider('rightcode')
    await fixture.restartStarted
    const steering = manager.steer({
      threadId: 'db-provider',
      content: 'fallback after replacement',
      attachments: [],
    })
    await flushMicrotasks()

    expect(fixture.steerCalls).toEqual([])
    expect(fixture.sendCalls).toEqual([])
    fixture.releaseRestart()
    await transition
    await steering

    expect(fixture.steerCalls).toEqual([{
      client: 'new-client',
      providerId: 'rightcode-standard',
      apiKey: 'sk-new',
    }])
    expect(fixture.sendCalls).toEqual([{
      client: 'new-client',
      providerId: 'rightcode-standard',
      apiKey: 'sk-new',
    }])
    expect(added).toHaveLength(1)
  })

  it('uses the rolled-back client once for steer fallback when Provider replacement fails', async () => {
    const fixture = makeDeferredProviderBackend({
      failReplacement: true,
      noActiveTurn: true,
    })
    const added: unknown[] = []
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: fixture.backend,
      store: {
        ...persistStubs,
        addMessage: async (message: unknown) => {
          added.push(message)
          return { id: 'msg-rollback' }
        },
      } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: () => {},
    })
    fixture.bindManager(manager)
    await manager.setCodexApiKey('sk-old')
    fixture.backend.healthy = true

    const transition = manager.setActiveProvider('rightcode')
    await fixture.restartStarted
    const steering = manager.steer({
      threadId: 'db-provider',
      content: 'fallback after rollback',
      attachments: [],
    })
    await flushMicrotasks()

    expect(fixture.steerCalls).toEqual([])
    expect(fixture.sendCalls).toEqual([])
    fixture.releaseRestart()
    await expect(transition).rejects.toThrow('replacement failed')
    await steering

    expect(fixture.steerCalls).toEqual([{
      client: 'old-client',
      providerId: 'apiyi-standard',
      apiKey: 'sk-old',
    }])
    expect(fixture.sendCalls).toEqual([{
      client: 'old-client',
      providerId: 'apiyi-standard',
      apiKey: 'sk-old',
    }])
    expect(added).toHaveLength(1)
  })

  it('appends to the active turn: calls backend.steer with the codex thread id and persists the user message', async () => {
    const added: Array<{ role: string }> = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'db-1' }),
      addMessage: async (m: { role: string }) => {
        added.push(m)
        return { id: 'msg-1' }
      },
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    // thread_created maps CODEX_UUID -> db-1 so steer can resolve it later.
    const backend = makeSteerableBackend([
      { type: 'thread_created', threadId: CODEX_UUID },
      { type: 'turn_completed', threadId: CODEX_UUID, turnId: 'turn-1' },
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    const first = await mgr.sendMessage({ content: 'start', attachments: [] })
    await flushMicrotasks()

    const result = await mgr.steer({ threadId: first.threadId, content: 'actually, do X', attachments: [] })

    expect(backend.steerCalls).toHaveLength(1)
    expect(backend.steerCalls[0].threadId).toBe(CODEX_UUID)
    // The steered text rides through as a plain text input item.
    const textItem = backend.steerCalls[0].input.items.find((i) => i.type === 'text') as
      | { type: 'text'; text: string }
      | undefined
    expect(textItem?.text).toContain('actually, do X')
    // The interjection is persisted as a user message row.
    expect(added.some((m) => m.role === 'user')).toBe(true)
    expect(result.threadId).toBe(first.threadId)
  })

  it('is a no-op (no backend.steer) when called without a threadId', async () => {
    const backend = makeSteerableBackend([])
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: { ...persistStubs, createThread: async () => ({ id: 'db-x' }) } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: () => {},
      backend,
    })

    const result = await mgr.steer({ content: 'orphan', attachments: [] })

    expect(backend.steerCalls).toHaveLength(0)
    expect(result.threadId).toBe('pending')
  })

  it('falls back to a fresh turn (backend.send) when steer rejects with "no active turn"', async () => {
    const events: AgentStreamEvent[] = []
    const sendCalls: Array<string | undefined> = []
    // First send establishes the codex-id mapping and completes its turn;
    // steer then races the completed turn and gets rejected — exactly the
    // "turn/steer: no active turn" path from CodexProtocolClient.steer.
    const backend = {
      sendCalls,
      async start() {},
      async stop() {},
      isHealthy() { return true },
      async cancel() {},
      async steer() {
        throw new Error('turn/steer: no active turn on thread 019f3da3-d4ee-7472-aa8b-a173358ae832')
      },
      async *send(threadId: string | undefined) {
        sendCalls.push(threadId)
        yield { type: 'thread_created', threadId: CODEX_UUID } as AgentStreamEvent
        yield { type: 'turn_completed', threadId: CODEX_UUID, turnId: 'turn-1' } as AgentStreamEvent
      },
    } as unknown as IAgentBackend

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: { ...persistStubs, createThread: async () => ({ id: 'db-f' }) } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (e) => events.push(e),
      backend,
    })

    const first = await mgr.sendMessage({ content: 'start', attachments: [] })
    await flushMicrotasks()
    expect(sendCalls).toHaveLength(1)

    await mgr.steer({ threadId: first.threadId, content: 'late interjection', attachments: [] })
    await flushMicrotasks()

    // The interjection is delivered as a NEW turn instead of surfacing an error.
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[1]).toBe(CODEX_UUID)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    // The user is told the interjection was converted into a fresh turn.
    expect(events.some((e) => e.type === 'notice')).toBe(true)
  })

  it('still emits an error event when steer rejects for other reasons', async () => {
    const events: AgentStreamEvent[] = []
    const sendCalls: Array<string | undefined> = []
    const backend = {
      async start() {},
      async stop() {},
      isHealthy() { return true },
      async cancel() {},
      async steer() {
        throw new Error('websocket closed')
      },
      async *send(threadId: string | undefined) {
        sendCalls.push(threadId)
        yield { type: 'thread_created', threadId: CODEX_UUID } as AgentStreamEvent
        yield { type: 'turn_completed', threadId: CODEX_UUID, turnId: 'turn-1' } as AgentStreamEvent
      },
    } as unknown as IAgentBackend

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: { ...persistStubs, createThread: async () => ({ id: 'db-g' }) } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (e) => events.push(e),
      backend,
    })

    const first = await mgr.sendMessage({ content: 'start', attachments: [] })
    await flushMicrotasks()

    await mgr.steer({ threadId: first.threadId, content: 'oops', attachments: [] })
    await flushMicrotasks()

    // No silent fallback turn — the failure is surfaced as an error event.
    expect(sendCalls).toHaveLength(1)
    expect(events.some((e) => e.type === 'error' && /websocket closed/.test((e as { error: string }).error))).toBe(true)
  })

  it('emits an error event when the backend does not support steering', async () => {
    const events: AgentStreamEvent[] = []
    // A backend WITHOUT a steer method (optional on IAgentBackend).
    const backend = {
      async start() {},
      async stop() {},
      isHealthy() { return true },
      async cancel() {},
      async *send() {},
    } as unknown as IAgentBackend

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: { ...persistStubs, createThread: async () => ({ id: 'db-y' }) } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (e) => events.push(e),
      backend,
    })

    await expect(
      mgr.steer({ threadId: 'db-y', content: 'hi', attachments: [] }),
    ).rejects.toThrow('当前后端不支持运行中插话')

    expect(events.some((e) => e.type === 'error')).toBe(true)
  })
})
