import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import type { ApiSite } from '../services/api'

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
  activeId: string
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

const DEFAULT_PROVIDERS_SLICE: ProvidersSlice = {
  builtins: [],
  custom: [],
  activeId: 'apiyi',
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
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
    set({
      codexApiKey: trimmed,
      providers: {
        ...providers,
        apiKeys: { ...providers.apiKeys, [providers.activeId]: trimmed },
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
      const raw = await bridge.getProviders()
      const snapshot = unwrapSnapshot(raw)
      if (!snapshot) {
        set({ providers: { ...DEFAULT_PROVIDERS_SLICE, loaded: true, loadError: 'invalid snapshot' } })
        return
      }
      const codexKey = snapshot.apiKeys[snapshot.activeId] ?? ''
      set({
        providers: { ...snapshot, loaded: true, loadError: null },
        codexApiKey: codexKey,
      })
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
    // Optimistic: highlight the tile + swap the key input immediately so the
    // click feels instant (main also replies fast now — the codex respawn
    // runs in the background there). Roll back if the IPC rejects.
    const prevActiveId = get().providers.activeId
    set((state) => ({
      providers: { ...state.providers, activeId: id },
      codexApiKey: state.providers.apiKeys[id] ?? '',
    }))
    try {
      const result = (await bridge.setActiveProvider(id)) as { ok?: boolean; activeId?: string }
      if (result?.ok === false) throw new Error('setActiveProvider rejected')
      const confirmed = result?.activeId ?? id
      if (confirmed !== id) {
        set((state) => ({
          providers: { ...state.providers, activeId: confirmed },
          codexApiKey: state.providers.apiKeys[confirmed] ?? '',
        }))
      }
    } catch (err) {
      console.warn('selectProvider failed, reverting:', err)
      set((state) => ({
        providers: { ...state.providers, activeId: prevActiveId },
        codexApiKey: state.providers.apiKeys[prevActiveId] ?? '',
      }))
    }
  },

  saveProviderKey: async (id, key) => {
    const trimmed = key.trim()
    const { providers } = get()
    // Optimistic local update first so UI feels instant.
    set({
      providers: { ...providers, apiKeys: { ...providers.apiKeys, [id]: trimmed } },
      ...(id === providers.activeId ? { codexApiKey: trimmed } : {}),
    })
    const bridge = getAgentBridge()
    if (bridge?.setProviderApiKey) {
      try {
        await bridge.setProviderApiKey(id, trimmed)
      } catch (err) {
        console.warn('saveProviderKey failed:', err)
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
    const bridge = getAgentBridge()
    if (!bridge?.updateCustomProvider) return
    try {
      await bridge.updateCustomProvider(id, patch)
      // Reload to pull canonical post-merge state.
      await get().loadProviders()
    } catch (err) {
      console.warn('updateProvider failed:', err)
    }
  },

  removeProvider: async (id) => {
    const bridge = getAgentBridge()
    if (!bridge?.removeCustomProvider) return
    try {
      const raw = (await bridge.removeCustomProvider(id)) as {
        ok?: boolean
        activeId?: string
      }
      if (raw?.ok === false) return
      await get().loadProviders()
    } catch (err) {
      console.warn('removeProvider failed:', err)
    }
  },
}))
