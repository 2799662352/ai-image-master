import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type {
  AgentModelSettingsCatalog,
  AgentStreamEvent,
} from '../../../types/agent'

let tmpDir: string

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

/**
 * Poisons a manager through a failed grok Channel switch, then heals restarts
 * so only the recovery-time validation under test can keep the poison.
 */
async function createPoisonedRecoveryManager(): Promise<{
  manager: AgentManager
  catalog: AgentModelSettingsCatalog
}> {
  let epoch = 1
  let failRestarts = false
  const backend = {
    async start() {},
    async stop() {},
    isHealthy: () => true,
    currentEpoch: () => epoch,
    setProvider: vi.fn(),
    async restartCodex() {
      if (failRestarts) throw new Error('runtime unhealthy')
      epoch += 1
    },
    async cancel() {},
    async *send(): AsyncIterable<AgentStreamEvent> {},
  } satisfies IAgentBackend
  const manager = new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-poisoned-catalog' }),
      addMessage: async () => ({ id: 'message-poisoned-catalog' }),
      updateLastMessageAt: async () => undefined,
    } as never,
    attachments: { ingest: async () => [] } as never,
    eventSink: () => {},
  })
  await manager.setCodexApiKey('test-key')
  const catalogResult = await manager.getModelSettingsCatalogRpc()
  if (!catalogResult.ok) throw new Error(catalogResult.error)
  failRestarts = true
  await expect(manager.sendMessage({
    content: 'poison runtime',
    attachments: [],
    model: 'grok-4.5',
  })).rejects.toThrow(/runtime unhealthy|recovery/i)
  failRestarts = false
  return { manager, catalog: catalogResult.data }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-selection-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager model-selection turn admission', () => {
  it('repairs a legacy model-only payload before persisting a user message', async () => {
    const operations: string[] = []
    const sentModels: string[] = []
    const backend = {
      async start() {
        operations.push('start')
      },
      async stop() {},
      isHealthy: () => false,
      setProvider: (provider: { id: string } | undefined) => {
        operations.push(`channel:${provider?.id ?? 'none'}`)
      },
      async cancel() {},
      async *send(_threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
        sentModels.push(input.model)
      },
    } satisfies IAgentBackend
    const store = {
      createThread: async () => {
        operations.push('thread')
        return { id: 'thread-1' }
      },
      addMessage: async () => {
        operations.push('message')
        return { id: 'message-1' }
      },
      updateLastMessageAt: async () => undefined,
    }
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: store as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalogResult = await manager.getModelSettingsCatalogRpc()
    if (!catalogResult.ok) throw new Error(catalogResult.error)
    const grok = catalogResult.data.models.find((model) => model.id === 'grok-4.5')
    if (!grok) throw new Error('Expected Grok catalog entry')
    operations.length = 0

    await manager.sendMessage({
      content: 'route me before persistence',
      attachments: [],
      model: grok.id,
    })

    expect(operations).toEqual([
      'channel:apiyi-grok',
      'start',
      'thread',
      'message',
    ])
    expect(sentModels).toEqual([grok.id])
  })

  it('rejects payload model and intent mismatch before start or persistence', async () => {
    const start = vi.fn(async () => undefined)
    const createThread = vi.fn(async () => ({ id: 'thread-mismatch' }))
    const addMessage = vi.fn(async () => ({ id: 'message-mismatch' }))
    const send = vi.fn(async function* (): AsyncIterable<AgentStreamEvent> {})
    const backend = {
      start,
      async stop() {},
      isHealthy: () => false,
      setProvider: vi.fn(),
      async cancel() {},
      send,
    } satisfies IAgentBackend
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread,
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalogResult = await manager.getModelSettingsCatalogRpc()
    if (!catalogResult.ok) throw new Error(catalogResult.error)
    const grok = catalogResult.data.models.find((model) => model.id === 'grok-4.5')
    if (!grok) throw new Error('Expected Grok catalog entry')
    start.mockClear()

    await expect(manager.sendMessage({
      content: 'mismatch',
      attachments: [],
      model: 'gpt-5.5',
      modelSelection: {
        gatewayId: catalogResult.data.gatewayId,
        modelId: grok.id,
        contextWindow: grok.capabilities.defaultContextWindow,
        catalogRevision: catalogResult.data.revision,
      },
    })).rejects.toThrow(/model.*mismatch|不一致/i)

    expect(start).not.toHaveBeenCalled()
    expect(createThread).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an invalid legacy model before every turn side effect', async () => {
    const start = vi.fn(async () => undefined)
    const createThread = vi.fn(async () => ({ id: 'thread-invalid' }))
    const addMessage = vi.fn(async () => ({ id: 'message-invalid' }))
    const send = vi.fn(async function* (): AsyncIterable<AgentStreamEvent> {})
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        start,
        async stop() {},
        isHealthy: () => false,
        async cancel() {},
        send,
      },
      store: {
        createThread,
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    start.mockClear()

    await expect(manager.sendMessage({
      content: 'invalid route',
      attachments: [],
      model: 'definitely-not-in-catalog',
    })).rejects.toThrow(/not in.*catalog|不在当前目录|unknown/i)

    expect(start).not.toHaveBeenCalled()
    expect(createThread).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('blocks subsequent sends after Channel recovery becomes unprovable', async () => {
    let epoch = 1
    let failRestarts = false
    let activeWork = false
    const createThread = vi.fn(async () => ({ id: 'thread-poisoned' }))
    const addMessage = vi.fn(async () => ({ id: 'message-poisoned' }))
    const backend = {
      async start() {},
      async stop() {},
      isHealthy: () => true,
      hasInFlightWork: () => activeWork,
      currentEpoch: () => epoch,
      setProvider: vi.fn(),
      async restartCodex() {
        if (failRestarts) throw new Error('runtime unhealthy')
        epoch += 1
      },
      async cancel() {},
      async *send(): AsyncIterable<AgentStreamEvent> {},
    } satisfies IAgentBackend
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread,
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalogResult = await manager.getModelSettingsCatalogRpc()
    if (!catalogResult.ok) throw new Error(catalogResult.error)
    failRestarts = true

    await expect(manager.sendMessage({
      content: 'poison runtime',
      attachments: [],
      model: 'grok-4.5',
    })).rejects.toThrow(/runtime unhealthy|recovery/i)
    await expect(manager.sendMessage({
      content: 'must stay blocked',
      attachments: [],
      model: 'gpt-5.5',
    })).rejects.toThrow(/recovery|恢复|unprovable/i)
    await expect(manager.setActiveProvider('rightcode')).rejects.toThrow(
      /model.selection recovery required|模型.*恢复/i,
    )

    const context = await manager.getModelContextConfigRpc()
    expect(context).toMatchObject({
      ok: true,
      data: {
        recoveryRequired: true,
        recoveryError: expect.stringMatching(/runtime unhealthy/i),
      },
    })
    activeWork = true
    await expect(
      (manager as unknown as {
        recoverModelSelectionRpc(): Promise<unknown>
      }).recoverModelSelectionRpc(),
    ).resolves.toMatchObject({
      ok: false,
      stage: 'busy',
      recoveryRequired: true,
    })
    activeWork = false
    await expect(
      (manager as unknown as {
        recoverModelSelectionRpc(): Promise<unknown>
      }).recoverModelSelectionRpc(),
    ).resolves.toMatchObject({
      ok: false,
      stage: 'recovery',
      recoveryRequired: true,
    })
    expect(await manager.getModelContextConfigRpc()).toMatchObject({
      ok: true,
      data: { recoveryRequired: true },
    })
    failRestarts = false
    const getCatalog = manager.getModelSettingsCatalogRpc.bind(manager)
    let failCatalogRefresh = true
    const catalogRefresh = vi.spyOn(
      manager,
      'getModelSettingsCatalogRpc',
    ).mockImplementation(async () => {
      if (failCatalogRefresh) {
        return { ok: false, error: 'catalog refresh failed' }
      }
      return getCatalog()
    })
    await expect(
      manager.recoverModelSelectionRpc(),
    ).resolves.toMatchObject({
      ok: false,
      stage: 'recovery',
      error: 'catalog refresh failed',
      recoveryRequired: true,
    })
    expect(await manager.getModelContextConfigRpc()).toMatchObject({
      ok: true,
      data: { recoveryRequired: true },
    })
    failCatalogRefresh = false
    await expect(
      (manager as unknown as {
        recoverModelSelectionRpc(): Promise<unknown>
      }).recoverModelSelectionRpc(),
    ).resolves.toMatchObject({
      ok: true,
      recoveryRequired: false,
    })
    expect(catalogRefresh).toHaveBeenCalledTimes(2)
    expect(await manager.getModelContextConfigRpc()).toMatchObject({
      ok: true,
      data: { recoveryRequired: false },
    })
    expect(createThread).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
  })

  it('does not restore a thread deleted while model recovery was poisoned', async () => {
    let epoch = 1
    let healthy = false
    let restartFailures = 0
    let threadExists = true
    const setThreadModel = vi.fn(async () => undefined)
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => healthy,
        currentEpoch: () => epoch,
        setProvider: vi.fn(),
        async restartCodex() {
          if (restartFailures > 0) {
            restartFailures -= 1
            throw new Error('runtime unhealthy')
          }
          epoch += 1
        },
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {},
      } satisfies IAgentBackend,
      store: {
        getThreadModelSnapshot: async () => (
          threadExists
            ? { exists: true as const, model: 'gpt-5.5' }
            : { exists: false as const }
        ),
        setThreadModel,
      } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    const grok = catalog.data.models.find((model) => model.id === 'grok-4.5')
    if (!grok) throw new Error('Expected Grok catalog entry')
    healthy = true
    restartFailures = 2

    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: grok.id,
      contextWindow: grok.capabilities.defaultContextWindow,
      catalogRevision: catalog.data.revision,
      threadId: 'deleted-during-recovery',
      requestVersion: 1,
    })).resolves.toMatchObject({
      ok: false,
      recoveryRequired: true,
    })
    setThreadModel.mockClear()
    threadExists = false

    await expect(manager.recoverModelSelectionRpc()).resolves.toMatchObject({
      ok: true,
      recoveryRequired: false,
      snapshot: {
        thread: { exists: false },
      },
    })
    expect(setThreadModel).not.toHaveBeenCalled()
  })

  it('lets a send keep its confirmed model when a later UI selection queues', async () => {
    let epoch = 1
    let blockNextRestart = false
    const restartStarted = deferred()
    const releaseRestart = deferred()
    const addMessage = vi.fn(async () => ({ id: 'message-stale-send' }))
    const sentModels: string[] = []
    const backend = {
      async start() {},
      async stop() {},
      isHealthy: () => true,
      currentEpoch: () => epoch,
      setProvider: vi.fn(),
      async restartCodex() {
        if (blockNextRestart) {
          blockNextRestart = false
          restartStarted.resolve()
          await releaseRestart.promise
        }
        epoch += 1
      },
      async cancel() {},
      async *send(
        _threadId: string | undefined,
        input: AgentInput,
      ): AsyncIterable<AgentStreamEvent> {
        sentModels.push(input.model)
      },
    } satisfies IAgentBackend
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-stale-send' }),
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    blockNextRestart = true
    const blockingRestart = manager.restartCodex()
    await restartStarted.promise

    const olderSend = manager.sendMessage({
      content: 'queued before selection',
      attachments: [],
      model: 'gpt-5.5',
    })
    const laterSelection = manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.4',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })
    releaseRestart.resolve()

    await blockingRestart
    await expect(olderSend).resolves.toMatchObject({
      threadId: 'thread-stale-send',
    })
    await expect(laterSelection).resolves.toMatchObject({
      ok: true,
      data: { modelId: 'gpt-5.4', requestVersion: 1 },
    })
    expect(addMessage).toHaveBeenCalledOnce()
    expect(sentModels).toEqual(['gpt-5.5'])
  })

  it('uses a pending renderer selection instead of a stale legacy send model', async () => {
    let epoch = 1
    let blockNextRestart = false
    const restartStarted = deferred()
    const releaseRestart = deferred()
    const sentModels: string[] = []
    const backend = {
      async start() {},
      async stop() {},
      isHealthy: () => true,
      currentEpoch: () => epoch,
      setProvider: vi.fn(),
      async restartCodex() {
        if (blockNextRestart) {
          blockNextRestart = false
          restartStarted.resolve()
          await releaseRestart.promise
        }
        epoch += 1
      },
      async cancel() {},
      async *send(
        _threadId: string | undefined,
        input: AgentInput,
      ): AsyncIterable<AgentStreamEvent> {
        sentModels.push(input.model)
      },
    } satisfies IAgentBackend
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-selection-first' }),
        addMessage: async () => ({ id: 'message-selection-first' }),
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    const grok = catalog.data.models.find((model) => model.id === 'grok-4.5')
    if (!grok) throw new Error('Expected Grok catalog entry')
    blockNextRestart = true

    const selection = manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: grok.id,
      contextWindow: grok.capabilities.defaultContextWindow,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })
    await restartStarted.promise
    const staleLegacySend = manager.sendMessage({
      content: 'must not route back to the stale model',
      attachments: [],
      model: 'gpt-5.5',
    })
    releaseRestart.resolve()

    await expect(selection).resolves.toMatchObject({
      ok: true,
      data: { modelId: grok.id },
    })
    await expect(staleLegacySend).resolves.toMatchObject({
      threadId: 'thread-selection-first',
    })
    expect(sentModels).toEqual([grok.id])
  })

  it('does not let a no-op steer reservation supersede a queued selection', async () => {
    let epoch = 1
    let blockNextRestart = false
    const restartStarted = deferred()
    const releaseRestart = deferred()
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => true,
        currentEpoch: () => epoch,
        setProvider: vi.fn(),
        async restartCodex() {
          if (blockNextRestart) {
            blockNextRestart = false
            restartStarted.resolve()
            await releaseRestart.promise
          }
          epoch += 1
        },
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {},
      } satisfies IAgentBackend,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    blockNextRestart = true
    const blockingRestart = manager.restartCodex()
    await restartStarted.promise

    const selection = manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.4',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })
    await expect(manager.steer({
      content: 'no thread means no steer turn',
      attachments: [],
    })).resolves.toEqual({ threadId: 'pending' })
    releaseRestart.resolve()

    await blockingRestart
    await expect(selection).resolves.toMatchObject({
      ok: true,
      data: { modelId: 'gpt-5.4' },
    })
  })

  it('switches gpt-5.5 to gpt-5.6-sol at native windows without restarting Codex', async () => {
    // Both models run unpinned (Codex resolves 272K/372K from its bundled
    // models.json), so a same-channel switch must not tear the process down —
    // this was the "5.5 切 5.6 卡住" restart.
    const restartCodex = vi.fn(async () => undefined)
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => true,
        hasInFlightWork: () => false,
        setProvider: vi.fn(),
        restartCodex,
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {},
      },
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    restartCodex.mockClear()

    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.6-sol',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })).resolves.toMatchObject({
      ok: true,
      data: { modelId: 'gpt-5.6-sol', contextWindow: 272_000 },
    })
    expect(restartCodex).not.toHaveBeenCalled()

    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.5',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 2,
    })).resolves.toMatchObject({
      ok: true,
      data: { modelId: 'gpt-5.5', contextWindow: 272_000 },
    })
    expect(restartCodex).not.toHaveBeenCalled()
  })

  it('still restarts when the selection pins a non-native context window', async () => {
    const restartCodex = vi.fn(async () => undefined)
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => true,
        hasInFlightWork: () => false,
        setProvider: vi.fn(),
        restartCodex,
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {},
      },
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    restartCodex.mockClear()

    // Model switches carry the previous window when supported, so the 1M pin
    // must come from the explicit Context control (context-only path).
    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.6-sol',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })).resolves.toMatchObject({
      ok: true,
      data: { modelId: 'gpt-5.6-sol', contextWindow: 272_000 },
    })
    expect(restartCodex).not.toHaveBeenCalled()

    await expect(manager.applyModelContextRpc({
      model: 'gpt-5.6-sol',
      contextWindow: 1_000_000,
      requestVersion: 1,
    })).resolves.toMatchObject({
      ok: true,
      data: { model: 'gpt-5.6-sol', contextWindow: 1_000_000 },
    })
    expect(restartCodex).toHaveBeenCalledTimes(1)

    // Unpinning back to the native window also requires one restart to drop
    // the launch override.
    await expect(manager.applyModelContextRpc({
      model: 'gpt-5.6-sol',
      contextWindow: 272_000,
      requestVersion: 2,
    })).resolves.toMatchObject({
      ok: true,
      data: { model: 'gpt-5.6-sol', contextWindow: 272_000 },
    })
    expect(restartCodex).toHaveBeenCalledTimes(2)
  })

  it('keeps model-selection and context requestVersion counters in separate namespaces', async () => {
    // The renderer owns TWO independent monotonic counters:
    // `modelSelectionRequestSequence` (model switches) and
    // `modelContextRequestSequence` (Context clicks). Funneling both into one
    // coordinator version namespace made a fresh Context click look stale as
    // soon as the user had switched models more often than they had touched
    // Context — the "点击切换上下文报错：模型选择已被更新的请求替代" bug.
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => true,
        hasInFlightWork: () => false,
        setProvider: vi.fn(),
        restartCodex: vi.fn(async () => undefined),
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {},
      },
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)

    // Two model switches drive the selection counter to 2.
    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.6-sol',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })).resolves.toMatchObject({ ok: true })
    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.6-luna',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 2,
    })).resolves.toMatchObject({ ok: true })

    // First Context click of the session: its own counter starts at 1 and
    // must NOT be judged stale against the selection counter.
    await expect(manager.applyModelContextRpc({
      model: 'gpt-5.6-luna',
      contextWindow: 1_000_000,
      requestVersion: 1,
    })).resolves.toMatchObject({
      ok: true,
      data: { model: 'gpt-5.6-luna', contextWindow: 1_000_000 },
    })

    // Symmetric direction: more Context clicks than model switches must not
    // block the next model switch either.
    await expect(manager.applyModelContextRpc({
      model: 'gpt-5.6-luna',
      contextWindow: 272_000,
      requestVersion: 2,
    })).resolves.toMatchObject({ ok: true })
    await expect(manager.applyModelContextRpc({
      model: 'gpt-5.6-luna',
      contextWindow: 1_000_000,
      requestVersion: 3,
    })).resolves.toMatchObject({ ok: true })
    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'gpt-5.5',
      contextWindow: 272_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 3,
    })).resolves.toMatchObject({ ok: true, data: { modelId: 'gpt-5.5' } })

    // Same-counter staleness is still enforced: an older Context version is
    // rejected once a newer one from the SAME counter has been reserved.
    await expect(manager.applyModelContextRpc({
      model: 'gpt-5.5',
      contextWindow: 272_000,
      requestVersion: 2,
    })).resolves.toMatchObject({ ok: false })
  })

  it('busy-gates Channel selection during turn/start admission before queue registration', async () => {
    const setProvider = vi.fn()
    const restartCodex = vi.fn(async () => undefined)
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => true,
        hasActiveTurns: () => false,
        hasInFlightWork: () => true,
        setProvider,
        restartCodex,
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {},
      },
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    setProvider.mockClear()
    restartCodex.mockClear()

    await expect(manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: 'grok-4.5',
      contextWindow: 500_000,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })).resolves.toMatchObject({
      ok: false,
      stage: 'busy',
      recoveryRequired: false,
    })
    expect(setProvider).not.toHaveBeenCalled()
    expect(restartCodex).not.toHaveBeenCalled()
  })

  it('rejects a missing existing thread before attachment or message side effects', async () => {
    const ingest = vi.fn(async () => [])
    const addMessage = vi.fn(async () => ({ id: 'message-missing-thread' }))
    const send = vi.fn(async function* (): AsyncIterable<AgentStreamEvent> {})
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => false,
        async cancel() {},
        send,
      },
      store: {
        getThreadModelSnapshot: vi.fn(async () => ({ exists: false })),
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')

    await expect(manager.sendMessage({
      threadId: 'missing-thread',
      content: 'must not persist',
      attachments: [],
      model: 'gpt-5.5',
    })).rejects.toThrow(/thread.*not found|线程.*不存在/i)
    expect(ingest).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('accepts an existing legacy thread with a null model', async () => {
    const setThreadModel = vi.fn(async () => undefined)
    const addMessage = vi.fn(async () => ({ id: 'message-legacy-thread' }))
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy: () => false,
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {},
      },
      store: {
        getThreadModelSnapshot: vi.fn(async () => ({
          exists: true,
          model: null,
        })),
        setThreadModel,
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')

    await expect(manager.sendMessage({
      threadId: 'legacy-thread',
      content: 'valid legacy thread',
      attachments: [],
      model: 'gpt-5.5',
    })).resolves.toMatchObject({ threadId: 'legacy-thread' })
    expect(setThreadModel).toHaveBeenCalledWith('legacy-thread', 'gpt-5.5')
    expect(addMessage).toHaveBeenCalled()
  })

  it('rejects an auxiliary provider key write queued before recovery poison landed', async () => {
    let epoch = 1
    let blockNextRestart = false
    let failRestarts = false
    let restartCalls = 0
    const restartStarted = deferred()
    const releaseRestart = deferred()
    const backend = {
      async start() {},
      async stop() {},
      isHealthy: () => true,
      currentEpoch: () => epoch,
      setProvider: vi.fn(),
      async restartCodex() {
        restartCalls += 1
        if (blockNextRestart) {
          blockNextRestart = false
          restartStarted.resolve()
          await releaseRestart.promise
        }
        if (failRestarts) throw new Error('runtime unhealthy')
        epoch += 1
      },
      async cancel() {},
      async *send(): AsyncIterable<AgentStreamEvent> {},
    } satisfies IAgentBackend
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalog = await manager.getModelSettingsCatalogRpc()
    if (!catalog.ok) throw new Error(catalog.error)
    const grok = catalog.data.models.find((model) => model.id === 'grok-4.5')
    if (!grok) throw new Error('Expected Grok catalog entry')
    failRestarts = true
    blockNextRestart = true

    const poisoningSelection = manager.applyModelSelectionRpc({
      gatewayId: catalog.data.gatewayId,
      modelId: grok.id,
      contextWindow: grok.capabilities.defaultContextWindow,
      catalogRevision: catalog.data.revision,
      requestVersion: 1,
    })
    await restartStarted.promise
    // Passes the entry-time poison check, then waits behind the selection.
    const auxKeyWrite = manager.setProviderApiKey('apiyi-mcp', 'aux-key-race')
    releaseRestart.resolve()

    await expect(poisoningSelection).resolves.toMatchObject({
      ok: false,
      recoveryRequired: true,
    })
    const restartsAfterPoison = restartCalls
    await expect(auxKeyWrite).rejects.toThrow(
      /model.selection recovery required|模型.*恢复/i,
    )
    expect(restartCalls).toBe(restartsAfterPoison)
    const providers = await manager.getProvidersSnapshot()
    expect(providers.apiKeys['apiyi-mcp']).toBeUndefined()
  })

  it('keeps poison when the refreshed recovery catalog drops the saved model', async () => {
    const { manager, catalog } = await createPoisonedRecoveryManager()
    vi.spyOn(manager, 'getModelSettingsCatalogRpc').mockResolvedValue({
      ok: true,
      data: {
        ...catalog,
        models: catalog.models.filter((model) => model.id !== 'gpt-5.5'),
      },
    })

    await expect(manager.recoverModelSelectionRpc()).resolves.toMatchObject({
      ok: false,
      stage: 'recovery',
      recoveryRequired: true,
      error: expect.stringMatching(/no longer contains model gpt-5\.5/i),
    })
    expect(await manager.getModelContextConfigRpc()).toMatchObject({
      ok: true,
      data: { recoveryRequired: true },
    })
  })

  it('keeps poison when the saved model is unavailable after recovery', async () => {
    const { manager, catalog } = await createPoisonedRecoveryManager()
    vi.spyOn(manager, 'getModelSettingsCatalogRpc').mockResolvedValue({
      ok: true,
      data: {
        ...catalog,
        models: catalog.models.map((model) => (
          model.id === 'gpt-5.5'
            ? {
                ...model,
                availability: {
                  status: 'needs-key' as const,
                  reason: 'API key required for recovery',
                },
              }
            : model
        )),
      },
    })

    await expect(manager.recoverModelSelectionRpc()).resolves.toMatchObject({
      ok: false,
      stage: 'recovery',
      recoveryRequired: true,
      error: expect.stringMatching(/API key required for recovery/i),
    })
    expect(await manager.getModelContextConfigRpc()).toMatchObject({
      ok: true,
      data: { recoveryRequired: true },
    })
  })

  it('keeps poison when the saved Context is unsupported after recovery', async () => {
    const { manager, catalog } = await createPoisonedRecoveryManager()
    vi.spyOn(manager, 'getModelSettingsCatalogRpc').mockResolvedValue({
      ok: true,
      data: {
        ...catalog,
        models: catalog.models.map((model) => (
          model.id === 'gpt-5.5'
            ? {
                ...model,
                capabilities: {
                  ...model.capabilities,
                  contextOptions: [{ value: 500_000, experimental: false }],
                },
              }
            : model
        )),
      },
    })

    await expect(manager.recoverModelSelectionRpc()).resolves.toMatchObject({
      ok: false,
      stage: 'recovery',
      recoveryRequired: true,
      error: expect.stringMatching(/context window 272000.*not supported/i),
    })
    expect(await manager.getModelContextConfigRpc()).toMatchObject({
      ok: true,
      data: { recoveryRequired: true },
    })
  })
})
