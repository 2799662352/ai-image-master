import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

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
    await expect(
      (manager as unknown as {
        recoverModelSelectionRpc(): Promise<unknown>
      }).recoverModelSelectionRpc(),
    ).resolves.toMatchObject({
      ok: true,
      recoveryRequired: false,
    })
    expect(await manager.getModelContextConfigRpc()).toMatchObject({
      ok: true,
      data: { recoveryRequired: false },
    })
    expect(createThread).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
  })

  it('reserves turn intent before the lifecycle queue so a later UI selection wins', async () => {
    let epoch = 1
    let blockNextRestart = false
    const restartStarted = deferred()
    const releaseRestart = deferred()
    const addMessage = vi.fn(async () => ({ id: 'message-stale-send' }))
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
      async *send(): AsyncIterable<AgentStreamEvent> {},
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
    await expect(olderSend).rejects.toThrow(/替代|superseded/i)
    await expect(laterSelection).resolves.toMatchObject({
      ok: true,
      data: { modelId: 'gpt-5.4', requestVersion: 1 },
    })
    expect(addMessage).not.toHaveBeenCalled()
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
})
