// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentModelContextApplyResult,
  AgentModelContextSnapshotResult,
  AgentModelSettingsCatalog,
  AgentModelSettingsCatalogResult,
} from '../../../../../types/agent'

const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'
const CANONICAL_SELECTED_MODEL_STORAGE_KEY = 'agent.selectedModel:v2'
const MODEL_REASONING_STORAGE_KEY = 'agent.modelReasoningByModel:v1'
const MODEL_CONTEXT_STORAGE_KEY = 'agent.modelContextByModel:v1'

async function loadFreshStore() {
  vi.resetModules()
  const { useAgentChatStore } = await import('../store')
  return useAgentChatStore
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function modelCatalog(
  provider = 'apiyi',
  source: AgentModelSettingsCatalog['source'] = 'codex',
): AgentModelSettingsCatalog {
  return {
    provider,
    source,
    models: [
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'Frontier coding model',
        hidden: false,
        isDefault: true,
        capabilities: {
          model: 'gpt-5.6-sol',
          provider,
          defaultContextWindow: 372_000,
          contextOptions: [
            { value: 372_000, experimental: false },
            { value: 1_000_000, experimental: true },
          ],
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Stable coding model',
        hidden: false,
        isDefault: false,
        capabilities: {
          model: 'gpt-5.5',
          provider,
          defaultContextWindow: 272_000,
          contextOptions: [
            { value: 272_000, experimental: false },
            { value: 1_000_000, experimental: true },
          ],
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
      },
    ],
  }
}

function installModelSettingsApi(api: {
  getModelSettingsCatalog?: () => Promise<AgentModelSettingsCatalogResult>
  getModelContextConfig?: () => Promise<AgentModelContextSnapshotResult>
  applyModelContext?: (
    payload: {
      threadId?: string
      model: string
      contextWindow: number
      requestVersion: number
    },
  ) => Promise<AgentModelContextApplyResult>
}): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: api,
  }
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

describe('useAgentChatStore model settings persistence', () => {
  it('migrates a legacy effort picker id and immediately establishes the v2 boundary', async () => {
    localStorage.setItem(LEGACY_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.5-xhigh')

    const firstStore = await loadFreshStore()

    expect(firstStore.getState().selectedModelId).toBe('gpt-5.5')
    expect(firstStore.getState().modelReasoningEffortByModel).toEqual({
      'gpt-5.5': 'xhigh',
    })
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5')
    expect(JSON.parse(localStorage.getItem(MODEL_REASONING_STORAGE_KEY) ?? '{}')).toEqual({
      'gpt-5.5': 'xhigh',
    })

    localStorage.setItem(LEGACY_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.4-high')
    localStorage.removeItem(MODEL_REASONING_STORAGE_KEY)
    const secondStore = await loadFreshStore()

    expect(secondStore.getState().selectedModelId).toBe('gpt-5.5')
    expect(secondStore.getState().modelReasoningEffortByModel).toEqual({})
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5')
  })

  it('retries legacy effort migration after its reasoning-map write hits quota', async () => {
    localStorage.setItem(LEGACY_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.5-xhigh')
    const nativeSetItem = Storage.prototype.setItem
    let failReasoningWrite = true
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === MODEL_REASONING_STORAGE_KEY && failReasoningWrite) {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      }
      nativeSetItem.call(this, key, value)
    })

    const firstStore = await loadFreshStore()

    expect(firstStore.getState().modelReasoningEffortByModel).toEqual({
      'gpt-5.5': 'xhigh',
    })
    expect(localStorage.getItem(MODEL_REASONING_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBeNull()

    failReasoningWrite = false
    const secondStore = await loadFreshStore()

    expect(secondStore.getState().selectedModelId).toBe('gpt-5.5')
    expect(secondStore.getState().modelReasoningEffortByModel).toEqual({
      'gpt-5.5': 'xhigh',
    })
    expect(JSON.parse(localStorage.getItem(MODEL_REASONING_STORAGE_KEY) ?? '{}')).toEqual({
      'gpt-5.5': 'xhigh',
    })
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5')
  })

  it('retries only the v2 boundary after its write fails', async () => {
    localStorage.setItem(LEGACY_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.5-xhigh')
    const nativeSetItem = Storage.prototype.setItem
    let failCanonicalWrite = true
    let reasoningWrites = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === MODEL_REASONING_STORAGE_KEY) reasoningWrites += 1
      if (key === CANONICAL_SELECTED_MODEL_STORAGE_KEY && failCanonicalWrite) {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      }
      nativeSetItem.call(this, key, value)
    })

    const firstStore = await loadFreshStore()
    expect(firstStore.getState().modelReasoningEffortByModel).toEqual({
      'gpt-5.5': 'xhigh',
    })
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBeNull()
    expect(reasoningWrites).toBe(1)

    failCanonicalWrite = false
    const secondStore = await loadFreshStore()

    expect(secondStore.getState().modelReasoningEffortByModel).toEqual({
      'gpt-5.5': 'xhigh',
    })
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5')
    expect(reasoningWrites).toBe(1)
  })

  it('treats a v2 effort-looking slug as canonical and never lets legacy storage override it', async () => {
    localStorage.setItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.5-xhigh')
    localStorage.setItem(LEGACY_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.4-high')

    const store = await loadFreshStore()

    expect(store.getState().selectedModelId).toBe('gpt-5.5-xhigh')
    expect(store.getState().modelReasoningEffortByModel).toEqual({})
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5-xhigh')
  })

  it('preserves an unknown v2 slug across cold reload and sends that exact model', async () => {
    localStorage.setItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY, 'vendor-future-1m')
    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'thread-future' })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      agent: {
        sendMessage,
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    }

    const firstStore = await loadFreshStore()
    expect(firstStore.getState().selectedModelId).toBe('vendor-future-1m')
    const store = await loadFreshStore()
    expect(store.getState().selectedModelId).toBe('vendor-future-1m')

    store.setState({
      input: 'future model request',
      attachments: [],
      pendingReferences: [],
      messages: [],
      isRunning: false,
    } as never)
    await store.getState().send()

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      model: 'vendor-future-1m',
    }))
  })

  it.each(['', '   '])(
    'treats an empty or whitespace-only v2 slug %j as invalid without reviving legacy semantics',
    async (canonicalModel) => {
      localStorage.setItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY, canonicalModel)
      localStorage.setItem(LEGACY_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.4-high')

      const store = await loadFreshStore()

      expect(store.getState().selectedModelId).toBe('gpt-5.5')
      expect(store.getState().modelReasoningEffortByModel).toEqual({})
      expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5')
    },
  )

  it('preserves an existing per-model effort while migrating the legacy selected model', async () => {
    localStorage.setItem(LEGACY_SELECTED_MODEL_STORAGE_KEY, 'gpt-5.5-xhigh')
    localStorage.setItem(
      MODEL_REASONING_STORAGE_KEY,
      JSON.stringify({ 'gpt-5.5': 'low' }),
    )

    const store = await loadFreshStore()

    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(store.getState().modelReasoningEffortByModel).toEqual({
      'gpt-5.5': 'low',
    })
    expect(JSON.parse(localStorage.getItem(MODEL_REASONING_STORAGE_KEY) ?? '{}')).toEqual({
      'gpt-5.5': 'low',
    })
  })

  it('persists ordinary reasoning per model without changing the Plan preference', async () => {
    const store = await loadFreshStore()
    store.setState({ planReasoningEffort: 'high' } as never)

    store.getState().setModelReasoningEffort('gpt-5.6-sol', 'max')

    expect(store.getState().modelReasoningEffortByModel).toEqual({
      'gpt-5.6-sol': 'max',
    })
    expect(store.getState().planReasoningEffort).toBe('high')
    expect(JSON.parse(localStorage.getItem(MODEL_REASONING_STORAGE_KEY) ?? '{}')).toEqual({
      'gpt-5.6-sol': 'max',
    })
  })

  it('drops malformed persisted JSON without failing module initialization', async () => {
    localStorage.setItem(MODEL_REASONING_STORAGE_KEY, '{broken')
    localStorage.setItem(MODEL_CONTEXT_STORAGE_KEY, '{broken')

    const store = await loadFreshStore()

    expect(store.getState().modelReasoningEffortByModel).toEqual({})
    expect(store.getState().modelContextWindowByModel).toEqual({})
  })

  it('keeps only safe own entries with valid efforts and finite positive integer contexts', async () => {
    localStorage.setItem(
      MODEL_REASONING_STORAGE_KEY,
      '{"valid":"max","automatic":"auto","bad":"ultra","numeric":1,"__proto__":"high"}',
    )
    localStorage.setItem(
      MODEL_CONTEXT_STORAGE_KEY,
      '{"valid":200000,"zero":0,"negative":-1,"fractional":1.5,"string":"200000","overflow":1e400,"__proto__":100000}',
    )

    const store = await loadFreshStore()
    const state = store.getState()

    expect(state.modelReasoningEffortByModel).toEqual({
      valid: 'max',
      automatic: 'auto',
    })
    expect(state.modelContextWindowByModel).toEqual({ valid: 200_000 })
    expect(Object.prototype.hasOwnProperty.call(state.modelReasoningEffortByModel, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(state.modelContextWindowByModel, '__proto__')).toBe(false)
  })
})

