import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentManager } from '../AgentManager'
import type { CodexLocalBackendOptions } from '../CodexLocalBackend'
import {
  CodexRuntimeSettingsStore,
  type PersistedCodexRuntimeSettingsV1,
} from '../CodexRuntimeSettingsStore'
import type { AgentInput, IAgentBackend } from '../types'
import type {
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentStreamEvent,
  CodexModelContextConfig,
} from '../../../types/agent'

const PREVIOUS_CONFIG: CodexModelContextConfig = {
  modelContextWindow: 200_000,
  modelAutoCompactTokenLimit: 180_000,
}
const TARGET_CONFIG: CodexModelContextConfig = {
  modelContextWindow: 1_000_000,
  modelAutoCompactTokenLimit: 900_000,
}
const APPLY_PAYLOAD: AgentModelContextApplyPayload = {
  threadId: 'db-thread-1',
  model: 'gpt-5.6-sol',
  contextWindow: 1_000_000,
  requestVersion: 7,
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

interface ContextBackend extends IAgentBackend {
  epoch: number
  inFlight: boolean
  operations: string[]
  restartCalls: number
  resumeCalls: string[]
  refreshCalls: number
  sendCalls: number
  steerCalls: number
}

interface BackendOptions {
  exposeEpoch?: boolean
  restart?: (backend: ContextBackend, call: number) => Promise<void>
  resume?: (backend: ContextBackend, threadId: string, call: number) => Promise<void>
  refresh?: (backend: ContextBackend, call: number) => Promise<void>
}

function makeBackend(options: BackendOptions = {}): ContextBackend {
  const backend: ContextBackend = {
    epoch: 1,
    inFlight: false,
    operations: [],
    restartCalls: 0,
    resumeCalls: [],
    refreshCalls: 0,
    sendCalls: 0,
    steerCalls: 0,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    hasInFlightWork() { return backend.inFlight },
    async cancel() {},
    async restartCodex() {
      backend.restartCalls += 1
      backend.operations.push('restart')
      if (options.restart) {
        await options.restart(backend, backend.restartCalls)
      } else {
        backend.epoch += 1
      }
    },
    async resumeThread(threadId) {
      backend.resumeCalls.push(threadId)
      backend.operations.push(`resume:${threadId}`)
      if (options.resume) {
        await options.resume(backend, threadId, backend.resumeCalls.length)
      }
    },
    async listModels() {
      backend.refreshCalls += 1
      backend.operations.push('refresh-models')
      await options.refresh?.(backend, backend.refreshCalls)
      return { data: [], nextCursor: null }
    },
    async *send(_threadId: string | undefined, _input: AgentInput): AsyncIterable<AgentStreamEvent> {
      backend.sendCalls += 1
    },
    async steer() {
      backend.steerCalls += 1
      return 'turn-1'
    },
  }
  if (options.exposeEpoch !== false) {
    backend.currentEpoch = () => backend.epoch
  }
  return backend
}

interface RuntimeStoreHarness {
  store: CodexRuntimeSettingsStore
  snapshots: PersistedCodexRuntimeSettingsV1[]
  failReplace: (call: number, error: Error) => void
}

function makeRuntimeStore(operations: string[]): RuntimeStoreHarness {
  const store = new CodexRuntimeSettingsStore(tmpDir)
  const snapshots: PersistedCodexRuntimeSettingsV1[] = []
  const failures = new Map<number, Error>()
  const replace = store.replace.bind(store)
  let calls = 0
  vi.spyOn(store, 'replace').mockImplementation(async (next) => {
    calls += 1
    snapshots.push(structuredClone(next))
    operations.push(next.pending ? 'persist-pending' : 'persist-confirmed')
    const failure = failures.get(calls)
    if (failure) throw failure
    await replace(next)
  })
  return {
    store,
    snapshots,
    failReplace(call, error) {
      failures.set(call, error)
    },
  }
}

interface ManagerHarness {
  manager: AgentManager
  backend: ContextBackend
  runtime: RuntimeStoreHarness
  events: AgentStreamEvent[]
  threadStore: {
    getCodexThreadId: ReturnType<typeof vi.fn>
    setCodexThreadId: ReturnType<typeof vi.fn>
    createThread: ReturnType<typeof vi.fn>
    addMessage: ReturnType<typeof vi.fn>
    updateLastMessageAt: ReturnType<typeof vi.fn>
  }
  attachmentService: {
    ingest: ReturnType<typeof vi.fn>
  }
}

function makeManager(options: BackendOptions & { codexThreadId?: string | null } = {}): ManagerHarness {
  const backend = makeBackend(options)
  const runtime = makeRuntimeStore(backend.operations)
  const events: AgentStreamEvent[] = []
  const threadStore = {
    getCodexThreadId: vi.fn().mockResolvedValue(
      options.codexThreadId === undefined ? 'codex-thread-1' : options.codexThreadId,
    ),
    setCodexThreadId: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue({ id: 'db-thread-created' }),
    addMessage: vi.fn().mockResolvedValue({ id: 'message-1' }),
    updateLastMessageAt: vi.fn().mockResolvedValue(undefined),
  }
  const attachmentService = {
    ingest: vi.fn().mockResolvedValue([]),
  }
  const manager = new AgentManager({
    userDataDir: tmpDir,
    backend,
    runtimeSettingsStore: runtime.store,
    store: threadStore as never,
    attachments: attachmentService as never,
    eventSink: (event) => events.push(event),
  })
  return { manager, backend, runtime, events, threadStore, attachmentService }
}

function expectFailure(
  result: AgentModelContextApplyResult,
  stage: Extract<AgentModelContextApplyResult, { ok: false }>['stage'],
  requestVersion = APPLY_PAYLOAD.requestVersion,
): asserts result is Extract<AgentModelContextApplyResult, { ok: false }> {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected context apply failure')
  expect(result.stage).toBe(stage)
  expect(result.previousConfig).toEqual(PREVIOUS_CONFIG)
  expect(result.attemptedConfig).toEqual(TARGET_CONFIG)
  expect(result.requestVersion).toBe(requestVersion)
}

async function flushMicrotasks(times = 10): Promise<void> {
  let promise = Promise.resolve()
  for (let i = 0; i < times; i += 1) promise = promise.then(() => undefined)
  await promise
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-saga-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager transactional model context apply', () => {
  it('applies pending, restart, strict resume, refresh, and confirmation in exact order', async () => {
    const { manager, backend, runtime, threadStore } = makeManager()

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expect(backend.operations).toEqual([
      'persist-pending',
      'restart',
      'resume:codex-thread-1',
      'refresh-models',
      'persist-confirmed',
    ])
    expect(result).toEqual({
      ok: true,
      data: {
        model: 'gpt-5.6-sol',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        threadRestored: true,
        requestVersion: 7,
      },
    })
    expect(threadStore.setCodexThreadId).toHaveBeenCalledWith(
      'db-thread-1',
      'codex-thread-1',
    )
    expect(runtime.store.loadSync()).toEqual({
      version: 1,
      confirmed: TARGET_CONFIG,
    })
  })

  it('wires the default backend getter to pending target only after durable persistence', async () => {
    let backendOptions: CodexLocalBackendOptions | undefined
    const backend = makeBackend({
      restart: async (instance) => {
        expect(backendOptions?.getModelContextConfig?.()).toEqual(TARGET_CONFIG)
        instance.epoch += 1
      },
    })
    const runtime = makeRuntimeStore(backend.operations)
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backendFactory: (options) => {
        backendOptions = options
        return backend
      },
      runtimeSettingsStore: runtime.store,
    })
    expect(backendOptions?.getModelContextConfig?.()).toEqual(PREVIOUS_CONFIG)

    await expect(manager.applyModelContextRpc({
      ...APPLY_PAYLOAD,
      threadId: undefined,
    })).resolves.toMatchObject({ ok: true })
    expect(backendOptions?.getModelContextConfig?.()).toEqual(TARGET_CONFIG)
  })

  it('rejects a busy backend before persistence or restart', async () => {
    const { manager, backend } = makeManager()
    backend.inFlight = true

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'busy')
    expect(backend.operations).toEqual([])
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
  })

  it('returns a successful no-op for the same confirmed context', async () => {
    const { manager, backend } = makeManager()

    const result = await manager.applyModelContextRpc({
      model: 'custom-model',
      contextWindow: 200_000,
      requestVersion: 8,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        model: 'custom-model',
        contextWindow: 200_000,
        autoCompactTokenLimit: 180_000,
        threadRestored: false,
        requestVersion: 8,
      },
    })
    expect(backend.operations).toEqual([])
  })

  it('keeps the original configuration when pending persistence fails', async () => {
    const { manager, backend, runtime } = makeManager()
    runtime.failReplace(1, new Error('disk unavailable'))
    const rollback = vi.spyOn(manager as never, 'rollbackModelContextOnce' as never)

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'persist')
    expect(result.error).toContain('disk unavailable')
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(backend.operations).toEqual(['persist-pending'])
    expect(rollback).not.toHaveBeenCalled()
    expect(runtime.store.loadSync()).toEqual({
      version: 1,
      confirmed: PREVIOUS_CONFIG,
    })
  })

  it('rolls back once when restart changed generation before failing', async () => {
    const { manager, backend, runtime } = makeManager({
      restart: async (instance, call) => {
        instance.epoch += 1
        if (call === 1) throw new Error('replacement audit failed')
      },
    })
    const rollback = vi.spyOn(manager as never, 'rollbackModelContextOnce' as never)

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'restart')
    expect(result.error).toContain('replacement audit failed')
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(backend.restartCalls).toBe(2)
    expect(runtime.store.loadSync()).toEqual({
      version: 1,
      confirmed: PREVIOUS_CONFIG,
    })
  })

  it('does not restart a healthy previous replacement-first backend after an unchanged-epoch restart failure', async () => {
    const { manager, backend } = makeManager({
      restart: async (_instance, call) => {
        if (call === 1) throw new Error('replacement spawn failed')
      },
    })

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'restart')
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(backend.restartCalls).toBe(1)
  })

  it('treats an unchanged restart epoch as verify failure and rolls back', async () => {
    const { manager, backend } = makeManager({
      restart: async (instance, call) => {
        if (call === 2) instance.epoch += 1
      },
    })

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'verify')
    expect(result.error).toMatch(/generation|epoch/i)
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(backend.restartCalls).toBe(2)
  })

  it('uses strict resume and never falls back to a fresh thread', async () => {
    const { manager, backend } = makeManager({
      resume: async (_instance, _threadId, call) => {
        if (call === 1) throw new Error('rollout missing')
      },
    })

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'resume')
    expect(result.error).toContain('rollout missing')
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(backend.resumeCalls).toEqual(['codex-thread-1', 'codex-thread-1'])
    expect(backend.sendCalls).toBe(0)
  })

  it('rolls back a model refresh failure as verify', async () => {
    const { manager, backend } = makeManager({
      refresh: async (_instance, call) => {
        if (call === 1) throw new Error('model list unavailable')
      },
    })

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'verify')
    expect(result.error).toContain('model list unavailable')
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(backend.refreshCalls).toBe(2)
  })

  it('rolls back when confirmed persistence fails without publishing a false in-memory confirmation', async () => {
    const { manager, runtime } = makeManager()
    runtime.failReplace(2, new Error('confirm rename failed'))

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'persist')
    expect(result.error).toContain('confirm rename failed')
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(runtime.store.loadSync()).toEqual({
      version: 1,
      confirmed: PREVIOUS_CONFIG,
    })
  })

  it('returns the original error plus rollback failure and no effective config', async () => {
    const { manager } = makeManager({
      resume: async () => {
        throw new Error('resume always fails')
      },
    })

    const result = await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expectFailure(result, 'resume')
    expect(result.error).toContain('resume always fails')
    expect(result.rollback).toEqual({
      success: false,
      error: expect.stringContaining('resume always fails'),
      effectiveConfig: null,
    })
  })

  it('invokes the private rollback compensator only once and never recursively calls public apply', async () => {
    const { manager } = makeManager({
      refresh: async (_instance, call) => {
        if (call === 1) throw new Error('refresh failed')
      },
    })
    const apply = vi.spyOn(manager, 'applyModelContextRpc')
    const rollback = vi.spyOn(manager as never, 'rollbackModelContextOnce' as never)

    await manager.applyModelContextRpc(APPLY_PAYLOAD)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('skips strict resume when there is no current thread but still restarts, refreshes, and confirms', async () => {
    const { manager, backend } = makeManager({ codexThreadId: null })

    const result = await manager.applyModelContextRpc({
      ...APPLY_PAYLOAD,
      threadId: undefined,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        model: 'gpt-5.6-sol',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        threadRestored: false,
        requestVersion: 7,
      },
    })
    expect(backend.operations).toEqual([
      'persist-pending',
      'restart',
      'refresh-models',
      'persist-confirmed',
    ])
  })

  it('rejects send, steer, and a second context request immediately while the saga owns lifecycle', async () => {
    const restartGate = deferred<void>()
    const restartStarted = deferred<void>()
    const { manager, backend, events, threadStore, attachmentService } = makeManager({
      restart: async (instance, call) => {
        if (call === 1) {
          restartStarted.resolve()
          await restartGate.promise
        }
        instance.epoch += 1
      },
    })

    const applying = manager.applyModelContextRpc(APPLY_PAYLOAD)
    const send = manager.sendMessage({ content: 'must reject', attachments: [] })
    const steer = manager.steer({
      threadId: 'db-thread-1',
      content: 'must reject',
      attachments: [],
    })
    const second = manager.applyModelContextRpc({ ...APPLY_PAYLOAD, requestVersion: 8 })

    await expect(send).resolves.toEqual({ threadId: 'pending' })
    await expect(steer).resolves.toEqual({ threadId: 'db-thread-1' })
    const secondResult = await second
    expectFailure(secondResult, 'busy', 8)
    expect(threadStore.addMessage).not.toHaveBeenCalled()
    expect(attachmentService.ingest).not.toHaveBeenCalled()
    expect(backend.sendCalls).toBe(0)
    expect(backend.steerCalls).toBe(0)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(2)

    await restartStarted.promise
    restartGate.resolve()
    await applying
  })

  it('serializes Provider mutation after the complete context saga without interleaving', async () => {
    const restartGate = deferred<void>()
    const restartStarted = deferred<void>()
    const { manager, backend } = makeManager({
      restart: async (instance, call) => {
        if (call === 1) {
          restartStarted.resolve()
          await restartGate.promise
        }
        instance.epoch += 1
      },
    })

    const applying = manager.applyModelContextRpc(APPLY_PAYLOAD)
    await restartStarted.promise
    const provider = manager.setActiveProvider('rightcode')
    await flushMicrotasks()

    expect(backend.operations).toEqual(['persist-pending', 'restart'])
    restartGate.resolve()
    await expect(applying).resolves.toMatchObject({ ok: true })
    await expect(provider).resolves.toMatchObject({ activeId: 'rightcode' })

    const confirmedIndex = backend.operations.indexOf('persist-confirmed')
    const providerRestartIndex = backend.operations.lastIndexOf('restart')
    expect(confirmedIndex).toBeGreaterThan(-1)
    expect(providerRestartIndex).toBeGreaterThan(confirmedIndex)
  })

  it('queues Context behind an existing Provider transition without deadlock or interleaving', async () => {
    const providerGate = deferred<void>()
    const providerStarted = deferred<void>()
    const { manager, backend } = makeManager({
      restart: async (instance, call) => {
        if (call === 1) {
          providerStarted.resolve()
          await providerGate.promise
        }
        instance.epoch += 1
      },
    })

    const provider = manager.setActiveProvider('rightcode')
    await providerStarted.promise
    const applying = manager.applyModelContextRpc(APPLY_PAYLOAD)
    await flushMicrotasks()
    expect(backend.operations).toEqual(['restart'])

    providerGate.resolve()
    await expect(provider).resolves.toMatchObject({ activeId: 'rightcode' })
    await expect(applying).resolves.toMatchObject({ ok: true })
    expect(backend.operations).toEqual([
      'restart',
      'persist-pending',
      'restart',
      'resume:codex-thread-1',
      'refresh-models',
      'persist-confirmed',
    ])
  })

  it('accepts requestVersion zero and applies on a backend without epoch support using the compatibility policy', async () => {
    const { manager } = makeManager({ exposeEpoch: false })

    await expect(manager.applyModelContextRpc({
      ...APPLY_PAYLOAD,
      requestVersion: 0,
    })).resolves.toEqual({
      ok: true,
      data: {
        model: 'gpt-5.6-sol',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        threadRestored: true,
        requestVersion: 0,
      },
    })
  })

  it.each([
    ['empty model', { ...APPLY_PAYLOAD, model: '  ' }],
    ['negative version', { ...APPLY_PAYLOAD, requestVersion: -1 }],
    ['NaN version', { ...APPLY_PAYLOAD, requestVersion: Number.NaN }],
    ['fractional version', { ...APPLY_PAYLOAD, requestVersion: 1.5 }],
    ['unsafe version', { ...APPLY_PAYLOAD, requestVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['NaN context', { ...APPLY_PAYLOAD, contextWindow: Number.NaN }],
    ['negative context', { ...APPLY_PAYLOAD, contextWindow: -1 }],
    ['unknown context option', { ...APPLY_PAYLOAD, contextWindow: 123_456 }],
  ])('rejects invalid payload before any write: %s', async (_label, payload) => {
    const { manager, backend, runtime } = makeManager()

    const result = await manager.applyModelContextRpc(payload)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected validation failure')
    expect(result.stage).toBe('validate')
    expect(result.rollback).toEqual({ success: true, activeConfig: PREVIOUS_CONFIG })
    expect(backend.operations).toEqual([])
    expect(runtime.snapshots).toEqual([])
  })
})
