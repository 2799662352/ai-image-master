// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanReasoningEffort } from '../../../../../shared/collaborationMode'
import { ModelPicker } from '../ModelPicker'
import { useAgentChatStore } from '../store'

const setSelectedModel = vi.fn<(modelId: string) => void>()
const setPlanReasoningEffort = vi.fn<
  (effort: PlanReasoningEffort) => Promise<void>
>()
const originalSetSelectedModel = useAgentChatStore.getState().setSelectedModel
const originalSetPlanReasoningEffort =
  useAgentChatStore.getState().setPlanReasoningEffort

function setPickerState(
  overrides: Partial<ReturnType<typeof useAgentChatStore.getState>> = {},
): void {
  useAgentChatStore.setState({
    threadId: 'thread-1',
    selectedModelId: 'gpt-5.4',
    modelReasoningEffortByModel: { 'gpt-5.4': 'high' },
    collabModeKind: 'plan',
    collabModePendingByThread: {},
    isRunning: false,
    setSelectedModel,
    setPlanReasoningEffort,
    ...overrides,
  } as never)
}

function getTrigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: /选择模型/ }) as HTMLButtonElement
}

function openPicker(): void {
  fireEvent.click(getTrigger())
}

beforeEach(() => {
  setSelectedModel.mockReset()
  setPlanReasoningEffort.mockReset().mockResolvedValue(undefined)
  setPickerState()
})

afterEach(() => {
  cleanup()
  useAgentChatStore.setState({
    setSelectedModel: originalSetSelectedModel,
    setPlanReasoningEffort: originalSetPlanReasoningEffort,
  } as never)
})

describe('ModelPicker canonical model rows', () => {
  it('shows each canonical model once and no legacy effort pseudo-rows', () => {
    render(<ModelPicker />)
    openPicker()

    expect(screen.getAllByRole('option', { name: 'GPT-5.4' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'GPT-5.5' })).toHaveLength(1)
    expect(screen.queryByRole('option', { name: /GPT-5\.4 \(High effort\)/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /GPT-5\.5 \(Extra High\)/ })).toBeNull()
  })

  it.each(['plan', 'default'] as const)(
    'selects a real model directly in %s mode without mutating Plan effort',
    (collabModeKind) => {
      setPickerState({ collabModeKind })
      render(<ModelPicker />)
      openPicker()

      fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6 Sol' }))

      expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.6-sol')
      expect(setPlanReasoningEffort).not.toHaveBeenCalled()
      expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
      expect(screen.queryByRole('listbox')).toBeNull()
    },
  )

  it.each([
    ['disabled prop', { disabled: true, running: false }],
    ['running state', { disabled: false, running: true }],
  ])('does not open while blocked by %s', (_label, state) => {
    setPickerState({ isRunning: state.running })
    render(<ModelPicker disabled={state.disabled} />)

    const trigger = getTrigger()
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(setSelectedModel).not.toHaveBeenCalled()
  })

  it('closes an open picker when a collaboration transition becomes pending', async () => {
    render(<ModelPicker />)
    openPicker()
    expect(screen.getByRole('listbox')).toBeTruthy()

    useAgentChatStore.setState({
      collabModePendingByThread: {
        'thread-1': { target: 'plan', requestVersion: 1 },
      },
    } as never)

    await waitFor(() => {
      expect(getTrigger().disabled).toBe(true)
      expect(screen.queryByRole('listbox')).toBeNull()
    })
  })

  it('restores trigger focus when Escape closes the model list', async () => {
    render(<ModelPicker />)
    const trigger = getTrigger()
    trigger.focus()
    openPicker()
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search models')).toBe(document.activeElement)
    })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on an outside pointerdown', () => {
    render(<ModelPicker />)
    openPicker()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
