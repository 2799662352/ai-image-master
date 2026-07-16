import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import type { ApiSite } from '../services/api'
import { useAgentChatStore } from '../features/agent-chat/store'

/**
 * Renderer-side mirror of `ProviderPreset` from
 * `src/main/agent/codexProviders.ts` (kept in sync with the same shape exposed
 * by the preload script's CodexProviderRecord). We redeclare it here instead
 * of importing from preload to avoid pulling Node typings into renderer code.
 */
export interface CodexProvider {
  id: string
  name: string
  baseUrl: string
  envKey: string
  model?: string
  reasoningEffort?: string
  verbosity?: string
  credentialId?: string
  allowedModels?: readonly string[]
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Record<string, string | boolean | number>
  description?: string
  isCustom?: boolean
}

export interface CodexCustomProviderInput {
  name: string
  baseUrl: string
  envKey?: string
  model?: string
  reasoningEffort?: string
  verbosity?: string
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Record<string, string | boolean | number>
  description?: string
}

interface ProvidersSlice {
  builtins: CodexProvider[]
  custom: CodexProvider[]
  /** Provider confirmed as applied by the main-process backend. */
  activeId: string
  /** Last Provider confirmed as applied by the main-process backend. */
  appliedId: string
  /** Latest requested Provider while main applies a new backend generation. */
  pendingProviderId: string | null
  apiKeys: Record<string, string>
  loaded: boolean
  loadError: string | null
}

interface SettingsState {
  sites: Record<string, ApiSite>
  activeSiteKey: string
  apiKey: string
  visionApiKey: string
  /** API key for the *currently active* Codex provider. Mirrors providers.apiKeys[activeId]. */
  codexApiKey: string
  localPort: string
  connectionStatus: 'idle' | 'testing' | 'success' | 'error'
  saving: boolean
  loadError: string | null

  /** Codex provider state (apiyi / rightcode / custom). v4.3+. */
  providers: ProvidersSlice

  loadFromService: (api: ApiActions) => Promise<void>
  switchSite: (key: string, api: ApiActions) => void
  setApiKey: (key: string) => void
  setVisionApiKey: (key: string) => void
  setCodexApiKey: (key: string) => void
  setLocalPort: (port: string, api: ApiActions) => void
  testConnection: (api: ApiActions) => Promise<boolean>
  saveAll: (api: ApiActions) => Promise<void>

  /** ---- Codex provider actions (v4.3+) ---- */
  loadProviders: () => Promise<void>
  selectProvider: (id: string) => Promise<void>
  saveProviderKey: (id: string, key: string) => Promise<void>
  addProvider: (input: CodexCustomProviderInput) => Promise<CodexProvider | null>
  updateProvider: (id: string, patch: Partial<CodexCustomProviderInput>) => Promise<void>
  removeProvider: (id: string) => Promise<void>
}

const CODEX_API_KEY_STORAGE_KEY = 'codex_api_key'
let providerWriteGeneration = 0

interface ProviderMutationResponse {
  ok?: boolean
  error?: string
  activeId?: string
  providerGeneration?: number
}

interface AgentBridge {
  getProviders?: () => Promise<unknown>
  setActiveProvider?: (id: string) => Promise<unknown>
  setProviderApiKey?: (id: string, key: string) => Promise<unknown>
  addCustomProvider?: (input: CodexCustomProviderInput) => Promise<unknown>
  updateCustomProvider?: (
    id: string,
    patch: Partial<CodexCustomProviderInput>,
  ) => Promise<unknown>
  removeCustomProvider?: (id: string) => Promise<unknown>
  setApiKey?: (key: string) => Promise<unknown>
}

function getAgentBridge(): AgentBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { electronAPI?: { agent?: AgentBridge } }).electronAPI?.agent
}

async function reloadAgentModelCapabilities(providerId: string): Promise<void> {
  const agentChat = useAgentChatStore.getState()
  await Promise.all([
    agentChat.loadCollaborationCapabilities(providerId),
    agentChat.loadModelSettingsCatalog(providerId),
  ])
}

