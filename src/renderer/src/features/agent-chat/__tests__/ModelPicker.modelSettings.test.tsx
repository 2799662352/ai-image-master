// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentModelSettingsCatalog } from '../../../../../types/agent'
import { resolveGatewayModelRoute } from '../../../../../main/agent/gatewayModelRouting'
import { ModelPicker } from '../ModelPicker'
import { useAgentChatStore } from '../store'

const setSelectedModel = vi.fn<(modelId: string) => Promise<void>>()
const setModelReasoningEffort = vi.fn()
const setModelContextWindow = vi.fn<(contextWindow: number) => Promise<void>>()
const originalActions = {
  setSelectedModel: useAgentChatStore.getState().setSelectedModel,
  setModelReasoningEffort: useAgentChatStore.getState().setModelReasoningEffort,
  setModelContextWindow: useAgentChatStore.getState().setModelContextWindow,
}

function runtimeCatalog(source: 'codex' | 'fallback' = 'codex'): AgentModelSettingsCatalog {
  const solRoute = resolveGatewayModelRoute('rightcode', 'gpt-5.6-sol')
  const gpt55Route = resolveGatewayModelRoute('rightcode', 'gpt-5.5')
  return {
    gatewayId: 'rightcode',
    revision: `test-${source}`,
    source,
    models: [
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'Frontier model',
        hidden: false,
        isDefault: true,
        family: solRoute.family,
        route: solRoute,
        availability: { status: 'available' },
        capabilities: {
          model: 'gpt-5.6-sol',
          provider: 'rightcode',
          defaultContextWindow: 372_000,
          contextOptions: [
            { value: 372_000, experimental: false, ...(source === 'fallback' ? { conservative: true } : {}) },
            { value: 1_000_000, experimental: true, ...(source === 'fallback' ? { conservative: true } : {}) },
          ],
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Stable model',
        hidden: false,
        isDefault: false,
        family: gpt55Route.family,
        route: gpt55Route,
        availability: { status: 'available' },
        capabilities: {
          model: 'gpt-5.5',
          provider: 'rightcode',
          defaultContextWindow: 272_000,
          contextOptions: [
            { value: 272_000, experimental: false, ...(source === 'fallback' ? { conservative: true } : {}) },
            { value: 1_000_000, experimental: true, ...(source === 'fallback' ? { conservative: true } : {}) },
          ],
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
      },
    ],
  }
}

function setPickerState(
  overrides: Partial<ReturnType<typeof useAgentChatStore.getState>> = {},
): void {
  useAgentChatStore.setState({
    threadId: 'thread-1',
    selectedModelId: 'gpt-5.6-sol',
    modelSettingsCatalog: runtimeCatalog(),
    modelReasoningEffortByModel: {
      'gpt-5.6-sol': 'xhigh',
      'gpt-5.5': 'high',
    },
    modelContextWindowByModel: {},
    activeModelContextWindow: 372_000,
    modelContextPending: undefined,
    modelSettingsLoading: false,
    modelSettingsError: undefined,
    modelSettingsPersistenceWarnings: {},
    collabModeKind: 'plan',
    collabModePendingByThread: {},
    isRunning: false,
    setSelectedModel,
    setModelReasoningEffort,
    setModelContextWindow,
    ...overrides,
  } as never)
}

function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
}

beforeEach(() => {
  setSelectedModel.mockReset().mockResolvedValue(undefined)
  setModelReasoningEffort.mockReset()
  setModelContextWindow.mockReset().mockResolvedValue(undefined)
  setPickerState()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAgentChatStore.setState(originalActions as never)
})

