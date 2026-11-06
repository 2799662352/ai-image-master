// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentModelSettingsCatalog } from '../../../../../types/agent'
import { buildGatewayModelCatalog } from '../../../../../main/agent/gatewayModelCatalog'
import { ModelPicker } from '../ModelPicker'
import { useAgentChatStore } from '../store'

/**
 * Curated hiding (`pickerHidden`): the Qwen 3.7 rows stay in the catalog (routing,
 * availability and capabilities are untouched) but are not listed in the picker.
 * A persisted selection that still points at one must stay readable and
 * coherent, then disappear once the user switches away.
 */

const setSelectedModel = vi.fn<(modelId: string) => Promise<void>>()
const originalActions = {
  setSelectedModel: useAgentChatStore.getState().setSelectedModel,
}

function apiyiCatalog(): AgentModelSettingsCatalog {
  return buildGatewayModelCatalog({
    gatewayId: 'apiyi',
    dynamicSource: 'codex',
    dynamicModels: [{
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Stable model',
      hidden: false,
      isDefault: true,
    }],
    hasCredential: () => true,
    availabilityByModel: new Map(),
  })
}

function setPickerState(
  overrides: Partial<ReturnType<typeof useAgentChatStore.getState>> = {},
): void {
  useAgentChatStore.setState({
    threadId: 'thread-1',
    selectedModelId: 'gpt-5.5',
    modelSettingsCatalog: apiyiCatalog(),
    modelReasoningEffortByModel: {},
    modelContextWindowByModel: {},
    activeModelContextWindow: 272_000,
    modelContextPending: undefined,
    modelSettingsLoading: false,
    modelSettingsError: undefined,
    modelSettingsPersistenceWarnings: {},
    modelSelectionPending: undefined,
    modelSelectionFailedIntent: undefined,
    modelSelectionError: undefined,
    collabModeKind: 'plan',
    collabModePendingByThread: {},
    isRunning: false,
    setSelectedModel,
    ...overrides,
  } as never)
}

function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
}

beforeEach(() => {
  setSelectedModel.mockReset().mockResolvedValue(undefined)
  setPickerState()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAgentChatStore.setState(originalActions as never)
})

describe('ModelPicker curated hidden models', () => {
  it('does not list Qwen 3.7 Plus / Max, but still lists the 3.8 generation', () => {
    render(<ModelPicker />)
    openPicker()

    expect(screen.queryByRole('option', { name: 'Qwen 3.7 Plus' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Qwen 3.7 Max' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Qwen 3.8 Max' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Qwen 3.8 Flash' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Qwen 3.8 Omni Flash' })).toBeTruthy()
  })

  it('does not list them in the offline fallback list either', () => {
    setPickerState({ modelSettingsCatalog: undefined })
    render(<ModelPicker />)
    openPicker()

    expect(screen.queryByRole('option', { name: 'Qwen 3.7 Plus' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Qwen 3.7 Max' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Qwen 3.8 Max' })).toBeTruthy()
  })

  it('keeps a persisted selection of a hidden model readable and coherent', () => {
    setPickerState({
      selectedModelId: 'qwen3.7-max-dashscope',
      activeModelContextWindow: 1_000_000,
    })
    render(<ModelPicker />)

    expect(screen.getByRole('button', {
      name: /选择模型：Qwen 3\.7 Max/,
    })).toBeTruthy()
    openPicker()
    // Pinned once (not duplicated), taken from the real catalog row rather than
    // the "capabilities unconfirmed" placeholder.
    expect(screen.getAllByRole('option', { name: 'Qwen 3.7 Max' })).toHaveLength(1)
    expect(screen.queryByRole('option', { name: 'Qwen 3.7 Plus' })).toBeNull()
    expect(screen.queryByText(/能力未确认/)).toBeNull()
  })

  it('stops listing the hidden model once the selection moves away', () => {
    setPickerState({ selectedModelId: 'qwen3.7-plus-dashscope' })
    const view = render(<ModelPicker />)
    openPicker()
    expect(screen.getAllByRole('option', { name: 'Qwen 3.7 Plus' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('option', { name: 'Qwen 3.8 Max' }))
    expect(setSelectedModel).toHaveBeenCalledWith('qwen3.8-max')

    // The store applies the selection: re-render with the new one.
    cleanup()
    setPickerState({ selectedModelId: 'qwen3.8-max' })
    view.unmount()
    render(<ModelPicker />)
    openPicker()
    expect(screen.queryByRole('option', { name: 'Qwen 3.7 Plus' })).toBeNull()
  })
})
