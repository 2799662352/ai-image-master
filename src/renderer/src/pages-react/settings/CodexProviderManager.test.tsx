import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useToastStore } from '../../stores/useToastStore'
import { CodexProviderManager } from './CodexProviderManager'

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
      selectProvider: vi.fn().mockResolvedValue(undefined),
      saveProviderKey: vi.fn().mockResolvedValue(undefined),
      updateProvider: vi.fn().mockResolvedValue(undefined),
      removeProvider: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders pending separately from active and disables key writes while switching', () => {
    const saveProviderKey = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState((state) => ({
      providers: { ...state.providers, pendingProviderId: 'rightcode' },
      saveProviderKey,
    }))

    render(<CodexProviderManager />)

    expect(screen.getByText('切换中…')).toBeTruthy()
    expect(screen.getByText(/当前 provider:/).textContent).toContain('API Yi')
    const saveButton = screen.getByRole('button', { name: /保存 API Yi 的 Key/ })
    expect(saveButton.matches(':disabled')).toBe(true)
    fireEvent.click(saveButton)
    expect(saveProviderKey).not.toHaveBeenCalled()
  })

  it('shows an error toast when Provider selection fails', async () => {
    useSettingsStore.setState({
      selectProvider: vi.fn().mockRejectedValue(new Error('switch failed')),
    })
    render(<CodexProviderManager />)

    fireEvent.click(screen.getByRole('button', { name: /Right Code/ }))

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        message: 'switch failed',
        type: 'error',
      })
    })
  })

  it('does not show key success when saving the active key fails', async () => {
    useSettingsStore.setState({
      saveProviderKey: vi.fn().mockRejectedValue(new Error('key restart failed')),
    })
    render(<CodexProviderManager />)

    fireEvent.click(screen.getByRole('button', { name: /保存 API Yi 的 Key/ }))

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