describe('ModelPicker model settings integration', () => {
  it('renders one row per runtime model and a model · reasoning trigger summary', () => {
    render(<ModelPicker />)

    expect(screen.getByRole('button', {
      name: /选择模型：GPT-5\.6 Sol · Extra High/,
    })).toBeTruthy()
    openPicker()
    expect(screen.getAllByRole('option', { name: 'GPT-5.6 Sol' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'GPT-5.5' })).toHaveLength(1)
  })

  it('mounts ModelSettingsPanel with confirmed 5.6 Sol capabilities', () => {
    render(<ModelPicker />)
    openPicker()

    expect(screen.getByRole('listbox', { name: '模型上下文' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /372K/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /1M/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Max' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Ultra/i })).toBeNull()
    expect(screen.queryByRole('option', { name: /^Fast$/i })).toBeNull()
  })

  it('uses the selected runtime row so Right Code 5.5 does not expose Max', () => {
    setPickerState({
      selectedModelId: 'gpt-5.5',
      activeModelContextWindow: 272_000,
    })
    render(<ModelPicker />)
    openPicker()

    expect(screen.getByRole('option', { name: /272K/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /1M/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Max' })).toBeNull()
  })

  it('shows conservative capability status for fallback catalog rows', () => {
    setPickerState({ modelSettingsCatalog: runtimeCatalog('fallback') })
    render(<ModelPicker />)
    openPicker()

    expect(screen.getByText(/模型可用性与能力未确认/)).toBeTruthy()
    expect(screen.getAllByText(/保守默认/).length).toBeGreaterThan(0)
  })

  it('falls back to canonical rows and keeps an unknown current slug coherent', () => {
    setPickerState({
      selectedModelId: 'vendor-future-1m',
      modelSettingsCatalog: undefined,
      modelReasoningEffortByModel: { 'vendor-future-1m': 'auto' },
      activeModelContextWindow: 200_000,
    })
    render(<ModelPicker />)

    expect(screen.getByRole('button', {
      name: /选择模型：Unknown · vendor-future-1m · Auto/,
    })).toBeTruthy()
    openPicker()
    expect(screen.getByRole('option', { name: 'Unknown · vendor-future-1m' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'GPT-5.6 Sol' })).toBeTruthy()
  })

  it('does not invent canonical rows for an empty runtime catalog', () => {
    setPickerState({
      selectedModelId: 'vendor-runtime-only',
      modelSettingsCatalog: {
        gatewayId: 'rightcode',
        revision: 'test-empty',
        source: 'codex',
        models: [],
      },
      modelReasoningEffortByModel: { 'vendor-runtime-only': 'auto' },
      activeModelContextWindow: 200_000,
    })
    render(<ModelPicker />)
    openPicker()

    expect(screen.getByRole('option', { name: 'Unknown · vendor-runtime-only' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'GPT-5.6 Sol' })).toBeNull()
    expect(screen.getByText(/能力未确认/)).toBeTruthy()
  })

  it('keeps canonical metadata for a pinned model omitted by the runtime catalog', () => {
    setPickerState({
      selectedModelId: 'grok-4.5',
      modelSettingsCatalog: {
        gatewayId: 'rightcode',
        revision: 'test-rightcode-grok',
        source: 'codex',
        models: [],
      },
      modelReasoningEffortByModel: { 'grok-4.5': 'auto' },
      activeModelContextWindow: 1_000_000,
    })
    render(<ModelPicker />)

    expect(screen.getByRole('button', {
      name: /选择模型：Grok 4\.5 · Auto/,
    })).toBeTruthy()
    openPicker()
    expect(screen.getByRole('option', { name: 'Grok 4.5' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /1M/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /500K/ })).toBeNull()
    expect(screen.getByText(/能力未确认/)).toBeTruthy()
  })

  it('routes panel changes to model-scoped actions and removes legacy Plan scope UI', async () => {
    render(<ModelPicker />)
    openPicker()

    fireEvent.click(screen.getByRole('option', { name: 'Max' }))
    fireEvent.click(screen.getByRole('option', { name: /1M/ }))
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.5' }))

    expect(setModelReasoningEffort).toHaveBeenCalledWith('gpt-5.6-sol', 'max')
    expect(setModelContextWindow).toHaveBeenCalledWith(1_000_000)
    expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.5')
    await waitFor(() => {
      expect(screen.queryByText('仅 Plan')).toBeNull()
      expect(screen.queryByText('所有模式')).toBeNull()
      expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
    })
  })

  it.each([
    ['running', { isRunning: true }],
    [
      'context pending',
      {
        modelContextPending: {
          model: 'gpt-5.6-sol',
          contextWindow: 1_000_000,
          requestVersion: 1,
        },
      },
    ],
  ])('disables model settings while %s', (_label, patch) => {
    setPickerState(patch as never)
    render(<ModelPicker />)

    expect(
      (screen.getByRole('button', { name: /选择模型/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('blocks model, reasoning, and context actions while loading but keeps Escape focus restore', () => {
    setPickerState({ modelSettingsLoading: true })
    render(<ModelPicker />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })

    expect((trigger as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(trigger)
    const modelOption = screen.getByRole('option', { name: 'GPT-5.5' })
    const reasoningOption = screen.getByRole('option', { name: 'Max' })
    const contextOption = screen.getByRole('option', { name: /1M/ })
    expect((modelOption as HTMLButtonElement).disabled).toBe(true)
    expect((reasoningOption as HTMLButtonElement).disabled).toBe(true)
    expect((contextOption as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(modelOption)
    fireEvent.click(reasoningOption)
    fireEvent.click(contextOption)
    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(setModelReasoningEffort).not.toHaveBeenCalled()
    expect(setModelContextWindow).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '模型列表' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('restores trigger focus only after async model selection clears pending', async () => {
    let releaseSelection!: () => void
    const selectionGate = new Promise<void>((resolve) => {
      releaseSelection = resolve
    })
    let focusFrame: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      focusFrame = callback
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    setSelectedModel.mockImplementation(async (modelId) => {
      await selectionGate
      useAgentChatStore.setState({ selectedModelId: modelId })
    })
    render(<ModelPicker />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    openPicker()
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.5' }))
    expect((trigger as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      releaseSelection()
      await selectionGate
    })
    await waitFor(() => {
      expect((trigger as HTMLButtonElement).disabled).toBe(false)
      expect(screen.queryByRole('listbox', { name: '模型列表' })).toBeNull()
    })
    expect(document.activeElement).not.toBe(trigger)

    act(() => {
      focusFrame?.(performance.now())
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps keyboard navigation within the filtered flat model list', () => {
    render(<ModelPicker />)
    openPicker()
    const search = screen.getByRole('textbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'GPT-5.5' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const onlyOption = screen.getByRole('option', { name: 'GPT-5.5' })
    expect(document.activeElement).toBe(onlyOption)

    fireEvent.keyDown(onlyOption, { key: 'End' })
    expect(document.activeElement).toBe(onlyOption)
    fireEvent.keyDown(onlyOption, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(onlyOption)
  })
})
