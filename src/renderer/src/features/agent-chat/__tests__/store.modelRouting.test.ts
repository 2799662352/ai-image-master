// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSelectionSnapshot,
  AgentModelSettingsCatalog,
  AgentModelSettingsEntry,
} from '../../../../../types/agent'

const CANONICAL_SELECTED_MODEL_STORAGE_KEY = 'agent.selectedModel:v2'

async function loadFreshStore() {
  vi.resetModules()
  const { useAgentChatStore } = await import('../store')
  return useAgentChatStore
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function catalogEntry(
  id: string,
  overrides: Partial<AgentModelSettingsEntry> = {},
): AgentModelSettingsEntry {
  return {
    id,
    displayName: id,
    description: `${id} entry`,
    hidden: false,
    isDefault: false,
    family: 'other',
    route: {
      gatewayId: 'rightcode',
      channelId: 'rightcode-standard',
      modelId: id,
      family: 'other',
    },
    availability: { status: 'available' },
    capabilities: {
      model: id,
      provider: 'rightcode',
      defaultContextWindow: 272_000,
      contextOptions: [
        { value: 272_000, experimental: false },
        { value: 1_000_000, experimental: true },
      ],
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    },
    ...overrides,
  }
}

function routingCatalog(): AgentModelSettingsCatalog {
  return {
    gatewayId: 'rightcode',
    revision: 'catalog-1',
    source: 'codex',
    models: [
      catalogEntry('gpt-5.5'),
      catalogEntry('grok-4.5', {
        route: {
          gatewayId: 'rightcode',
          channelId: 'rightcode-grok',
          modelId: 'grok-4.5',
          family: 'xai',
        },
        capabilities: {
          model: 'grok-4.5',
          provider: 'rightcode',
          defaultContextWindow: 1_000_000,
          contextOptions: [{ value: 1_000_000, experimental: false }],
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
        },
      }),
      catalogEntry('locked-model', {
        availability: { status: 'needs-key', reason: '缺少 API Key' },
      }),
    ],
  }
}

function selectionSnapshot(
  overrides: Partial<AgentModelSelectionSnapshot> = {},
): AgentModelSelectionSnapshot {
  return {
    gatewayId: 'rightcode',
    channelId: 'rightcode-grok',
    modelId: 'grok-4.5',
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 900_000,
    catalogRevision: 'catalog-1',
    backendEpoch: 2,
    threadRestored: false,
    ...overrides,
  }
}

function rollbackFailure(
  requestVersion: number,
): Extract<AgentModelSelectionApplyResult, { ok: false }> {
  return {
    ok: false,
    error: 'gateway timeout',
    kind: 'transient',
    stage: 'restart',
    retryable: true,
    recoveryRequired: false,
    requestVersion,
    previous: selectionSnapshot({
      channelId: 'rightcode-standard',
      modelId: 'gpt-5.5',
      contextWindow: 272_000,
      autoCompactTokenLimit: 244_800,
    }),
    rollback: {
      ok: true,
      snapshot: selectionSnapshot({
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
      }),
    },
  }
}

function installSelectionApi(
  applyModelSelection: (
    payload: AgentModelSelectionApplyPayload,
  ) => Promise<AgentModelSelectionApplyResult>,
): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { applyModelSelection },
  }
}