const DEFAULT_PROVIDERS_SLICE: ProvidersSlice = {
  builtins: [],
  custom: [],
  activeId: 'apiyi',
  appliedId: 'apiyi',
  pendingProviderId: null,
  apiKeys: {},
  loaded: false,
  loadError: null,
}

function unwrapSnapshot(raw: unknown): {
  builtins: CodexProvider[]
  custom: CodexProvider[]
  activeId: string
  apiKeys: Record<string, string>
} | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.ok === false) return null
  const builtins = Array.isArray(obj.builtins) ? (obj.builtins as CodexProvider[]) : []
  const custom = Array.isArray(obj.custom) ? (obj.custom as CodexProvider[]) : []
  const activeId = typeof obj.activeId === 'string' && obj.activeId ? obj.activeId : 'apiyi'
  const apiKeys =
    obj.apiKeys && typeof obj.apiKeys === 'object'
      ? (obj.apiKeys as Record<string, string>)
      : {}
  return { builtins, custom, activeId, apiKeys }
}

type ProviderSnapshot = NonNullable<ReturnType<typeof unwrapSnapshot>>

function credentialIdForProvider(
  providers: Pick<ProvidersSlice, 'builtins' | 'custom'>,
  id: string,
): string {
  const provider = [...providers.builtins, ...providers.custom].find(
    (candidate) => candidate.id === id,
  )
  return provider?.credentialId || id
}

function apiKeyForProvider(
  providers: Pick<ProvidersSlice, 'builtins' | 'custom' | 'apiKeys'>,
  id: string,
): string {
  return providers.apiKeys[credentialIdForProvider(providers, id)] ?? ''
}

