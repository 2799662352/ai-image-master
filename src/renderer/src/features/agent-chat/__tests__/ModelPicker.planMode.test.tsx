// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanReasoningEffort } from '../../../../../shared/collaborationMode'
import { ModelPicker } from '../ModelPicker'
import { useAgentChatStore } from '../store'

const setSelectedModel = vi.fn<(modelId: string) => void>()
const setPlanReasoningEffort = vi.fn<(effort: PlanReasoningEffort) => Promise<void>>()
const originalSetSelectedModel = useAgentChatStore.getState().setSelectedModel
const originalSetPlanReasoningEffort = useAgentChatStore.getState().setPlanReasoningEffort

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setPickerState(
  overrides: Partial<ReturnType<typeof useAgentChatStore.getState>> = {},
): void {
  useAgentChatStore.setState({
    threadId: 'thread-1',
    selectedModelId: 'gpt-5.4-low',
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

function chooseModel(name: string): void {
  openPicker()
  fireEvent.click(screen.getByRole('option', { name }))
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

describe('ModelPicker Plan-mode scope choice', () => {
  it('asks for scope before changing effort variants of the same canonical model in Plan', () => {
    render(<ModelPicker />)

    chooseModel('GPT-5.4 (High effort)')

    expect(screen.getByRole('group', { name: '选择模型作用域' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '仅 Plan' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '所有模式' })).toBeTruthy()
    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(setPlanReasoningEffort).not.toHaveBeenCalled()
  })

  it.each([
    ['gpt-5.4-medium', 'GPT-5.4 (Low effort)', 'low'],
    ['gpt-5.4-low', 'GPT-5.4 (Medium effort)', 'medium'],
    ['gpt-5.4-low', 'GPT-5.4 (High effort)', 'high'],
    ['gpt-5.4-low', 'GPT-5.4 (Extra High)', 'xhigh'],
    ['gpt-5.4-high', 'GPT-5.4', 'auto'],
  ] as const)(
    'maps the target effort to a Plan-only override without changing the model (%s → %s)',
    async (selectedModelId, targetName, expectedEffort) => {
      setPickerState({ selectedModelId })
      render(<ModelPicker />)

      fireEvent.click(getTrigger())
      fireEvent.click(screen.getByRole('option', { name: targetName }))
      fireEvent.click(screen.getByRole('button', { name: '仅 Plan' }))

      await waitFor(() => {
        expect(setPlanReasoningEffort).toHaveBeenCalledTimes(1)
        expect(setPlanReasoningEffort).toHaveBeenCalledWith(expectedEffort)
        expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
      })
      expect(setSelectedModel).not.toHaveBeenCalled()
      expect(useAgentChatStore.getState().selectedModelId).toBe(selectedModelId)
    },
  )

  it('applies the target globally before resetting the Plan-only override', async () => {
    render(<ModelPicker />)

    chooseModel('GPT-5.4 (High effort)')
    const allModes = screen.getByRole('button', { name: '所有模式' })
    fireEvent.click(allModes)
    fireEvent.click(allModes)

    await waitFor(() => {
      expect(setSelectedModel).toHaveBeenCalledTimes(1)
      expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.4-high')
      expect(setPlanReasoningEffort).toHaveBeenCalledTimes(1)
      expect(setPlanReasoningEffort).toHaveBeenCalledWith('auto')
    })
    expect(setSelectedModel.mock.invocationCallOrder[0])
      .toBeLessThan(setPlanReasoningEffort.mock.invocationCallOrder[0])
  })

  it('uses synchronous normal model selection for a different canonical model in Plan', () => {
    render(<ModelPicker />)

    chooseModel('GPT-5.5 (Extra High)')

    expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.5-xhigh')
    expect(setPlanReasoningEffort).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('uses synchronous normal model selection for same-model effort changes in Default mode', () => {
    setPickerState({ collabModeKind: 'default' })
    render(<ModelPicker />)

    chooseModel('GPT-5.4 (High effort)')

    expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.4-high')
    expect(setPlanReasoningEffort).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('does not ask for scope when canonical model and effort are unchanged', () => {
    render(<ModelPicker />)

    chooseModel('GPT-5.4 (Low effort)')

    expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.4-low')
    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('returns to the model list and clears pending scope targets on Escape and outside click', async () => {
    render(<ModelPicker />)
    chooseModel('GPT-5.4 (High effort)')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
    expect(screen.getByRole('listbox')).toBeTruthy()

    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4 (Medium effort)' }))
    expect(screen.getByRole('group', { name: '选择模型作用域' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回模型列表' }))
    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4 (Extra High)' }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()

    openPicker()
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.5 (Extra High)' }))
    await waitFor(() => expect(setSelectedModel).toHaveBeenCalledWith('gpt-5.5-xhigh'))
    expect(setPlanReasoningEffort).not.toHaveBeenCalled()
  })

  it.each([
    ['disabled prop', { disabled: true, running: false }],
    ['running state', { disabled: false, running: true }],
  ])('does not open or select while blocked by %s', (_label, state) => {
    setPickerState({ isRunning: state.running })
    render(<ModelPicker disabled={state.disabled} />)

    const trigger = getTrigger()
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(setSelectedModel).not.toHaveBeenCalled()
  })

  it('guards an asynchronous scope action against duplicate submission', async () => {
    const applying = deferred<void>()
    setPlanReasoningEffort.mockReturnValue(applying.promise)
    render(<ModelPicker />)
    chooseModel('GPT-5.4 (High effort)')

    const planOnly = screen.getByRole('button', { name: '仅 Plan' })
    planOnly.focus()
    fireEvent.click(planOnly)
    fireEvent.click(planOnly)
    const enterAllowedDefault = fireEvent.keyDown(planOnly, { key: 'Enter' })

    expect(setPlanReasoningEffort).toHaveBeenCalledTimes(1)
    expect((planOnly as HTMLButtonElement).disabled).toBe(false)
    expect(planOnly.hasAttribute('disabled')).toBe(false)
    expect(planOnly.getAttribute('aria-disabled')).toBe('true')
    expect(enterAllowedDefault).toBe(false)

    await act(async () => {
      applying.resolve()
      await applying.promise
    })

    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
  })

  it.each(['plan', 'default'] as const)(
    'blocks and closes the picker while the active thread has a pending %s transition',
    async (target) => {
      render(<ModelPicker />)
      chooseModel('GPT-5.4 (High effort)')
      expect(screen.getByRole('group', { name: '选择模型作用域' })).toBeTruthy()

      act(() => {
        useAgentChatStore.setState({
          collabModeKind: target,
          collabModePendingByThread: {
            'thread-1': { target, requestVersion: 1 },
          },
        } as never)
      })

      await waitFor(() => {
        expect(getTrigger().disabled).toBe(true)
        expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
        expect(screen.queryByRole('listbox')).toBeNull()
      })
      fireEvent.click(getTrigger())
      expect(setSelectedModel).not.toHaveBeenCalled()
      expect(setPlanReasoningEffort).not.toHaveBeenCalled()
    },
  )

  it('restores trigger focus when Escape closes the model list', async () => {
    render(<ModelPicker />)
    const trigger = getTrigger()
    trigger.focus()
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByPlaceholderText('Search models')).toBe(document.activeElement))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('uses first Escape to return from scope and second Escape to close and restore focus', async () => {
    render(<ModelPicker />)
    const trigger = getTrigger()
    chooseModel('GPT-5.4 (High effort)')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '仅 Plan' })).toBe(document.activeElement)
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeTruthy()
      expect(screen.getByPlaceholderText('Search models')).toBe(document.activeElement)
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each([
    ['Tab', false],
    ['Shift+Tab', true],
  ] as const)('closes without stealing focus when %s leaves the root', async (_label, shiftKey) => {
    render(
      <>
        <button type="button">Before picker</button>
        <ModelPicker />
        <button type="button">After picker</button>
      </>,
    )
    openPicker()
    const internal = shiftKey
      ? getTrigger()
      : screen.getByPlaceholderText('Search models')
    const external = screen.getByRole('button', {
      name: shiftKey ? 'Before picker' : 'After picker',
    })
    internal.focus()

    fireEvent.keyDown(internal, { key: 'Tab', shiftKey })
    external.focus()

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(document.activeElement).toBe(external)
  })

  it('restores focus after a successful scope action only while focus remains inside', async () => {
    const applying = deferred<void>()
    setPlanReasoningEffort.mockReturnValue(applying.promise)
    render(
      <>
        <ModelPicker />
        <button type="button">External focus</button>
      </>,
    )
    const trigger = getTrigger()
    chooseModel('GPT-5.4 (High effort)')
    const planOnly = screen.getByRole('button', { name: '仅 Plan' })
    planOnly.focus()
    fireEvent.click(planOnly)

    await act(async () => {
      applying.resolve()
      await applying.promise
    })
    expect(document.activeElement).toBe(trigger)

    const secondApplying = deferred<void>()
    setPlanReasoningEffort.mockReturnValue(secondApplying.promise)
    chooseModel('GPT-5.4 (High effort)')
    const secondPlanOnly = screen.getByRole('button', { name: '仅 Plan' })
    secondPlanOnly.focus()
    fireEvent.click(secondPlanOnly)
    const external = screen.getByRole('button', { name: 'External focus' })
    external.focus()

    await act(async () => {
      secondApplying.resolve()
      await secondApplying.promise
    })
    expect(screen.queryByRole('group', { name: '选择模型作用域' })).toBeNull()
    expect(document.activeElement).toBe(external)
  })

  it('closes without restoring focus when root blur has no related target', async () => {
    render(<ModelPicker />)
    const trigger = getTrigger()
    const focusTrigger = vi.spyOn(trigger, 'focus')
    openPicker()
    const search = screen.getByPlaceholderText('Search models')
    await waitFor(() => expect(search).toBe(document.activeElement))
    focusTrigger.mockClear()

    fireEvent.blur(search, { relatedTarget: null })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(focusTrigger).not.toHaveBeenCalled()
    focusTrigger.mockRestore()
  })

  it('uses pointerdown outside and removes its listener on close and unmount', () => {
    const addEventListener = vi.spyOn(document, 'addEventListener')
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<ModelPicker />)
    openPicker()
    const firstPointerListener = addEventListener.mock.calls.find(
      ([type]) => type === 'pointerdown',
    )?.[1]
    expect(firstPointerListener).toBeTypeOf('function')

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(removeEventListener).toHaveBeenCalledWith('pointerdown', firstPointerListener)

    openPicker()
    const pointerListeners = addEventListener.mock.calls.filter(
      ([type]) => type === 'pointerdown',
    )
    const lastPointerListener = pointerListeners[pointerListeners.length - 1]?.[1]
    unmount()
    expect(removeEventListener).toHaveBeenCalledWith('pointerdown', lastPointerListener)

    addEventListener.mockRestore()
    removeEventListener.mockRestore()
  })
})
