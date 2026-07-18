import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AgentManager } from '../AgentManager'
import {
  CodexRuntimeSettingsStore,
  type PersistedCodexRuntimeSettingsV1,
} from '../CodexRuntimeSettingsStore'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

const PREVIOUS_CONTEXT = {
  modelContextWindow: 272_000,
  modelAutoCompactTokenLimit: 244_800,
}

const TARGET_CONTEXT = {
  modelContextWindow: 1_000_000,
  modelAutoCompactTokenLimit: 900_000,
}

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-context-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeBackend(options: {
  restart?: (call: number) => Promise<void>
} = {}) {
  const operations: string[] = []
  let epoch = 1
  let restartCalls = 0
  const backend = {
    async start() {},
    async stop() {},
    isHealthy: () => true,
    currentEpoch: () => epoch,
    setProvider: (provider: { id: string } | undefined) => {
      operations.push(`channel:${provider?.id ?? 'none'}`)
    },
    async restartCodex() {
      restartCalls += 1
      operations.push('restart')
      if (options.restart) {
        await options.restart(restartCalls)
      }
      epoch += 1
    },
    async resumeThread(threadId: string) {
      operations.push(`resume:${threadId}`)
    },
    async cancel() {},
    async *send(): AsyncIterable<AgentStreamEvent> {},
  } satisfies IAgentBackend
  return {
    backend,
    operations,
    get restartCalls() {
      return restartCalls
    },
  }
}

async function createManager(options: {
  restart?: (call: number) => Promise<void>
} = {}) {
  const fixture = makeBackend(options)
  const runtimeStore = new CodexRuntimeSettingsStore(tmpDir)
  const setThreadModel = vi.fn(async () => undefined)
  const manager = new AgentManager({
    userDataDir: tmpDir,
    backend: fixture.backend,
    runtimeSettingsStore: runtimeStore,
    store: {
      getCodexThreadId: vi.fn(async () => 'codex-thread-1'),
      setCodexThreadId: vi.fn(async () => undefined),
      setThreadModel,
    } as never,
  })
  await manager.setCodexApiKey('test-key')
  fixture.operations.length = 0
  const catalogResult = await manager.getModelSettingsCatalogRpc()
  if (!catalogResult.ok) throw new Error(catalogResult.error)
  return {
    ...fixture,
    manager,
    runtimeStore,
    catalog: catalogResult.data,
    setThreadModel,
  }
}

describe('AgentManager model-context compatibility adapter', () => {
  it('maps Context IPC onto the selection transaction', async () => {
    const { manager, operations, runtimeStore, setThreadModel } = await createManager()

    const result = await manager.applyModelContextRpc({
      threadId: 'db-thread-1',
      model: 'gpt-5.5',
      contextWindow: TARGET_CONTEXT.modelContextWindow,
      requestVersion: 7,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        model: 'gpt-5.5',
        contextWindow: TARGET_CONTEXT.modelContextWindow,
        autoCompactTokenLimit: TARGET_CONTEXT.modelAutoCompactTokenLimit,
        threadRestored: true,
        requestVersion: 7,
      },
    })
    expect(operations).toEqual(['restart', 'resume:codex-thread-1'])
    expect(setThreadModel).toHaveBeenCalledWith('db-thread-1', 'gpt-5.5')
    expect(runtimeStore.loadSync()).toEqual({
      version: 1,
      confirmed: TARGET_CONTEXT,
    } satisfies PersistedCodexRuntimeSettingsV1)
  })

  it('rejects a context absent from the current catalog before mutation', async () => {
    const { manager, operations } = await createManager()

    const result = await manager.applyModelContextRpc({
      model: 'gpt-5.5',
      contextWindow: 123_456,
      requestVersion: 1,
    })

    expect(result).toMatchObject({
      ok: false,
      stage: 'catalog',
      rollback: { ok: true, activeConfig: PREVIOUS_CONTEXT },
    })
    expect(operations).toEqual([])
  })

  it('rolls the runtime context and persistence back when restart fails', async () => {
    const { manager, operations, runtimeStore } = await createManager({
      restart: async (call) => {
        // The first restart belongs to API-key setup; the selection's context
        // restart is the second and its compensating retry is the third.
        if (call === 2) throw new Error('replacement failed')
      },
    })

    const result = await manager.applyModelContextRpc({
      model: 'gpt-5.5',
      contextWindow: TARGET_CONTEXT.modelContextWindow,
      requestVersion: 1,
    })

    expect(result).toMatchObject({
      ok: false,
      stage: 'restart',
      rollback: { ok: true, activeConfig: PREVIOUS_CONTEXT },
    })
    expect(operations).toEqual(['restart', 'restart'])
    expect(runtimeStore.loadSync()).toEqual({
      version: 1,
      confirmed: PREVIOUS_CONTEXT,
    } satisfies PersistedCodexRuntimeSettingsV1)
  })

  it('does not restart when the context is already confirmed', async () => {
    const { manager, operations } = await createManager()

    const result = await manager.applyModelContextRpc({
      model: 'gpt-5.5',
      contextWindow: PREVIOUS_CONTEXT.modelContextWindow,
      requestVersion: 2,
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        model: 'gpt-5.5',
        contextWindow: PREVIOUS_CONTEXT.modelContextWindow,
        requestVersion: 2,
      },
    })
    expect(operations).toEqual([])
  })

  it('retains an active supported Context during model selection', async () => {
    const { manager, operations } = await createManager()
    const selected = await manager.applyModelContextRpc({
      model: 'gpt-5.4',
      contextWindow: 1_000_000,
      requestVersion: 21,
    })

    expect(selected).toMatchObject({
      ok: true,
      data: {
        model: 'gpt-5.4',
        contextWindow: PREVIOUS_CONTEXT.modelContextWindow,
      },
    })
    expect(operations).toEqual([])
  })

  it('restarts for an explicit Context adjustment on the persisted model', async () => {
    const { manager, operations } = await createManager()

    const result = await manager.applyModelContextRpc({
      model: 'gpt-5.5',
      contextWindow: TARGET_CONTEXT.modelContextWindow,
      requestVersion: 22,
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        model: 'gpt-5.5',
        contextWindow: TARGET_CONTEXT.modelContextWindow,
      },
    })
    expect(operations).toEqual(['restart'])
  })

  it('keeps confirmed Context public while a replacement restart is pending', async () => {
    const restartStarted = deferred()
    const releaseRestart = deferred()
    const { manager, runtimeStore } = await createManager({
      restart: async (call) => {
        if (call !== 2) return
        restartStarted.resolve()
        await releaseRestart.promise
      },
    })

    const applying = manager.applyModelContextRpc({
      model: 'gpt-5.5',
      contextWindow: TARGET_CONTEXT.modelContextWindow,
      requestVersion: 11,
    })
    await restartStarted.promise

    await expect(manager.getModelContextConfigRpc()).resolves.toEqual({
      ok: true,
      data: {
        ...PREVIOUS_CONTEXT,
        recoveryRequired: false,
      },
    })
    expect(runtimeStore.loadSync()).toEqual({
      version: 1,
      confirmed: PREVIOUS_CONTEXT,
    })

    releaseRestart.resolve()
    await expect(applying).resolves.toMatchObject({
      ok: true,
      data: {
        contextWindow: TARGET_CONTEXT.modelContextWindow,
      },
    })
  })
})