async function fetchProviderSnapshot(bridge: AgentBridge): Promise<ProviderSnapshot> {
  if (!bridge.getProviders) {
    throw new Error('getProviders unavailable')
  }
  const snapshot = unwrapSnapshot(await bridge.getProviders())
  if (!snapshot) {
    throw new Error('invalid Provider snapshot')
  }
  return snapshot
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const commitProviderSnapshot = (snapshot: ProviderSnapshot) => {
    const codexKey = apiKeyForProvider(snapshot, snapshot.activeId)
    set({
      providers: {
        ...snapshot,
        appliedId: snapshot.activeId,
        pendingProviderId: null,
        loaded: true,
        loadError: null,
      },
      codexApiKey: codexKey,
    })
  }

  const recoverProviderSnapshot = async (
    bridge: AgentBridge,
    requestGeneration: number,
  ): Promise<ProviderSnapshot | null> => {
    let snapshot: ProviderSnapshot
    try {
      snapshot = await fetchProviderSnapshot(bridge)
    } catch (error) {
      if (requestGeneration === providerWriteGeneration) {
        set((state) => ({
          providers: {
            ...state.providers,
            pendingProviderId: null,
            loadError: error instanceof Error ? error.message : String(error),
          },
        }))
      }
      throw error
    }
    if (requestGeneration !== providerWriteGeneration) return null
    commitProviderSnapshot(snapshot)
    return snapshot
  }

  return {
  sites: {},
  activeSiteKey: '',
  apiKey: '',
  visionApiKey: '',
  codexApiKey: '',
  localPort: '3000',
  connectionStatus: 'idle',
  saving: false,
  loadError: null,
  providers: DEFAULT_PROVIDERS_SLICE,

  loadFromService: async (api) => {
    try {
      const sites = api.getAllSites()
      const currentKey = api.currentSiteKey

      const storedKey = api.getStoredApiKey(currentKey)
      const currentSite = api.getCurrentSite()
      const apiKey = storedKey || currentSite?.defaultApiKey || ''

      const visionKey = api.getStoredVisionApiKey(currentKey)
      // Legacy fallback used while the main process is still warming up. The
      // authoritative source is `loadProviders()` below — we kick that off
      // immediately and let it overwrite codexApiKey once data arrives.
      const legacyCodexKey = localStorage.getItem(CODEX_API_KEY_STORAGE_KEY) ?? ''

      set({
        sites,
        activeSiteKey: currentKey,
        apiKey,
        visionApiKey: visionKey || '',
        codexApiKey: legacyCodexKey,
        localPort: api.getLocalPort(),
        connectionStatus: 'idle',
        loadError: null,
      })

      void get().loadProviders()
    } catch (err) {
      set({ loadError: err instanceof Error ? err.message : String(err) })
    }
  },

  switchSite: (key, api) => {
    api.setSite(key)
    const storedKey = api.getStoredApiKey(key)
    const storedVisionKey = api.getStoredVisionApiKey(key)
    const siteConfig = api.getSiteConfig(key)
    set({
      activeSiteKey: key,
      apiKey: storedKey || siteConfig?.defaultApiKey || '',
      visionApiKey: storedVisionKey || '',
      connectionStatus: 'idle',
    })
  },

  setApiKey: (key) => set({ apiKey: key }),

  setVisionApiKey: (key) => set({ visionApiKey: key }),

  setCodexApiKey: (key) => {
    const trimmed = key.trim()
    const { providers } = get()
    const credentialId = credentialIdForProvider(providers, providers.activeId)
    set({
      codexApiKey: trimmed,
      providers: {
        ...providers,
        apiKeys: { ...providers.apiKeys, [credentialId]: trimmed },
      },
    })
  },

  setLocalPort: (port, api) => {
    api.setLocalPort(port)
    const sites = api.getAllSites()
    set({ localPort: port, sites })
  },

  testConnection: async (api) => {
    set({ connectionStatus: 'testing' })
    try {
      const ok = await api.testConnection(get().apiKey)
      set({ connectionStatus: ok ? 'success' : 'error' })
      return ok
    } catch {
      set({ connectionStatus: 'error' })
      return false
    }
  },

  saveAll: async (api) => {
    set({ saving: true })
    try {
      api.saveApiKey(get().apiKey)
      api.saveVisionApiKey(get().visionApiKey)
      // Keep the legacy localStorage path alive for one more release so that
      // a renderer with no electronAPI bridge (web-only dev mode) still sees
      // its key after refresh. The main-process write happens via
      // saveProviderKey/setApiKey from SettingsPage.
      localStorage.setItem(CODEX_API_KEY_STORAGE_KEY, get().codexApiKey)
    } finally {
      set({ saving: false })
    }
  },

  loadProviders: async () => {
    const bridge = getAgentBridge()
    if (!bridge?.getProviders) {
      // Browser-only / pre-bridge contexts: keep DEFAULT slice so UI doesn't crash.
      return
    }
    try {
      commitProviderSnapshot(await fetchProviderSnapshot(bridge))
    } catch (err) {
      set({
        providers: {
          ...DEFAULT_PROVIDERS_SLICE,
          loaded: true,
          loadError: err instanceof Error ? err.message : String(err),
        },
      })
    }
  },

  selectProvider: async (id) => {
    const bridge = getAgentBridge()
    if (!bridge?.setActiveProvider) return
    const requestGeneration = ++providerWriteGeneration
    set((state) => ({
      providers: { ...state.providers, pendingProviderId: id },
    }))
    useAgentChatStore.getState().invalidateCollaborationCapabilities()
    try {
      const result = (await bridge.setActiveProvider(id)) as ProviderMutationResponse
      if (result?.ok !== true) {
        throw new Error(result?.error || 'setActiveProvider rejected')
      }
      if (requestGeneration !== providerWriteGeneration) return
      const confirmed = result?.activeId ?? id
      set((state) => ({
        providers: {
          ...state.providers,
          activeId: confirmed,
          appliedId: confirmed,
          pendingProviderId: null,
        },
        codexApiKey: apiKeyForProvider(state.providers, confirmed),
      }))
      await reloadAgentModelCapabilities(confirmed)
      if (requestGeneration !== providerWriteGeneration) return
      const current = get().providers
      const provider = [...current.builtins, ...current.custom].find(
        (candidate) => candidate.id === confirmed,
      )
      const agentChat = useAgentChatStore.getState()
      const catalog = agentChat.modelSettingsCatalog?.provider === confirmed
        ? agentChat.modelSettingsCatalog
        : undefined
      const selectedInCatalog = catalog?.models.some(
        (model) => model.id === agentChat.selectedModelId,
      ) === true
      const catalogDefault = catalog?.models.find((model) => model.isDefault)
        ?? catalog?.models[0]
      const targetModel = provider?.model
        ?? (selectedInCatalog ? undefined : catalogDefault?.id)
      if (targetModel && targetModel !== agentChat.selectedModelId) {
        await agentChat.setSelectedModel(targetModel)
      }
    } catch (err) {
      if (requestGeneration !== providerWriteGeneration) return
      const snapshot = await recoverProviderSnapshot(bridge, requestGeneration)
      if (!snapshot) return
      const agentChat = useAgentChatStore.getState()
      agentChat.invalidateCollaborationCapabilities()
      await reloadAgentModelCapabilities(snapshot.activeId)
      throw err
    }
  },

  saveProviderKey: async (id, key) => {
    const trimmed = key.trim()
    const { providers } = get()
    if (providers.pendingProviderId !== null) {
      throw new Error('Provider switch in progress')
    }
    const credentialId = credentialIdForProvider(providers, id)
    const previousKey = providers.apiKeys[credentialId] ?? ''
    const changesAppliedProvider = id === providers.activeId
    const requestGeneration = changesAppliedProvider
      ? ++providerWriteGeneration
      : undefined
    // Optimistic local update first so UI feels instant.
    set({
      providers: {
        ...providers,
        apiKeys: { ...providers.apiKeys, [credentialId]: trimmed },
      },
      ...(id === providers.activeId ? { codexApiKey: trimmed } : {}),
    })
    if (changesAppliedProvider) {
      useAgentChatStore.getState().invalidateCollaborationCapabilities()
    }
    const bridge = getAgentBridge()
    if (bridge?.setProviderApiKey) {
      try {
        const result = (await bridge.setProviderApiKey(id, trimmed)) as ProviderMutationResponse
        if (result?.ok !== true) {
          throw new Error(result?.error || 'setProviderApiKey rejected')
        }
        if (
          requestGeneration !== undefined
          && requestGeneration === providerWriteGeneration
        ) {
          const confirmed = result.activeId ?? providers.appliedId
          set((state) => ({
            providers: {
              ...state.providers,
              activeId: confirmed,
              appliedId: confirmed,
              pendingProviderId: null,
            },
            codexApiKey: apiKeyForProvider(state.providers, confirmed),
          }))
          await reloadAgentModelCapabilities(confirmed)
        }
      } catch (err) {
        if (
          requestGeneration !== undefined
          && requestGeneration === providerWriteGeneration
        ) {
          const snapshot = await recoverProviderSnapshot(bridge, requestGeneration)
          if (snapshot) {
            const agentChat = useAgentChatStore.getState()
            agentChat.invalidateCollaborationCapabilities()
            await reloadAgentModelCapabilities(snapshot.activeId)
          }
        } else if (requestGeneration === undefined) {
          set((state) => ({
            providers: {
              ...state.providers,
              apiKeys: { ...state.providers.apiKeys, [credentialId]: previousKey },
            },
          }))
        }
        throw err
      }
    }
  },

  addProvider: async (input) => {
    const bridge = getAgentBridge()
    if (!bridge?.addCustomProvider) return null
    try {
      const raw = (await bridge.addCustomProvider(input)) as {
        ok?: boolean
        provider?: CodexProvider
        error?: string
      }
      if (!raw?.ok || !raw.provider) {
        console.warn('addProvider rejected:', raw?.error)
        return null
      }
      const { providers } = get()
      set({
        providers: { ...providers, custom: [...providers.custom, raw.provider] },
      })
      return raw.provider
    } catch (err) {
      console.warn('addProvider failed:', err)
      return null
    }
  },

  updateProvider: async (id, patch) => {
    const providerState = get().providers
    if (providerState.pendingProviderId === id) {
      throw new Error('Provider switch in progress')
    }
    const bridge = getAgentBridge()
    if (!bridge?.updateCustomProvider) return
    const changesAppliedProvider = id === providerState.activeId
    const requestGeneration = changesAppliedProvider
      ? ++providerWriteGeneration
      : undefined
    if (changesAppliedProvider) {
      useAgentChatStore.getState().invalidateCollaborationCapabilities()
    }
    try {
      const result = (await bridge.updateCustomProvider(id, patch)) as ProviderMutationResponse
      if (result?.ok !== true) {
        throw new Error(result?.error || 'updateCustomProvider rejected')
      }
      if (
        requestGeneration !== undefined
        && requestGeneration !== providerWriteGeneration
      ) return
      set((state) => ({
        providers: {
          ...state.providers,
          custom: state.providers.custom.map((provider) =>
            provider.id === id ? { ...provider, ...patch } : provider),
        },
      }))
      if (changesAppliedProvider) {
        const confirmed = result.activeId ?? id
        set((state) => ({
          providers: {
            ...state.providers,
            activeId: confirmed,
            appliedId: confirmed,
            pendingProviderId: null,
          },
        }))
        await reloadAgentModelCapabilities(confirmed)
      }
    } catch (err) {
      if (
        changesAppliedProvider
        && requestGeneration === providerWriteGeneration
      ) {
        const snapshot = await recoverProviderSnapshot(bridge, requestGeneration)
        if (snapshot) {
          const agentChat = useAgentChatStore.getState()
          agentChat.invalidateCollaborationCapabilities()
          await reloadAgentModelCapabilities(snapshot.activeId)
        }
      }
      throw err
    }
  },

  removeProvider: async (id) => {
    const providerState = get().providers
    if (providerState.pendingProviderId === id) {
      throw new Error('Provider switch in progress')
    }
    const bridge = getAgentBridge()
    if (!bridge?.removeCustomProvider) return
    const changesAppliedProvider = id === providerState.activeId
    const requestGeneration = changesAppliedProvider
      ? ++providerWriteGeneration
      : undefined
    if (changesAppliedProvider) {
      useAgentChatStore.getState().invalidateCollaborationCapabilities()
    }
    try {
      const result = (await bridge.removeCustomProvider(id)) as ProviderMutationResponse
      if (result?.ok !== true) {
        throw new Error(result?.error || 'removeCustomProvider rejected')
      }
      if (
        requestGeneration !== undefined
        && requestGeneration !== providerWriteGeneration
      ) return
      const confirmed = result.activeId ?? get().providers.appliedId
      set((state) => {
        const apiKeys = { ...state.providers.apiKeys }
        delete apiKeys[id]
        return {
          providers: {
            ...state.providers,
            custom: state.providers.custom.filter((provider) => provider.id !== id),
            activeId: confirmed,
            appliedId: confirmed,
            pendingProviderId: null,
            apiKeys,
          },
          codexApiKey: apiKeys[confirmed] ?? '',
        }
      })
      if (changesAppliedProvider) {
        await reloadAgentModelCapabilities(confirmed)
      }
    } catch (err) {
      if (
        changesAppliedProvider
        && requestGeneration === providerWriteGeneration
      ) {
        const snapshot = await recoverProviderSnapshot(bridge, requestGeneration)
        if (snapshot) {
          const agentChat = useAgentChatStore.getState()
          agentChat.invalidateCollaborationCapabilities()
          await reloadAgentModelCapabilities(snapshot.activeId)
        }
      }
      throw err
    }
  },
  }
})