describe('useAgentChatStore model settings lifecycle', () => {
  it('starts catalog and context reads together, dedupes in-flight loads, and commits their owner', async () => {
    const catalogResult = deferred<AgentModelSettingsCatalogResult>()
    const snapshotResult = deferred<AgentModelContextSnapshotResult>()
    const getModelSettingsCatalog = vi.fn(() => catalogResult.promise)
    const getModelContextConfig = vi.fn(() => snapshotResult.promise)
    installModelSettingsApi({ getModelSettingsCatalog, getModelContextConfig })
    const store = await loadFreshStore()

    const first = store.getState().loadModelSettingsCatalog()
    const duplicate = store.getState().loadModelSettingsCatalog()

    expect(getModelSettingsCatalog).toHaveBeenCalledOnce()
    expect(getModelContextConfig).toHaveBeenCalledOnce()
    expect(store.getState().modelSettingsLoading).toBe(true)

    catalogResult.resolve({ ok: true, data: modelCatalog() })
    snapshotResult.resolve({
      ok: true,
      data: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
      },
    })
    await Promise.all([first, duplicate])

    expect(store.getState()).toMatchObject({
      modelSettingsCatalog: modelCatalog(),
      activeModelContextWindow: 372_000,
      modelSettingsLoading: false,
      modelSettingsError: undefined,
    })
  })

  it('keeps prior data on partial load failure while committing the successful half', async () => {
    const previous = modelCatalog('rightcode')
    installModelSettingsApi({
      getModelSettingsCatalog: vi.fn().mockRejectedValue(new Error('catalog offline')),
      getModelContextConfig: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          modelContextWindow: 1_000_000,
          modelAutoCompactTokenLimit: 900_000,
        },
      }),
    })
    const store = await loadFreshStore()
    store.setState({ modelSettingsCatalog: previous } as never)

    await store.getState().loadModelSettingsCatalog()

    expect(store.getState().modelSettingsCatalog).toBe(previous)
    expect(store.getState().activeModelContextWindow).toBe(1_000_000)
    expect(store.getState().modelSettingsError).toMatch(/catalog offline/i)
    expect(store.getState().modelSettingsLoading).toBe(false)
  })

  it('ignores an older load generation after Provider invalidation and retry', async () => {
    const firstCatalog = deferred<AgentModelSettingsCatalogResult>()
    const firstSnapshot = deferred<AgentModelContextSnapshotResult>()
    const secondCatalog = deferred<AgentModelSettingsCatalogResult>()
    const secondSnapshot = deferred<AgentModelContextSnapshotResult>()
    const getModelSettingsCatalog = vi.fn()
      .mockReturnValueOnce(firstCatalog.promise)
      .mockReturnValueOnce(secondCatalog.promise)
    const getModelContextConfig = vi.fn()
      .mockReturnValueOnce(firstSnapshot.promise)
      .mockReturnValueOnce(secondSnapshot.promise)
    installModelSettingsApi({ getModelSettingsCatalog, getModelContextConfig })
    const store = await loadFreshStore()

    const first = store.getState().loadModelSettingsCatalog()
    store.getState().invalidateCollaborationCapabilities()
    const second = store.getState().loadModelSettingsCatalog('rightcode')
    secondCatalog.resolve({ ok: true, data: modelCatalog('rightcode') })
    secondSnapshot.resolve({
      ok: true,
      data: {
        modelContextWindow: 1_000_000,
        modelAutoCompactTokenLimit: 900_000,
      },
    })
    await second
    firstCatalog.resolve({ ok: true, data: modelCatalog('apiyi') })
    firstSnapshot.resolve({
      ok: true,
      data: {
        modelContextWindow: 200_000,
        modelAutoCompactTokenLimit: 180_000,
      },
    })
    await first

    expect(store.getState().modelSettingsCatalog?.provider).toBe('rightcode')
    expect(store.getState().activeModelContextWindow).toBe(1_000_000)
  })

  it('commits and persists context only after matching request success', async () => {
    const apply = deferred<AgentModelContextApplyResult>()
    const applyModelContext = vi.fn(() => apply.promise)
    installModelSettingsApi({ applyModelContext })
    const store = await loadFreshStore()
    store.setState({
      threadId: 'thread-1',
      selectedModelId: 'gpt-5.6-sol',
      activeModelContextWindow: 372_000,
      modelContextWindowByModel: {},
    } as never)

    const applying = store.getState().setModelContextWindow(1_000_000)

    expect(store.getState().modelContextWindowByModel).toEqual({})
    expect(store.getState().modelContextPending).toEqual({
      model: 'gpt-5.6-sol',
      contextWindow: 1_000_000,
      requestVersion: 1,
    })
    apply.resolve({
      ok: true,
      data: {
        model: 'gpt-5.6-sol',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        threadRestored: true,
        requestVersion: 1,
      },
    })
    await applying

    expect(store.getState().activeModelContextWindow).toBe(1_000_000)
    expect(store.getState().modelContextPending).toBeUndefined()
    expect(store.getState().modelContextWindowByModel).toEqual({
      'gpt-5.6-sol': 1_000_000,
    })
    expect(JSON.parse(localStorage.getItem(MODEL_CONTEXT_STORAGE_KEY) ?? '{}')).toEqual({
      'gpt-5.6-sol': 1_000_000,
    })
  })

  it('does not let stale success or failure overwrite or clear a newer request', async () => {
    const first = deferred<AgentModelContextApplyResult>()
    const second = deferred<AgentModelContextApplyResult>()
    const applyModelContext = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    installModelSettingsApi({ applyModelContext })
    const store = await loadFreshStore()
    store.setState({
      selectedModelId: 'gpt-5.6-sol',
      activeModelContextWindow: 372_000,
      modelContextWindowByModel: {},
    } as never)

    const firstApply = store.getState().setModelContextWindow(1_000_000)
    const secondApply = store.getState().setModelContextWindow(372_000)
    first.resolve({
      ok: false,
      error: 'stale failure',
      stage: 'restart',
      previousConfig: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
      },
      attemptedConfig: {
        modelContextWindow: 1_000_000,
        modelAutoCompactTokenLimit: 900_000,
      },
      requestVersion: 1,
      rollback: {
        ok: true,
        activeConfig: {
          modelContextWindow: 372_000,
          modelAutoCompactTokenLimit: 334_800,
        },
      },
    })
    await firstApply
    expect(store.getState().modelContextPending?.requestVersion).toBe(2)
    expect(store.getState().modelSettingsError).toBeUndefined()

    second.resolve({
      ok: true,
      data: {
        model: 'gpt-5.6-sol',
        contextWindow: 372_000,
        autoCompactTokenLimit: 334_800,
        threadRestored: false,
        requestVersion: 2,
      },
    })
    await secondApply
    expect(store.getState().activeModelContextWindow).toBe(372_000)
    expect(store.getState().modelContextPending).toBeUndefined()
  })

  it.each([
    [
      'restored rollback',
      {
        ok: true,
        activeConfig: {
          modelContextWindow: 372_000,
          modelAutoCompactTokenLimit: 334_800,
        },
      },
      /已恢复原 Context/,
    ],
    [
      'failed rollback',
      { ok: false, error: 'rollback restart failed', effectiveConfig: null },
      /手动重启/,
    ],
  ] as const)('surfaces %s without claiming the attempted context is active', async (
    _label,
    rollback,
    errorPattern,
  ) => {
    installModelSettingsApi({
      applyModelContext: vi.fn().mockResolvedValue({
        ok: false,
        error: 'restart failed',
        stage: 'restart',
        previousConfig: {
          modelContextWindow: 372_000,
          modelAutoCompactTokenLimit: 334_800,
        },
        attemptedConfig: {
          modelContextWindow: 1_000_000,
          modelAutoCompactTokenLimit: 900_000,
        },
        requestVersion: 1,
        rollback,
      }),
    })
    const store = await loadFreshStore()
    store.setState({
      selectedModelId: 'gpt-5.6-sol',
      activeModelContextWindow: 372_000,
      modelContextWindowByModel: {},
    } as never)

    await store.getState().setModelContextWindow(1_000_000)

    expect(store.getState().activeModelContextWindow).toBe(372_000)
    expect(store.getState().modelContextWindowByModel).toEqual({})
    expect(store.getState().modelContextPending).toBeUndefined()
    expect(store.getState().modelSettingsError).toMatch(errorPattern)
  })

  it.each(['missing', 'throwing'] as const)(
    'clears pending safely when the apply API is %s',
    async (kind) => {
      installModelSettingsApi({
        ...(kind === 'throwing'
          ? { applyModelContext: vi.fn().mockRejectedValue(new Error('bridge down')) }
          : {}),
      })
      const store = await loadFreshStore()
      store.setState({ selectedModelId: 'gpt-5.6-sol' } as never)

      await store.getState().setModelContextWindow(1_000_000)

      expect(store.getState().modelContextPending).toBeUndefined()
      expect(store.getState().modelSettingsError).toMatch(
        kind === 'throwing' ? /bridge down/i : /unavailable|不可用/i,
      )
    },
  )

  it('applies the target remembered context before committing an async model selection', async () => {
    const apply = deferred<AgentModelContextApplyResult>()
    const applyModelContext = vi.fn(() => apply.promise)
    installModelSettingsApi({ applyModelContext })
    const store = await loadFreshStore()
    store.setState({
      modelSettingsCatalog: modelCatalog(),
      selectedModelId: 'gpt-5.6-sol',
      activeModelContextWindow: 372_000,
      modelContextWindowByModel: { 'gpt-5.5': 1_000_000 },
    } as never)

    const selecting = store.getState().setSelectedModel('gpt-5.5')
    expect(store.getState().selectedModelId).toBe('gpt-5.6-sol')
    expect(applyModelContext).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.5',
      contextWindow: 1_000_000,
    }))
    apply.resolve({
      ok: true,
      data: {
        model: 'gpt-5.5',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        threadRestored: false,
        requestVersion: 1,
      },
    })
    await selecting

    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(localStorage.getItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY)).toBe('gpt-5.5')
  })

  it('keeps the old model when target context apply fails and skips apply for equal context', async () => {
    const applyModelContext = vi.fn().mockResolvedValue({
      ok: false,
      error: 'restart failed',
      stage: 'restart',
      previousConfig: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
      },
      attemptedConfig: {
        modelContextWindow: 1_000_000,
        modelAutoCompactTokenLimit: 900_000,
      },
      requestVersion: 1,
      rollback: {
        ok: true,
        activeConfig: {
          modelContextWindow: 372_000,
          modelAutoCompactTokenLimit: 334_800,
        },
      },
    } satisfies AgentModelContextApplyResult)
    installModelSettingsApi({ applyModelContext })
    const store = await loadFreshStore()
    store.setState({
      modelSettingsCatalog: modelCatalog(),
      selectedModelId: 'gpt-5.6-sol',
      activeModelContextWindow: 372_000,
      modelContextWindowByModel: { 'gpt-5.5': 1_000_000 },
    } as never)

    await store.getState().setSelectedModel('gpt-5.5')
    expect(store.getState().selectedModelId).toBe('gpt-5.6-sol')

    applyModelContext.mockClear()
    store.setState({
      modelContextWindowByModel: { 'gpt-5.5': 372_000 },
      modelSettingsError: undefined,
    } as never)
    await store.getState().setSelectedModel('gpt-5.5')
    expect(applyModelContext).not.toHaveBeenCalled()
    expect(store.getState().selectedModelId).toBe('gpt-5.5')
    expect(store.getState().modelContextWindowByModel['gpt-5.6-sol']).toBeUndefined()
    expect(store.getState().modelContextWindowByModel['gpt-5.5']).toBe(372_000)
  })
})
