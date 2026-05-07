import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import type { ApiSite } from '../services/api'

interface SettingsState {
  sites: Record<string, ApiSite>
  activeSiteKey: string
  apiKey: string
  visionApiKey: string
  codexApiKey: string
  localPort: string
  connectionStatus: 'idle' | 'testing' | 'success' | 'error'
  saving: boolean
  loadError: string | null

  loadFromService: (api: ApiActions) => Promise<void>
  switchSite: (key: string, api: ApiActions) => void
  setApiKey: (key: string) => void
  setVisionApiKey: (key: string) => void
  setCodexApiKey: (key: string) => void
  setLocalPort: (port: string, api: ApiActions) => void
  testConnection: (api: ApiActions) => Promise<boolean>
  saveAll: (api: ApiActions) => Promise<void>
}

const CODEX_API_KEY_STORAGE_KEY = 'codex_api_key'

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

  loadFromService: async (api) => {
    try {
      const sites = api.getAllSites()
      const currentKey = api.currentSiteKey

      const storedKey = api.getStoredApiKey(currentKey)
      const currentSite = api.getCurrentSite()
      const apiKey = storedKey || currentSite?.defaultApiKey || ''

      const visionKey = api.getStoredVisionApiKey(currentKey)
      const codexKey = localStorage.getItem(CODEX_API_KEY_STORAGE_KEY) ?? ''

      set({
        sites,
        activeSiteKey: currentKey,
        apiKey,
        visionApiKey: visionKey || '',
        codexApiKey: codexKey,
        localPort: api.getLocalPort(),
        connectionStatus: 'idle',
        loadError: null,
      })
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

  setCodexApiKey: (key) => set({ codexApiKey: key.trim() }),

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
      localStorage.setItem(CODEX_API_KEY_STORAGE_KEY, get().codexApiKey)
    } finally {
      set({ saving: false })
    }
  },
}))
