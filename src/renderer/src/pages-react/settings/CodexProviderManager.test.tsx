import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../../features/agent-chat/store'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useToastStore } from '../../stores/useToastStore'
import { CodexProviderManager } from './CodexProviderManager'

// Captured before any test mocks store actions via setState, so the gateway
// describe below can exercise the real IPC-facing implementations.
const REAL_STORE_ACTIONS = {
  loadGateways: useSettingsStore.getState().loadGateways,
  selectGateway: useSettingsStore.getState().selectGateway,
  saveGatewayKey: useSettingsStore.getState().saveGatewayKey,
  setCodexApiKey: useSettingsStore.getState().setCodexApiKey,
}

const APIYI = {
  id: 'apiyi',
  name: 'API Yi',
  baseUrl: 'https://apiyi.example/v1',
  envKey: 'OPENAI_API_KEY',
}

const RIGHTCODE = {
  id: 'rightcode',
  name: 'Right Code',
  baseUrl: 'https://right.example/v1',
  envKey: 'RIGHTCODE_API_KEY',
}

const CUSTOM = {
  id: 'custom-one',
  name: 'Custom One',
  baseUrl: 'https://custom.example/v1',
  envKey: 'CUSTOM_API_KEY',
  isCustom: true,
}

describe('CodexProviderManager confirmed Provider state', () => {
  const addToast = vi.fn()

  beforeEach(() => {
    addToast.mockReset()
    useToastStore.setState({ toasts: [], addToast })
    useSettingsStore.setState({
      providers: {
        builtins: [APIYI, RIGHTCODE],
        custom: [CUSTOM],
        activeId: 'apiyi',
        appliedId: 'apiyi',
        pendingProviderId: null,
        apiKeys: { apiyi: 'sk-apiyi', rightcode: 'sk-right' },
        loaded: true,
        loadError: null,
      },
      codexApiKey: 'sk-apiyi',
      selectGateway: vi.fn().mockResolvedValue(undefined),
      saveGatewayKey: vi.fn().mockResolvedValue(undefined),
      updateProvider: vi.fn().mockResolvedValue(undefined),
      removeProvider: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders pending separately and disables key, edit, and remove writes while switching', () => {
    const saveGatewayKey = vi.fn().mockResolvedValue(undefined)
    const updateProvider = vi.fn().mockResolvedValue(undefined)
    const removeProvider = vi.fn().mockResolvedValue(undefined)
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    useSettingsStore.setState((state) => ({
      providers: { ...state.providers, pendingProviderId: 'rightcode' },
      saveGatewayKey,
      updateProvider,
      removeProvider,
    }))

    render(<CodexProviderManager />)

    expect(screen.getByText('切换中…')).toBeTruthy()
    expect(screen.getByText(/当前 Gateway:/).textContent).toContain('API Yi')
    const saveButton = screen.getByRole('button', { name: '测试并保存' })
    expect(saveButton.matches(':disabled')).toBe(true)
    fireEvent.click(saveButton)
    expect(saveGatewayKey).not.toHaveBeenCalled()

    const editButton = screen.getByRole('button', { name: '编辑' })
    const removeButton = screen.getByRole('button', { name: '删除' })
    expect(editButton.matches(':disabled')).toBe(true)
    expect(removeButton.matches(':disabled')).toBe(true)
    expect(editButton.getAttribute('aria-disabled')).toBe('true')
    expect(removeButton.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(editButton)
    fireEvent.click(removeButton)
    expect(screen.queryByRole('heading', { name: /编辑 Custom One/ })).toBeNull()
    expect(updateProvider).not.toHaveBeenCalled()
    expect(removeProvider).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('shows an error toast when Gateway selection fails', async () => {
    useSettingsStore.setState({
      selectGateway: vi.fn().mockRejectedValue(new Error('switch failed')),
    })
    render(<CodexProviderManager />)

    fireEvent.click(screen.getByRole('radio', { name: /Right Code/ }))

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        message: 'switch failed',
        type: 'error',
      })
    })
  })

  it('does not show key success when saving the active key fails', async () => {
    useSettingsStore.setState({
      saveGatewayKey: vi.fn().mockRejectedValue(new Error('key restart failed')),
    })
    render(<CodexProviderManager />)

    fireEvent.click(screen.getByRole('button', { name: '测试并保存' }))

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        message: 'key restart failed',
        type: 'error',
      })
    })
    expect(addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    )
  })

  it('does not show update success when updating the active custom Provider fails', async () => {
    useSettingsStore.setState((state) => ({
      providers: {
        ...state.providers,
        activeId: CUSTOM.id,
        appliedId: CUSTOM.id,
      },
      updateProvider: vi.fn().mockRejectedValue(new Error('update failed')),
    }))
    render(<CodexProviderManager />)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        message: 'update failed',
        type: 'error',
      })
    })
    expect(addToast).not.toHaveBeenCalledWith({
      message: '已更新',
      type: 'success',
    })
  })

  it('does not show remove success when removing the active custom Provider fails', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    useSettingsStore.setState((state) => ({
      providers: {
        ...state.providers,
        activeId: CUSTOM.id,
        appliedId: CUSTOM.id,
      },
      removeProvider: vi.fn().mockRejectedValue(new Error('remove failed')),
    }))
    render(<CodexProviderManager />)

    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        message: 'remove failed',
        type: 'error',
      })
    })
    expect(addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    )
  })
})

