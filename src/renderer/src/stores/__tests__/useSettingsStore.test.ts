import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '../useSettingsStore'
import type { ApiActions } from '../../hooks/useService'
import { useAgentChatStore } from '../../features/agent-chat/store'

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
    getLocalPort: vi.fn().mockReturnValue('3000'),
    setLocalPort: vi.fn(),
    understandImage: vi.fn(),
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
      codexApiKey: '',
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

  describe('codexApiKey', () => {
    beforeEach(() => {
      localStorage.clear()
      useSettingsStore.setState({ codexApiKey: '' })
    })

    it('loads codexApiKey from localStorage on loadFromService', async () => {
      localStorage.setItem('codex_api_key', 'sk-stored')
      const api = createMockApi()

      await useSettingsStore.getState().loadFromService(api)

      expect(useSettingsStore.getState().codexApiKey).toBe('sk-stored')
    })

    it('setCodexApiKey trims and updates the store', () => {
      useSettingsStore.getState().setCodexApiKey('  sk-new  ')

      expect(useSettingsStore.getState().codexApiKey).toBe('sk-new')
    })

    it('saveAll writes codexApiKey to localStorage', async () => {
      useSettingsStore.setState({ codexApiKey: 'sk-toSave' })
      const api = createMockApi()

      await useSettingsStore.getState().saveAll(api)

      expect(localStorage.getItem('codex_api_key')).toBe('sk-toSave')
    })
  })

  describe('selectProvider', () => {
    interface AgentBridgeWindow {
      electronAPI?: {
        agent?: {
          getProviders?: () => Promise<unknown>
          setActiveProvider?: (id: string) => Promise<unknown>
          setProviderApiKey?: (id: string, key: string) => Promise<unknown>
          updateCustomProvider?: (id: string, patch: unknown) => Promise<unknown>
          removeCustomProvider?: (id: string) => Promise<unknown>
        }
      }
    }

    function installBridge(
      bridge:
        | NonNullable<NonNullable<AgentBridgeWindow['electronAPI']>['agent']>
        | ((id: string) => Promise<unknown>),
    ) {
      ;(window as unknown as AgentBridgeWindow).electronAPI = {
        agent: typeof bridge === 'function' ? { setActiveProvider: bridge } : bridge,
      }
    }

    afterEach(() => {
      delete (window as unknown as AgentBridgeWindow).electronAPI
    })

    beforeEach(() => {
      useSettingsStore.setState({
        providers: {
          builtins: [],
          custom: [],
          activeId: 'apiyi',
          appliedId: 'apiyi',
          pendingProviderId: null,
          apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
          loaded: true,
          loadError: null,
        },
        codexApiKey: 'sk-apiyi',
      })
    })

    it('keeps active confirmed and exposes only pending before IPC resolves', async () => {
      let resolveIpc!: (v: unknown) => void
      installBridge(() => new Promise((resolve) => { resolveIpc = resolve }))

      const pending = useSettingsStore.getState().selectProvider('rightcode')

      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'apiyi',
        pendingProviderId: 'rightcode',
      })
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-apiyi')

      resolveIpc({ ok: true, activeId: 'rightcode' })
      await pending
      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'rightcode',
        pendingProviderId: null,
      })
    })

    it('ignores a stale A success after a newer B request has confirmed', async () => {
      let resolveA!: (value: unknown) => void
      let resolveB!: (value: unknown) => void
      const setActiveProvider = vi.fn((id: string) =>
        new Promise((resolve) => {
          if (id === 'rightcode') resolveA = resolve
          else resolveB = resolve
        }))
      installBridge(setActiveProvider)
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      useAgentChatStore.setState({ loadCollaborationCapabilities } as never)

      const a = useSettingsStore.getState().selectProvider('rightcode')
      const b = useSettingsStore.getState().selectProvider('apiyi')
      resolveB({ ok: true, activeId: 'apiyi', providerGeneration: 3 })
      await b
      resolveA({ ok: true, activeId: 'rightcode', providerGeneration: 2 })
      await a

      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'apiyi',
        appliedId: 'apiyi',
      })
      expect(loadCollaborationCapabilities).toHaveBeenCalledTimes(1)
      expect(loadCollaborationCapabilities).toHaveBeenCalledWith('apiyi')
    })

    it('ignores a stale A failure after a newer B request has confirmed', async () => {
      let rejectA!: (error: Error) => void
      let resolveB!: (value: unknown) => void
      installBridge((id) =>
        new Promise((resolve, reject) => {
          if (id === 'rightcode') rejectA = reject
          else resolveB = resolve
        }))

      const a = useSettingsStore.getState().selectProvider('rightcode')
      const b = useSettingsStore.getState().selectProvider('apiyi')
      resolveB({ ok: true, activeId: 'apiyi', providerGeneration: 3 })
      await b
      rejectA(new Error('A failed late'))
      await a

      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'apiyi',
        appliedId: 'apiyi',
      })
    })

    it('restores main-authoritative A when stale A succeeds and latest B fails', async () => {
      let resolveA!: (value: unknown) => void
      let resolveB!: (value: unknown) => void
      let mainAppliedId = 'apiyi'
      installBridge({
        setActiveProvider: (id) =>
          new Promise((resolve) => {
            if (id === 'rightcode') resolveA = resolve
            else resolveB = resolve
          }),
        getProviders: vi.fn().mockImplementation(async () => ({
          ok: true,
          builtins: [],
          custom: [],
          activeId: mainAppliedId,
          apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
        })),
      })

      const a = useSettingsStore.getState().selectProvider('rightcode')
      const b = useSettingsStore.getState().selectProvider('custom-b')
      mainAppliedId = 'rightcode'
      resolveA({ ok: true, activeId: 'rightcode', providerGeneration: 2 })
      await a
      resolveB({ ok: false, error: 'B failed' })

      await expect(b).rejects.toThrow('B failed')
      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'rightcode',
        appliedId: 'rightcode',
        pendingProviderId: null,
      })
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-rc')
      expect(mainAppliedId).toBe('rightcode')
    })

    it('invalidates immediately and reloads capabilities only after Provider confirmation', async () => {
      let resolveIpc!: (value: unknown) => void
      const invalidateCollaborationCapabilities = vi.fn()
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      const loadModelSettingsCatalog = vi.fn().mockResolvedValue(undefined)
      useAgentChatStore.setState({
        invalidateCollaborationCapabilities,
        loadCollaborationCapabilities,
        loadModelSettingsCatalog,
      } as never)
      installBridge(() => new Promise((resolve) => { resolveIpc = resolve }))

      const pending = useSettingsStore.getState().selectProvider('rightcode')

      expect(invalidateCollaborationCapabilities).toHaveBeenCalledTimes(1)
      expect(loadCollaborationCapabilities).not.toHaveBeenCalled()
      expect(loadModelSettingsCatalog).not.toHaveBeenCalled()

      resolveIpc({ ok: true, activeId: 'rightcode' })
      await pending
      expect(loadCollaborationCapabilities).toHaveBeenCalledWith('rightcode')
      expect(loadModelSettingsCatalog).toHaveBeenCalledWith('rightcode')
    })

    it('selects a Provider-pinned model only after the Provider is confirmed', async () => {
      let resolveIpc!: (value: unknown) => void
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      const loadModelSettingsCatalog = vi.fn().mockResolvedValue(undefined)
      const setSelectedModel = vi.fn().mockResolvedValue(undefined)
      useSettingsStore.setState((state) => ({
        providers: {
          ...state.providers,
          builtins: [{
            id: 'rightcode-grok',
            name: 'Right.Codes Grok',
            baseUrl: 'https://rightapi.ai/grok/v1',
            envKey: 'OPENAI_API_KEY',
            model: 'grok-4.5',
          }],
        },
      }))
      useAgentChatStore.setState({
        loadCollaborationCapabilities,
        loadModelSettingsCatalog,
        setSelectedModel,
      } as never)
      installBridge(() => new Promise((resolve) => { resolveIpc = resolve }))

      const pending = useSettingsStore.getState().selectProvider('rightcode-grok')

      expect(setSelectedModel).not.toHaveBeenCalled()
      resolveIpc({ ok: true, activeId: 'rightcode-grok' })
      await pending
      expect(loadModelSettingsCatalog).toHaveBeenCalledWith('rightcode-grok')
      expect(setSelectedModel).toHaveBeenCalledWith('grok-4.5')
    })

    it('uses the shared gateway credential after selecting an aliased Provider', async () => {
      useSettingsStore.setState((state) => ({
        providers: {
          ...state.providers,
          builtins: [{
            id: 'rightcode-grok',
            name: 'Right.Codes Grok',
            baseUrl: 'https://rightapi.ai/grok/v1',
            envKey: 'OPENAI_API_KEY',
            credentialId: 'rightcode',
          }],
        },
      }))
      useAgentChatStore.setState({
        loadCollaborationCapabilities: vi.fn().mockResolvedValue(undefined),
        loadModelSettingsCatalog: vi.fn().mockResolvedValue(undefined),
      } as never)
      installBridge(async () => ({ ok: true, activeId: 'rightcode-grok' }))

      await useSettingsStore.getState().selectProvider('rightcode-grok')

      expect(useSettingsStore.getState().codexApiKey).toBe('sk-rc')
    })

    it('falls back to the confirmed catalog default when a Provider has no pinned model', async () => {
      const setSelectedModel = vi.fn().mockResolvedValue(undefined)
      useSettingsStore.setState((state) => ({
        providers: {
          ...state.providers,
          activeId: 'rightcode-grok',
          appliedId: 'rightcode-grok',
          builtins: [{
            id: 'apiyi',
            name: 'API Yi',
            baseUrl: 'https://api.apiyi.com/v1',
            envKey: 'OPENAI_API_KEY',
          }],
        },
      }))
      useAgentChatStore.setState({
        selectedModelId: 'grok-4.5',
        loadCollaborationCapabilities: vi.fn().mockResolvedValue(undefined),
        loadModelSettingsCatalog: vi.fn().mockImplementation(async () => {
          useAgentChatStore.setState({
            modelSettingsCatalog: {
              gatewayId: 'apiyi',
              revision: 'apiyi-catalog-1',
              source: 'codex',
              models: [
                {
                  id: 'gpt-5.5',
                  displayName: 'GPT-5.5',
                  description: 'Default',
                  hidden: false,
                  isDefault: true,
                  capabilities: {
                    model: 'gpt-5.5',
                    provider: 'apiyi',
                    defaultContextWindow: 272_000,
                    contextOptions: [{ value: 272_000, experimental: false }],
                    supportedReasoningEfforts: [],
                  },
                },
              ],
            },
          } as never)
        }),
        setSelectedModel,
      } as never)
      installBridge(async () => ({ ok: true, activeId: 'apiyi' }))

      await useSettingsStore.getState().selectProvider('apiyi')

      expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.5')
    })

    it('rolls back to the previous provider when the IPC rejects', async () => {
      installBridge({
        setActiveProvider: () => Promise.reject(new Error('unknown provider')),
        getProviders: vi.fn().mockResolvedValue({
          ok: true,
          builtins: [],
          custom: [],
          activeId: 'apiyi',
          apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
        }),
      })

      await expect(
        useSettingsStore.getState().selectProvider('rightcode'),
      ).rejects.toThrow('unknown provider')

      expect(useSettingsStore.getState().providers.activeId).toBe('apiyi')
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-apiyi')
    })

    it('invalidates again and reloads the confirmed previous Provider after rollback', async () => {
      const invalidateCollaborationCapabilities = vi.fn()
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      const loadModelSettingsCatalog = vi.fn().mockResolvedValue(undefined)
      useAgentChatStore.setState({
        invalidateCollaborationCapabilities,
        loadCollaborationCapabilities,
        loadModelSettingsCatalog,
      } as never)
      installBridge({
        setActiveProvider: () => Promise.reject(new Error('unknown provider')),
        getProviders: vi.fn().mockResolvedValue({
          ok: true,
          builtins: [],
          custom: [],
          activeId: 'apiyi',
          apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
        }),
      })

      await expect(
        useSettingsStore.getState().selectProvider('rightcode'),
      ).rejects.toThrow('unknown provider')

      expect(invalidateCollaborationCapabilities).toHaveBeenCalledTimes(2)
      expect(loadCollaborationCapabilities).toHaveBeenCalledWith('apiyi')
      expect(useSettingsStore.getState().providers.activeId).toBe('apiyi')
    })

    it('rolls back when main replies ok:false', async () => {
      installBridge({
        setActiveProvider: () => Promise.resolve({ ok: false, error: 'rejected' }),
        getProviders: vi.fn().mockResolvedValue({
          ok: true,
          builtins: [],
          custom: [],
          activeId: 'apiyi',
          apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
        }),
      })

      await expect(
        useSettingsStore.getState().selectProvider('rightcode'),
      ).rejects.toThrow('rejected')

      expect(useSettingsStore.getState().providers.activeId).toBe('apiyi')
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-apiyi')
    })

    it('reloads capabilities after confirmed active key, update, and remove writes', async () => {
      const invalidateCollaborationCapabilities = vi.fn()
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      const loadModelSettingsCatalog = vi.fn().mockResolvedValue(undefined)
      useAgentChatStore.setState({
        invalidateCollaborationCapabilities,
        loadCollaborationCapabilities,
        loadModelSettingsCatalog,
      } as never)
      installBridge({
        setProviderApiKey: vi.fn().mockResolvedValue({
          ok: true,
          activeId: 'apiyi',
          providerGeneration: 2,
        }),
        updateCustomProvider: vi.fn().mockResolvedValue({
          ok: true,
          activeId: 'apiyi',
          providerGeneration: 3,
        }),
        removeCustomProvider: vi.fn().mockResolvedValue({
          ok: true,
          activeId: 'apiyi',
          providerGeneration: 4,
        }),
        getProviders: vi.fn().mockResolvedValue({
          ok: true,
          builtins: [],
          custom: [],
          activeId: 'apiyi',
          apiKeys: { apiyi: 'sk-next' },
        }),
      })

      await useSettingsStore.getState().saveProviderKey('apiyi', 'sk-next')
      await useSettingsStore.getState().updateProvider('apiyi', { model: 'gpt-5.6-sol' })
      await useSettingsStore.getState().removeProvider('apiyi')

      expect(invalidateCollaborationCapabilities).toHaveBeenCalledTimes(3)
      expect(loadCollaborationCapabilities).toHaveBeenCalledTimes(3)
      expect(loadModelSettingsCatalog).toHaveBeenCalledTimes(3)
      expect(loadCollaborationCapabilities).toHaveBeenNthCalledWith(1, 'apiyi')
      expect(loadCollaborationCapabilities).toHaveBeenNthCalledWith(2, 'apiyi')
      expect(loadCollaborationCapabilities).toHaveBeenNthCalledWith(3, 'apiyi')
      expect(loadModelSettingsCatalog).toHaveBeenNthCalledWith(1, 'apiyi')
      expect(loadModelSettingsCatalog).toHaveBeenNthCalledWith(2, 'apiyi')
      expect(loadModelSettingsCatalog).toHaveBeenNthCalledWith(3, 'apiyi')
    })

    it('does not invalidate or reload capabilities for a non-active key write', async () => {
      const invalidateCollaborationCapabilities = vi.fn()
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      useAgentChatStore.setState({
        invalidateCollaborationCapabilities,
        loadCollaborationCapabilities,
      } as never)
      installBridge({
        setProviderApiKey: vi.fn().mockResolvedValue({
          ok: true,
          activeId: 'apiyi',
        }),
      })

      await useSettingsStore.getState().saveProviderKey('rightcode', 'sk-next')

      expect(invalidateCollaborationCapabilities).not.toHaveBeenCalled()
      expect(loadCollaborationCapabilities).not.toHaveBeenCalled()
    })

    it('rolls back an active key when confirmed apply fails', async () => {
      installBridge({
        setProviderApiKey: vi.fn().mockResolvedValue({
          ok: false,
          error: 'restart failed',
        }),
        getProviders: vi.fn().mockResolvedValue({
          ok: true,
          builtins: [],
          custom: [],
          activeId: 'apiyi',
          apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
        }),
      })

      await expect(
        useSettingsStore.getState().saveProviderKey('apiyi', 'sk-new'),
      ).rejects.toThrow('restart failed')

      expect(useSettingsStore.getState().providers.apiKeys.apiyi).toBe('sk-apiyi')
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-apiyi')
    })

    it('does not call key IPC for the pending target Provider', async () => {
      const setProviderApiKey = vi.fn().mockResolvedValue({ ok: true })
      installBridge({ setProviderApiKey })
      useSettingsStore.setState((state) => ({
        providers: { ...state.providers, pendingProviderId: 'rightcode' },
      }))

      await expect(
        useSettingsStore.getState().saveProviderKey('rightcode', 'sk-new'),
      ).rejects.toThrow(/switch.*progress/i)
      expect(setProviderApiKey).not.toHaveBeenCalled()
    })

    it.each([
      ['update', 'updateCustomProvider', 'updateProvider'],
      ['remove', 'removeCustomProvider', 'removeProvider'],
    ] as const)(
      'rejects pending-target %s without calling IPC',
      async (_label, bridgeMethod, storeMethod) => {
        const ipc = vi.fn().mockResolvedValue({ ok: true, activeId: 'rightcode' })
        installBridge({ [bridgeMethod]: ipc })
        useSettingsStore.setState((state) => ({
          providers: { ...state.providers, pendingProviderId: 'rightcode' },
        }))

        const action = storeMethod === 'updateProvider'
          ? useSettingsStore.getState().updateProvider('rightcode', { model: 'gpt-5.6-sol' })
          : useSettingsStore.getState().removeProvider('rightcode')
        await expect(action).rejects.toThrow(/switch.*progress/i)
        expect(ipc).not.toHaveBeenCalled()
      },
    )

    it.each([
      ['update', 'updateCustomProvider', 'updateProvider'],
      ['remove', 'removeCustomProvider', 'removeProvider'],
    ] as const)(
      'rejects failed active Provider %s after authoritative reload',
      async (_label, bridgeMethod, storeMethod) => {
        installBridge({
          [bridgeMethod]: vi.fn().mockResolvedValue({
            ok: false,
            error: `${bridgeMethod} failed`,
          }),
          getProviders: vi.fn().mockResolvedValue({
            ok: true,
            builtins: [],
            custom: [],
            activeId: 'apiyi',
            apiKeys: { apiyi: 'sk-apiyi' },
          }),
        })

        const action = storeMethod === 'updateProvider'
          ? useSettingsStore.getState().updateProvider('apiyi', { model: 'broken' })
          : useSettingsStore.getState().removeProvider('apiyi')
        await expect(action).rejects.toThrow(`${bridgeMethod} failed`)
        expect(useSettingsStore.getState().providers).toMatchObject({
          activeId: 'apiyi',
          pendingProviderId: null,
        })
      },
    )
  })

  describe('gateway actions', () => {
    interface GatewayBridgeWindow {
      electronAPI?: {
        agent?: Record<string, unknown>
      }
    }

    function installBridge(bridge: Record<string, unknown>) {
      ;(window as unknown as GatewayBridgeWindow).electronAPI = { agent: bridge }
    }

    const GATEWAY_SNAPSHOT = {
      ok: true,
      builtins: [
        {
          id: 'apiyi',
          name: 'API Yi',
          baseUrl: 'https://api.apiyi.com/v1',
          envKey: 'OPENAI_API_KEY',
          credentialId: 'apiyi',
        },
        {
          id: 'rightcode',
          name: 'Right.Codes',
          baseUrl: 'https://rightapi.ai/codex/v1',
          envKey: 'OPENAI_API_KEY',
          model: 'gpt-5.5',
          credentialId: 'rightcode',
        },
      ],
      custom: [],
      activeId: 'apiyi',
      apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
    }

    beforeEach(() => {
      useSettingsStore.setState({
        providers: {
          builtins: GATEWAY_SNAPSHOT.builtins,
          custom: [],
          activeId: 'apiyi',
          appliedId: 'apiyi',
          pendingProviderId: null,
          apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-rc' },
          loaded: true,
          loadError: null,
        },
        codexApiKey: 'sk-apiyi',
      })
      useAgentChatStore.setState({
        selectedModelId: 'gpt-5.6-sol',
        invalidateCollaborationCapabilities: vi.fn(),
        loadCollaborationCapabilities: vi.fn().mockResolvedValue(undefined),
        loadModelSettingsCatalog: vi.fn().mockResolvedValue(undefined),
        setSelectedModel: vi.fn().mockResolvedValue(true),
      } as never)
    })

    afterEach(() => {
      delete (window as unknown as GatewayBridgeWindow).electronAPI
    })

    it('loadGateways commits the builtin gateway snapshot from getGateways', async () => {
      const getGateways = vi.fn().mockResolvedValue({
        ...GATEWAY_SNAPSHOT,
        activeId: 'rightcode',
      })
      installBridge({ getGateways })
      useSettingsStore.setState((state) => ({
        providers: {
          ...state.providers,
          builtins: [],
          loaded: false,
        },
      }))

      await useSettingsStore.getState().loadGateways()

      expect(getGateways).toHaveBeenCalledTimes(1)
      const { providers, codexApiKey } = useSettingsStore.getState()
      expect(providers.builtins.map((p) => p.name)).toEqual(['API Yi', 'Right.Codes'])
      expect(providers).toMatchObject({
        activeId: 'rightcode',
        appliedId: 'rightcode',
        pendingProviderId: null,
        loaded: true,
        loadError: null,
      })
      expect(codexApiKey).toBe('sk-rc')
    })

    it('selectGateway confirms through setActiveGateway and reloads capabilities', async () => {
      const setActiveGateway = vi.fn().mockResolvedValue({
        ok: true,
        activeId: 'rightcode',
      })
      installBridge({ setActiveGateway })
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      const loadModelSettingsCatalog = vi.fn().mockResolvedValue(undefined)
      const setSelectedModel = vi.fn().mockResolvedValue(true)
      useAgentChatStore.setState({
        loadCollaborationCapabilities,
        loadModelSettingsCatalog,
        setSelectedModel,
      } as never)

      await useSettingsStore.getState().selectGateway('rightcode')

      expect(setActiveGateway).toHaveBeenCalledWith('rightcode')
      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'rightcode',
        appliedId: 'rightcode',
        pendingProviderId: null,
      })
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-rc')
      expect(loadCollaborationCapabilities).toHaveBeenCalledWith('rightcode')
      expect(loadModelSettingsCatalog).toHaveBeenCalledWith('rightcode')
      // Pinned-model semantics from selectProvider must be preserved.
      expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.5')
    })

    it('selectGateway exposes pending state and blocks key writes while switching', async () => {
      let resolveIpc!: (value: unknown) => void
      installBridge({
        setActiveGateway: () => new Promise((resolve) => { resolveIpc = resolve }),
      })

      const pending = useSettingsStore.getState().selectGateway('rightcode')

      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'apiyi',
        pendingProviderId: 'rightcode',
      })
      await expect(
        useSettingsStore.getState().saveGatewayKey('rightcode', 'sk-x'),
      ).rejects.toThrow(/switch.*progress/i)

      resolveIpc({ ok: true, activeId: 'rightcode' })
      await pending
      expect(useSettingsStore.getState().providers.pendingProviderId).toBeNull()
    })

    it('selectGateway rolls back through getGateways when main rejects', async () => {
      installBridge({
        setActiveGateway: vi.fn().mockResolvedValue({ ok: false, error: 'rejected' }),
        getGateways: vi.fn().mockResolvedValue(GATEWAY_SNAPSHOT),
      })

      await expect(
        useSettingsStore.getState().selectGateway('rightcode'),
      ).rejects.toThrow('rejected')

      expect(useSettingsStore.getState().providers).toMatchObject({
        activeId: 'apiyi',
        appliedId: 'apiyi',
        pendingProviderId: null,
      })
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-apiyi')
    })

    it('saveGatewayKey routes the shared key through setGatewayApiKey', async () => {
      const setGatewayApiKey = vi.fn().mockResolvedValue({
        ok: true,
        activeId: 'apiyi',
      })
      installBridge({ setGatewayApiKey })
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      useAgentChatStore.setState({ loadCollaborationCapabilities } as never)

      await useSettingsStore.getState().saveGatewayKey('apiyi', 'shared-key')

      expect(setGatewayApiKey).toHaveBeenCalledWith('apiyi', 'shared-key')
      expect(useSettingsStore.getState().providers.apiKeys.apiyi).toBe('shared-key')
      expect(useSettingsStore.getState().codexApiKey).toBe('shared-key')
      expect(loadCollaborationCapabilities).toHaveBeenCalledWith('apiyi')
    })

    it('saveGatewayKey rolls back the active key when the apply fails', async () => {
      installBridge({
        setGatewayApiKey: vi.fn().mockResolvedValue({
          ok: false,
          error: 'restart failed',
        }),
        getGateways: vi.fn().mockResolvedValue(GATEWAY_SNAPSHOT),
      })

      await expect(
        useSettingsStore.getState().saveGatewayKey('apiyi', 'sk-broken'),
      ).rejects.toThrow('restart failed')

      expect(useSettingsStore.getState().providers.apiKeys.apiyi).toBe('sk-apiyi')
      expect(useSettingsStore.getState().codexApiKey).toBe('sk-apiyi')
    })

    it('saveGatewayKey for a non-active gateway does not reload capabilities', async () => {
      const setGatewayApiKey = vi.fn().mockResolvedValue({ ok: true, activeId: 'apiyi' })
      installBridge({ setGatewayApiKey })
      const invalidateCollaborationCapabilities = vi.fn()
      const loadCollaborationCapabilities = vi.fn().mockResolvedValue(undefined)
      useAgentChatStore.setState({
        invalidateCollaborationCapabilities,
        loadCollaborationCapabilities,
      } as never)

      await useSettingsStore.getState().saveGatewayKey('rightcode', 'sk-new')

      expect(setGatewayApiKey).toHaveBeenCalledWith('rightcode', 'sk-new')
      expect(invalidateCollaborationCapabilities).not.toHaveBeenCalled()
      expect(loadCollaborationCapabilities).not.toHaveBeenCalled()
    })
  })

})