async function loadRoutingStore(
  applyModelSelection: (
    payload: AgentModelSelectionApplyPayload,
  ) => Promise<AgentModelSelectionApplyResult>,
) {
  installSelectionApi(applyModelSelection)
  const store = await loadFreshStore()
  store.setState({
    selectedModelId: 'gpt-5.5',
    activeModelContextWindow: 272_000,
    modelContextWindowByModel: {},
    modelSettingsCatalog: routingCatalog(),
  } as never)
  return store
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.resetModules()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('useAgentChatStore model routing transactions', () => {
  it('commits selectedModelId only after main confirms selection', async () => {
    const gate = deferred<AgentModelSelectionApplyResult>()
    const applyModelSelection = vi.fn(() => gate.promise)
    const store = await loadRoutingStore(applyModelSelection)

    const pending = store.getState().setSelectedModel('grok-4.5')

    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(store.getState().modelSelectionPending?.modelId).toBe('grok-4.5')
    expect(applyModelSelection).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: 'rightcode',
      modelId: 'grok-4.5',
      contextWindow: 1_000_000,
      catalogRevision: 'catalog-1',
      requestVersion: 1,
    }))

    gate.resolve({
      ok: true,
      data: { ...selectionSnapshot(), requestVersion: 1 },
    })
    await expect(pending).resolves.toBe(true)

    expect(store.getState().selectedModelId).toBe('grok-4.5')
    expect(store.getState().activeModelContextWindow).toBe(1_000_000)
    expect(store.getState().modelSelectionSnapshot?.channelId).toBe('rightcode-grok')
    expect(store.getState().modelSelectionPending).toBeUndefined()
    expect(store.getState().modelSelectionError).toBeUndefined()
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('grok-4.5')
  })

  it('keeps the old model and exposes retry after rollback', async () => {
    const applyModelSelection = vi.fn(async (
      payload: AgentModelSelectionApplyPayload,
    ): Promise<AgentModelSelectionApplyResult> =>
      rollbackFailure(payload.requestVersion))
    const store = await loadRoutingStore(applyModelSelection)

    await expect(store.getState().setSelectedModel('grok-4.5')).resolves.toBe(false)

    expect(store.getState()).toMatchObject({
      selectedModelId: 'gpt-5.5',
      modelSelectionError: {
        message: 'gateway timeout',
        kind: 'transient',
        retryable: true,
      },
    })
    expect(store.getState().modelSelectionPending).toBeUndefined()
    expect(store.getState().modelSelectionFailedIntent?.modelId).toBe('grok-4.5')
    // Store bootstrap persists the restored default id; rollback must not
    // overwrite it with the attempted model.
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5')

    applyModelSelection.mockImplementation(async (payload) => ({
      ok: true,
      data: { ...selectionSnapshot(), requestVersion: payload.requestVersion },
    }))

    await expect(store.getState().retryModelSelection()).resolves.toBe(true)

    expect(applyModelSelection).toHaveBeenLastCalledWith(expect.objectContaining({
      modelId: 'grok-4.5',
      requestVersion: 2,
    }))
    expect(store.getState().selectedModelId).toBe('grok-4.5')
    expect(store.getState().modelSelectionFailedIntent).toBeUndefined()
    expect(store.getState().modelSelectionError).toBeUndefined()
  })

  it('rejects unknown or unavailable catalog rows without IPC', async () => {
    const applyModelSelection = vi.fn()
    const store = await loadRoutingStore(applyModelSelection)

    await expect(store.getState().setSelectedModel('missing-model')).resolves.toBe(false)
    await expect(store.getState().setSelectedModel('locked-model')).resolves.toBe(false)

    expect(applyModelSelection).not.toHaveBeenCalled()
    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(store.getState().modelSelectionPending).toBeUndefined()
  })

  it('discards a superseded response and commits only the latest request', async () => {
    const first = deferred<AgentModelSelectionApplyResult>()
    const second = deferred<AgentModelSelectionApplyResult>()
    const applyModelSelection = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = await loadRoutingStore(applyModelSelection)

    const stale = store.getState().setSelectedModel('grok-4.5')
    const latest = store.getState().setSelectedModel('gpt-5.5')

    first.resolve({
      ok: true,
      data: { ...selectionSnapshot(), requestVersion: 1 },
    })
    await expect(stale).resolves.toBe(false)
    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(store.getState().modelSelectionPending?.requestVersion).toBe(2)

    second.resolve({
      ok: true,
      data: {
        ...selectionSnapshot({
          channelId: 'rightcode-standard',
          modelId: 'gpt-5.5',
          contextWindow: 272_000,
          autoCompactTokenLimit: 244_800,
        }),
        requestVersion: 2,
      },
    })
    await expect(latest).resolves.toBe(true)
    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(store.getState().modelSelectionSnapshot?.modelId).toBe('gpt-5.5')
    expect(store.getState().modelSelectionPending).toBeUndefined()
  })

  it('keeps a supported active Context and falls back per-model then default', async () => {
    const applyModelSelection = vi.fn(async (
      payload: AgentModelSelectionApplyPayload,
    ): Promise<AgentModelSelectionApplyResult> => ({
      ok: true,
      data: {
        ...selectionSnapshot({
          modelId: payload.modelId,
          contextWindow: payload.contextWindow,
        }),
        requestVersion: payload.requestVersion,
      },
    }))
    const store = await loadRoutingStore(applyModelSelection)

    // Active 272k is NOT supported by grok (1M only) and no memory → default 1M.
    await store.getState().setSelectedModel('grok-4.5')
    expect(applyModelSelection).toHaveBeenLastCalledWith(expect.objectContaining({
      modelId: 'grok-4.5',
      contextWindow: 1_000_000,
    }))

    // Active 1M IS supported by gpt-5.5 → preserved over the remembered value.
    store.setState({
      modelContextWindowByModel: { 'gpt-5.5': 272_000 },
    } as never)
    await store.getState().setSelectedModel('gpt-5.5')
    expect(applyModelSelection).toHaveBeenLastCalledWith(expect.objectContaining({
      modelId: 'gpt-5.5',
      contextWindow: 1_000_000,
    }))

    // Unsupported active + unsupported memory → validated back to the default.
    store.setState({
      selectedModelId: 'gpt-5.5',
      activeModelContextWindow: 137_000,
      modelContextWindowByModel: { 'grok-4.5': 500_000 },
    } as never)
    await store.getState().setSelectedModel('grok-4.5')
    expect(applyModelSelection).toHaveBeenLastCalledWith(expect.objectContaining({
      modelId: 'grok-4.5',
      contextWindow: 1_000_000,
    }))
  })

  it('poisons the settings owner when a failed selection requires recovery', async () => {
    const applyModelSelection = vi.fn(async (
      payload: AgentModelSelectionApplyPayload,
    ): Promise<AgentModelSelectionApplyResult> => ({
      ...rollbackFailure(payload.requestVersion),
      recoveryRequired: true,
      retryable: false,
      rollback: {
        ok: false,
        error: 'rollback restart failed',
        effectiveSnapshot: null,
      },
    }))
    const store = await loadRoutingStore(applyModelSelection)

    await expect(store.getState().setSelectedModel('grok-4.5')).resolves.toBe(false)

    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(store.getState().modelSettingsRecoveryRequired).toBe(true)
    expect(store.getState().modelSettingsError).toMatch(/回滚未恢复.*手动重启/)
    expect(store.getState().modelSelectionError).toMatchObject({
      kind: 'transient',
      retryable: false,
    })
  })

  it('blocks send and steer while a selection transaction is pending', async () => {
    const gate = deferred<AgentModelSelectionApplyResult>()
    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'thread-1' })
    const steer = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      agent: {
        applyModelSelection: () => gate.promise,
        sendMessage,
        steer,
      },
    }
    const store = await loadFreshStore()
    store.setState({
      selectedModelId: 'gpt-5.5',
      activeModelContextWindow: 272_000,
      modelContextWindowByModel: {},
      modelSettingsCatalog: routingCatalog(),
    } as never)

    const pending = store.getState().setSelectedModel('grok-4.5')
    expect(store.getState().modelSelectionPending?.modelId).toBe('grok-4.5')

    store.setState({
      input: 'hello during switch',
      attachments: [],
      pendingReferences: [],
      isRunning: false,
    } as never)
    await store.getState().send()
    expect(sendMessage).not.toHaveBeenCalled()

    store.setState({ isRunning: true, threadId: 'thread-1' } as never)
    await store.getState().steer()
    expect(steer).not.toHaveBeenCalled()

    store.setState({ isRunning: false } as never)
    gate.resolve({
      ok: true,
      data: { ...selectionSnapshot(), requestVersion: 1 },
    })
    await expect(pending).resolves.toBe(true)

    await store.getState().send()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
