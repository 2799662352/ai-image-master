import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '../useSettingsStore'
import type { ApiActions } from '../../hooks/useService'

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(true),
    saveApiKey: vi.fn().mockReturnValue(true),
    saveVisionApiKey: vi.fn().mockReturnValue(true),
    getAllSites: vi.fn().mockReturnValue({
      'b-apiyi': { name: 'API易 B站', baseURL: 'https://b.apiyi.com', description: '推荐', authType: 'bearer', isBuiltIn: true },
      'yunwu': { name: '云雾 API', baseURL: 'https://yunwu.ai', description: '云雾', authType: 'bearer', isBuiltIn: true },
    }),
    setSite: vi.fn().mockReturnValue(true),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn().mockReturnValue({ name: 'API易 B站', baseURL: 'https://b.apiyi.com', description: '推荐', authType: 'bearer', isBuiltIn: true }),
    getSiteConfig: vi.fn().mockReturnValue(null),
    currentSiteKey: 'b-apiyi',
    ...overrides,
  }
}

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      sites: {},
      activeSiteKey: '',
      apiKey: '',
      visionApiKey: '',
      connectionStatus: 'idle',
      saving: false,
      loadError: null,
    })
  })

  describe('loadFromService', () => {
    it('loads sites and current key from api', async () => {
      const api = createMockApi({
        getStoredApiKey: vi.fn().mockImplementation((key) => {
          if (key === 'b-apiyi') return 'stored-key-123'
          return null
        }),
        getStoredVisionApiKey: vi.fn().mockReturnValue('vision-key-456'),
      })

      await useSettingsStore.getState().loadFromService(api)

      const state = useSettingsStore.getState()
      expect(Object.keys(state.sites)).toHaveLength(2)
      expect(state.activeSiteKey).toBe('b-apiyi')
      expect(state.apiKey).toBe('stored-key-123')
      expect(state.visionApiKey).toBe('vision-key-456')
      expect(state.loadError).toBeNull()
    })

    it('falls back to defaultApiKey when no stored key', async () => {
      const api = createMockApi({
        getAllSites: vi.fn().mockReturnValue({
          'demo': { name: 'Demo', baseURL: 'https://demo.com', defaultApiKey: 'default-123', authType: 'bearer' },
        }),
        getStoredApiKey: vi.fn().mockReturnValue(null),
        getCurrentSite: vi.fn().mockReturnValue({ name: 'Demo', baseURL: 'https://demo.com', defaultApiKey: 'default-123', authType: 'bearer' }),
        currentSiteKey: 'demo',
      })

      await useSettingsStore.getState().loadFromService(api)

      expect(useSettingsStore.getState().apiKey).toBe('default-123')
    })

    it('sets loadError on exception', async () => {
      const api = createMockApi({
        getAllSites: vi.fn().mockImplementation(() => { throw new Error('service down') }),
      })

      await useSettingsStore.getState().loadFromService(api)

      expect(useSettingsStore.getState().loadError).toBe('service down')
    })
  })

  describe('switchSite', () => {
    it('updates activeSiteKey and loads key for new site', () => {
      useSettingsStore.setState({
        sites: {
          'a': { name: 'A', baseURL: 'https://a.com', description: '', authType: 'bearer' as const },
          'b': { name: 'B', baseURL: 'https://b.com', description: '', authType: 'bearer' as const },
        },
        activeSiteKey: 'a',
        apiKey: 'key-a',
      })

      const api = createMockApi({
        getStoredApiKey: vi.fn().mockReturnValue('key-b'),
        getStoredVisionApiKey: vi.fn().mockReturnValue('vision-b'),
        getSiteConfig: vi.fn().mockReturnValue({ name: 'B', baseURL: 'https://b.com' }),
      })

      useSettingsStore.getState().switchSite('b', api)

      expect(useSettingsStore.getState().activeSiteKey).toBe('b')
      expect(useSettingsStore.getState().apiKey).toBe('key-b')
      expect(useSettingsStore.getState().visionApiKey).toBe('vision-b')
      expect(api.setSite).toHaveBeenCalledWith('b')
    })
  })

  describe('testConnection', () => {
    it('transitions status idle → testing → success', async () => {
      useSettingsStore.setState({ apiKey: 'test-key', connectionStatus: 'idle' })
      const api = createMockApi({ testConnection: vi.fn().mockResolvedValue(true) })

      const result = await useSettingsStore.getState().testConnection(api)

      expect(result).toBe(true)
      expect(useSettingsStore.getState().connectionStatus).toBe('success')
      expect(api.testConnection).toHaveBeenCalledWith('test-key')
    })

    it('transitions to error on failure', async () => {
      useSettingsStore.setState({ apiKey: 'bad-key', connectionStatus: 'idle' })
      const api = createMockApi({ testConnection: vi.fn().mockResolvedValue(false) })

      const result = await useSettingsStore.getState().testConnection(api)

      expect(result).toBe(false)
      expect(useSettingsStore.getState().connectionStatus).toBe('error')
    })

    it('transitions to error on exception', async () => {
      useSettingsStore.setState({ apiKey: 'key', connectionStatus: 'idle' })
      const api = createMockApi({ testConnection: vi.fn().mockRejectedValue(new Error('timeout')) })

      const result = await useSettingsStore.getState().testConnection(api)

      expect(result).toBe(false)
      expect(useSettingsStore.getState().connectionStatus).toBe('error')
    })
  })

  describe('saveAll', () => {
    it('saves apiKey and visionApiKey', async () => {
      useSettingsStore.setState({ apiKey: 'my-key', visionApiKey: 'v-key' })
      const api = createMockApi()

      await useSettingsStore.getState().saveAll(api)

      expect(api.saveApiKey).toHaveBeenCalledWith('my-key')
      expect(api.saveVisionApiKey).toHaveBeenCalledWith('v-key')
      expect(useSettingsStore.getState().saving).toBe(false)
    })

    it('sets saving state during operation', async () => {
      useSettingsStore.setState({ apiKey: 'k', visionApiKey: '' })
      let savingDuringCall = false
      const api = createMockApi({
        saveApiKey: vi.fn().mockImplementation(() => {
          savingDuringCall = useSettingsStore.getState().saving
          return true
        }),
      })

      await useSettingsStore.getState().saveAll(api)

      expect(savingDuringCall).toBe(true)
      expect(useSettingsStore.getState().saving).toBe(false)
    })
  })
})
