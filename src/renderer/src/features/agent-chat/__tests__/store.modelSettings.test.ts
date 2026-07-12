// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'catimation.agent.selectedModel'
const CANONICAL_SELECTED_MODEL_STORAGE_KEY = 'agent.selectedModel:v2'
const MODEL_REASONING_STORAGE_KEY = 'agent.modelReasoningByModel:v1'
const MODEL_CONTEXT_STORAGE_KEY = 'agent.modelContextByModel:v1'

async function loadFreshStore() {
  vi.resetModules()
  const { useAgentChatStore } = await import('../store')
  return useAgentChatStore
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