describe('CodexProviderManager gateway cards', () => {
  const addToast = vi.fn()

  interface BridgeWindow {
    electronAPI?: { agent?: Record<string, unknown> }
  }

  function installBridge(bridge: Record<string, unknown>) {
    ;(window as unknown as BridgeWindow).electronAPI = { agent: bridge }
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
        baseUrl: 'https://right.codes/codex/v1',
        envKey: 'OPENAI_API_KEY',
        credentialId: 'rightcode',
      },
    ],
    custom: [],
    activeId: 'rightcode',
    apiKeys: { rightcode: 'sk-rc' },
  }

  function seedLoadedGateways(
    overrides: Partial<{
      activeId: string
      apiKeys: Record<string, string>
    }> = {},
  ) {
    const activeId = overrides.activeId ?? 'rightcode'
    const apiKeys = overrides.apiKeys ?? { rightcode: 'sk-rc' }
    useSettingsStore.setState({
      providers: {
        builtins: GATEWAY_SNAPSHOT.builtins,
        custom: [],
        activeId,
        appliedId: activeId,
        pendingProviderId: null,
        apiKeys,
        loaded: true,
        loadError: null,
      },
      codexApiKey: apiKeys[activeId] ?? '',
      ...REAL_STORE_ACTIONS,
    })
  }

  beforeEach(() => {
    addToast.mockReset()
    useToastStore.setState({ toasts: [], addToast })
    useAgentChatStore.setState({
      invalidateCollaborationCapabilities: vi.fn(),
      loadCollaborationCapabilities: vi.fn().mockResolvedValue(undefined),
      loadModelSettingsCatalog: vi.fn().mockResolvedValue(undefined),
    } as never)
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as BridgeWindow).electronAPI
  })

  it('renders two builtin gateways instead of Grok provider cards', async () => {
    installBridge({
      getGateways: vi.fn().mockResolvedValue(GATEWAY_SNAPSHOT),
    })
    useSettingsStore.setState({
      providers: {
        builtins: [],
        custom: [],
        activeId: 'apiyi',
        appliedId: 'apiyi',
        pendingProviderId: null,
        apiKeys: {},
        loaded: false,
        loadError: null,
      },
      codexApiKey: '',
      ...REAL_STORE_ACTIONS,
    })

    render(<CodexProviderManager />)
    await screen.findByText('API Yi')

    expect(screen.getByRole('radio', { name: /Right\.Codes/ })).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.queryByText('API Yi Grok')).toBeNull()
    expect(screen.queryByText('Right.Codes Grok')).toBeNull()
  })

  it('shows radio-card semantics with Active/Ready status and capability chips', () => {
    seedLoadedGateways({
      activeId: 'rightcode',
      apiKeys: { apiyi: 'sk-a', rightcode: 'sk-rc' },
    })

    render(<CodexProviderManager />)

    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBeGreaterThanOrEqual(2)
    const rightcodeCard = screen.getByRole('radio', { name: /Right\.Codes/ })
    expect(rightcodeCard.getAttribute('aria-checked')).toBe('true')
    const apiyiCard = screen.getByRole('radio', { name: /API Yi/ })
    expect(apiyiCard.getAttribute('aria-checked')).toBe('false')

    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getAllByText('GPT')).toHaveLength(2)
    expect(screen.getAllByText('Grok 4.5')).toHaveLength(2)
  })

  it('marks a gateway without a saved key as Needs key', () => {
    seedLoadedGateways({
      activeId: 'rightcode',
      apiKeys: { rightcode: 'sk-rc' },
    })

    render(<CodexProviderManager />)

    expect(screen.getByText('Needs key')).toBeTruthy()
  })

  it('saves one shared key for the active gateway', async () => {
    const setGatewayApiKey = vi.fn().mockResolvedValue({
      ok: true,
      activeId: 'rightcode',
    })
    installBridge({
      setGatewayApiKey,
      getGateways: vi.fn().mockResolvedValue(GATEWAY_SNAPSHOT),
    })
    seedLoadedGateways({ activeId: 'rightcode', apiKeys: { rightcode: '' } })

    render(<CodexProviderManager />)

    const input = screen.getByLabelText('Right.Codes API Key')
    fireEvent.change(input, { target: { value: 'shared-key' } })
    fireEvent.click(screen.getByRole('button', { name: '测试并保存' }))

    await waitFor(() => {
      expect(setGatewayApiKey).toHaveBeenCalledWith('rightcode', 'shared-key')
    })
  })

  it('selects a gateway through selectGateway', async () => {
    const setActiveGateway = vi.fn().mockResolvedValue({
      ok: true,
      activeId: 'apiyi',
    })
    installBridge({ setActiveGateway })
    seedLoadedGateways({
      activeId: 'rightcode',
      apiKeys: { apiyi: 'sk-a', rightcode: 'sk-rc' },
    })

    render(<CodexProviderManager />)
    fireEvent.click(screen.getByRole('radio', { name: /API Yi/ }))

    await waitFor(() => {
      expect(setActiveGateway).toHaveBeenCalledWith('apiyi')
    })
  })
})
