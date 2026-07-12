// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationModeKind, PlanReasoningEffort } from '../../../../../shared/collaborationMode'
import { CollabModeControl } from '../CollabModeControl'
import { useAgentChatStore } from '../store'

// This repository deliberately does not depend on @testing-library/user-event.
// Testing Library's real DOM render plus fireEvent keeps this task dependency-free
// while still exercising native button, focus, keyboard, and document events.
const requestCollabMode = vi.fn<(kind: CollaborationModeKind) => Promise<void>>()
const setPlanReasoningEffort = vi.fn<(effort: PlanReasoningEffort) => Promise<void>>()
const originalRequestCollabMode = useAgentChatStore.getState().requestCollabMode
const originalSetPlanReasoningEffort = useAgentChatStore.getState().setPlanReasoningEffort

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setControlState(
  overrides: Partial<ReturnType<typeof useAgentChatStore.getState>> = {},
): void {
  useAgentChatStore.setState({
    threadId: 'thread-1',
    isRunning: false,
    collabModeKind: 'default',
    collabModeByThread: { 'thread-1': 'default' },
    collabModePendingByThread: {},
    collabModeCompatibility: 'immediate',
    collabModeCompatibilityByThread: { 'thread-1': 'immediate' },
    collabModeNextTurnByThread: {},
    planReasoningEffort: 'auto',
    selectedModelId: 'gpt-5.5',
    collaborationCapabilities: {
      providerId: 'apiyi',
      planDefaultEffort: 'medium',
      supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
      source: 'codex',
    },
    collaborationCapabilitiesModel: 'gpt-5.5',
    collaborationError: undefined,
    collaborationErrorByThread: {},
    requestCollabMode,
    setPlanReasoningEffort,
    ...overrides,
  } as never)
}

beforeEach(() => {
  requestCollabMode.mockReset().mockResolvedValue(undefined)
  setPlanReasoningEffort.mockReset().mockResolvedValue(undefined)
  setControlState()
})

afterEach(() => {
  cleanup()
  useAgentChatStore.setState({
    requestCollabMode: originalRequestCollabMode,
    setPlanReasoningEffort: originalSetPlanReasoningEffort,
  } as never)
})

describe('CollabModeControl', () => {
  it('toggles only the requested mode from the primary button', () => {
    const { unmount } = render(<CollabModeControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan 推理设置' }))
    expect(screen.getByRole('listbox', { name: 'Plan 推理强度' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '切换到 Plan' }))
    expect(requestCollabMode).toHaveBeenCalledTimes(1)
    expect(requestCollabMode).toHaveBeenLastCalledWith('plan')
    expect(setPlanReasoningEffort).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()

    unmount()
    setControlState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    })
    render(<CollabModeControl />)
    fireEvent.click(screen.getByRole('button', { name: '切换到 Default' }))
    expect(requestCollabMode).toHaveBeenCalledTimes(2)
    expect(requestCollabMode).toHaveBeenLastCalledWith('default')
  })

  it('opens settings independently with connected ARIA state', () => {
    render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    expect(settings.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(settings)

    const listbox = screen.getByRole('listbox', { name: 'Plan 推理强度' })
    expect(requestCollabMode).not.toHaveBeenCalled()
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(settings.getAttribute('aria-controls')).toBe(listbox.id)
    expect(listbox.id).not.toBe('')
  })

  it('uses neutral cyan styling for Default and fuchsia styling plus a responsive effort suffix for Plan', () => {
    const { unmount } = render(<CollabModeControl />)
    const defaultButton = screen.getByRole('button', { name: '切换到 Plan' })
    expect(defaultButton.textContent).toContain('Default')
    expect(defaultButton.className).toContain('text-zinc')
    expect(defaultButton.className).toContain('cyan')

    unmount()
    setControlState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      planReasoningEffort: 'medium',
    })
    render(<CollabModeControl />)
    const planButton = screen.getByRole('button', { name: '切换到 Default' })
    expect(planButton.textContent).toContain('Plan')
    expect(planButton.className).toContain('fuchsia')
    const effortSuffix = within(planButton).getByText(/Medium/)
    expect(effortSuffix.className).toContain('hidden')
    expect(effortSuffix.className).toContain('sm:inline')
  })

  it('renders Auto first with the official current preset and only supported efforts', () => {
    setControlState({
      collaborationCapabilities: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'high', 'turbo'],
        source: 'codex',
      },
    })
    render(<CollabModeControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan 推理设置' }))

    const options = screen.getAllByRole('option')
    expect(options[0].textContent).toContain('Auto')
    expect(options[0].textContent).toContain('跟随 Codex Plan 预设 · 当前 medium')
    expect(screen.getByRole('option', { name: /Low/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /High/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Medium/ })).toBeNull()
    expect(screen.queryByText(/turbo/i)).toBeNull()
  })

  it('offers Max with its provider-aware description when capabilities support it', () => {
    setControlState({
      selectedModelId: 'gpt-5.6-sol',
      collaborationCapabilities: {
        providerId: 'rightcode',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: 'codex',
      },
      collaborationCapabilitiesModel: 'gpt-5.6-sol',
    })
    render(<CollabModeControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan 推理设置' }))

    expect(screen.getByRole('option', { name: /Max/ }).textContent).toContain(
      '最大推理深度；仅在当前模型与 Provider 支持时可用',
    )
  })

  it('labels fallback Auto honestly and exposes no concrete efforts without a catalog', () => {
    setControlState({
      collaborationCapabilities: {
        providerId: 'apiyi',
        planDefaultEffort: null,
        supportedPlanEfforts: [],
        source: 'fallback',
      },
    })
    render(<CollabModeControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan 推理设置' }))

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('未读取官方预设 · 当前未强制推理强度')
  })

  it('shows effective Auto while clearly preserving a temporarily suppressed High preference', () => {
    setControlState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      planReasoningEffort: 'high',
      collaborationCapabilities: {
        providerId: 'apiyi',
        planDefaultEffort: null,
        supportedPlanEfforts: [],
        source: 'fallback',
      },
    })
    render(<CollabModeControl />)

    const planButton = screen.getByRole('button', { name: '切换到 Default' })
    expect(planButton.textContent).toContain('Auto')
    expect(planButton.textContent).not.toContain('High')
    fireEvent.click(screen.getByRole('button', { name: 'Plan 推理设置' }))

    expect(screen.getByRole('option', { name: /Auto/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('option', { name: /High/ })).toBeNull()
    expect(screen.getByText('暂用 Auto，已保留 High 偏好')).toBeTruthy()
  })

  it('marks the selected effort, calls the store action, closes, and restores arrow focus', async () => {
    setControlState({ planReasoningEffort: 'high' })
    render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    fireEvent.click(settings)

    const selected = screen.getByRole('option', { name: /High/ })
    expect(selected.getAttribute('aria-selected')).toBe('true')
    expect(selected.textContent).toContain('✓')
    expect(selected.className).toContain('bg-fuchsia-500/10')
    expect(selected.className).toContain('focus-visible:ring-1')
    expect(selected.className).toContain('focus-visible:ring-fuchsia-400/70')

    fireEvent.click(screen.getByRole('option', { name: /Low/ }))

    await waitFor(() => {
      expect(setPlanReasoningEffort).toHaveBeenCalledWith('low')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(settings)
    })
  })

  it('guards a deferred effort request against same-tick click and Enter re-entry', async () => {
    const applying = deferred<void>()
    setPlanReasoningEffort.mockReturnValueOnce(applying.promise)
    render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    fireEvent.click(settings)
    const low = screen.getByRole('option', { name: /Low/ })

    act(() => {
      low.click()
      low.click()
      low.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      }))
    })

    expect(setPlanReasoningEffort).toHaveBeenCalledTimes(1)
    expect(setPlanReasoningEffort).toHaveBeenCalledWith('low')
    const listbox = screen.getByRole('listbox', { name: 'Plan 推理强度' })
    expect(listbox.getAttribute('aria-busy')).toBe('true')
    for (const option of screen.getAllByRole('option')) {
      expect(option.getAttribute('aria-disabled')).toBe('true')
    }

    await act(async () => {
      applying.resolve()
      await applying.promise
    })

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(settings)
    })
  })

  it('does not steal focus back when a deferred effort finishes after focus moved outside', async () => {
    const applying = deferred<void>()
    setPlanReasoningEffort.mockReturnValueOnce(applying.promise)
    render(
      <div>
        <CollabModeControl />
        <button type="button">外部目标</button>
      </div>,
    )
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    const outside = screen.getByRole('button', { name: '外部目标' })
    fireEvent.click(settings)
    fireEvent.click(screen.getByRole('option', { name: /Low/ }))

    fireEvent.pointerDown(outside)
    outside.focus()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(outside)

    await act(async () => {
      applying.resolve()
      await applying.promise
    })

    await waitFor(() => {
      expect(setPlanReasoningEffort).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(outside)
    })
  })

  it('clears effort busy state after a store-handled failure and preserves its error UI', async () => {
    const applying = deferred<void>()
    setPlanReasoningEffort.mockImplementationOnce(async () => {
      await applying.promise
      useAgentChatStore.setState({
        collaborationError: '协作模式更新失败：服务不可用',
      } as never)
    })
    render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    fireEvent.click(settings)
    fireEvent.click(screen.getByRole('option', { name: /High/ }))

    expect(screen.getByRole('listbox').getAttribute('aria-busy')).toBe('true')
    const actionPromise = setPlanReasoningEffort.mock.results[0].value
    await act(async () => {
      applying.resolve()
      await actionPromise
    })

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(settings)
    })
    expect(screen.getByRole('alert').textContent).toContain('协作模式更新失败：服务不可用')
    expect(screen.getByTestId('collab-mode-live').textContent).not.toContain('服务不可用')

    fireEvent.click(settings)
    expect(screen.getByRole('listbox').getAttribute('aria-busy')).toBe('false')
    for (const option of screen.getAllByRole('option')) {
      expect(option.getAttribute('aria-disabled')).toBe('false')
    }
  })

  it('explains Plan behavior, expensive efforts, and Plan-only scope', () => {
    render(<CollabModeControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan 推理设置' }))

    expect(screen.getByText('Plan 模式')).toBeTruthy()
    expect(screen.getByText('先调研并形成计划，不直接执行')).toBeTruthy()
    expect(screen.getByRole('option', { name: /High/ }).textContent).toContain('可能增加用量与延迟')
    expect(screen.getByRole('option', { name: /Extra high/ }).textContent).toContain('可能显著增加用量与延迟')
    expect(screen.getByText('仅影响 Plan；Default保持模型原推理强度')).toBeTruthy()
  })

  it('shows a restrained pending state and prevents duplicate requests', () => {
    setControlState({
      collabModeKind: 'plan',
      collabModePendingByThread: {
        'thread-1': { target: 'plan', requestVersion: 2 },
      },
    })
    render(<CollabModeControl />)

    const primary = screen.getByRole('button', { name: '切换到 Default' })
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    expect(primary.hasAttribute('disabled')).toBe(true)
    expect(settings.hasAttribute('disabled')).toBe(true)
    expect(primary.textContent).toContain('切换中')
    expect(screen.getByText('正在切换到 Plan…')).toBeTruthy()
    fireEvent.click(primary)
    expect(requestCollabMode).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a running turn',
      {
        isRunning: true,
      },
    ],
    [
      'an active-thread mode request',
      {
        collabModePendingByThread: {
          'thread-1': { target: 'plan' as const, requestVersion: 3 },
        },
      },
    ],
  ])('closes an open popover when controls become disabled by %s', (_label, patch) => {
    render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    fireEvent.click(settings)
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)

    act(() => {
      useAgentChatStore.setState(patch as never)
    })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(settings.hasAttribute('disabled')).toBe(true)
    expect(document.activeElement).not.toBe(settings)
    fireEvent.click(settings)
    expect(screen.queryByRole('option')).toBeNull()
    expect(setPlanReasoningEffort).not.toHaveBeenCalled()
  })

  it('closes an open popover when the disabled prop changes without focusing the disabled arrow', () => {
    const { rerender } = render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    fireEvent.click(settings)
    expect(screen.getByRole('listbox')).toBeTruthy()

    rerender(<CollabModeControl disabled />)

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(settings.hasAttribute('disabled')).toBe(true)
    expect(document.activeElement).not.toBe(settings)
  })

  it.each([
    ['the prop', { disabled: true, running: false }],
    ['an active turn', { disabled: false, running: true }],
  ])('disables both buttons for %s with the running explanation', (_label, state) => {
    setControlState({ isRunning: state.running })
    render(<CollabModeControl disabled={state.disabled} />)

    for (const button of screen.getAllByRole('button')) {
      expect(button.hasAttribute('disabled')).toBe(true)
      expect(button.getAttribute('title')).toBe('当前回合结束后可切换')
    }
  })

  it('distinguishes next-turn compatibility from confirmed state and reports errors inline', () => {
    const { unmount } = render(<CollabModeControl />)
    unmount()
    setControlState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'default' },
      collabModeCompatibility: 'next-turn',
      collabModeNextTurnByThread: { 'thread-1': 'plan' },
    })
    render(<CollabModeControl />)

    expect(screen.getByText('下回合生效')).toBeTruthy()
    const live = screen.getByTestId('collab-mode-live')
    expect(live.textContent).toContain('Plan 将在下回合生效')
    expect(live.textContent).not.toContain('已切换到 Plan')

    act(() => {
      useAgentChatStore.setState({ collaborationError: '协作模式更新失败：网络错误' } as never)
    })
    expect(screen.getByRole('alert').textContent).toContain('协作模式更新失败：网络错误')
    expect(live.textContent).not.toContain('协作模式更新失败：网络错误')
  })

  it('announces pending and confirmed success politely while errors use only the alert channel', () => {
    setControlState({
      collabModeKind: 'plan',
      collabModePendingByThread: {
        'thread-1': { target: 'plan', requestVersion: 1 },
      },
    })
    render(<CollabModeControl />)
    const live = screen.getByTestId('collab-mode-live')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toContain('正在切换到 Plan')

    act(() => {
      useAgentChatStore.setState({
        collabModeKind: 'plan',
        collabModeByThread: { 'thread-1': 'plan' },
        collabModePendingByThread: {},
      } as never)
    })
    expect(live.textContent).toContain('已切换到 Plan')

    act(() => {
      useAgentChatStore.setState({ collaborationError: '设置失败' } as never)
    })
    expect(screen.getByRole('alert').textContent).toContain('设置失败')
    expect(live.textContent).not.toContain('设置失败')
  })

  it('opens from the native arrow button and supports complete listbox keyboard navigation', async () => {
    render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    settings.focus()
    fireEvent.click(settings)

    const auto = screen.getByRole('option', { name: /Auto/ })
    await waitFor(() => expect(document.activeElement).toBe(auto))

    fireEvent.keyDown(auto, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Low/ }))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    const xhigh = screen.getByRole('option', { name: /Extra high/ })
    expect(document.activeElement).toBe(xhigh)

    fireEvent.keyDown(xhigh, { key: 'Home' })
    expect(document.activeElement).toBe(auto)

    fireEvent.keyDown(auto, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(xhigh)
    fireEvent.keyDown(xhigh, { key: 'Enter' })

    await waitFor(() => {
      expect(setPlanReasoningEffort).toHaveBeenCalledWith('xhigh')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(settings)
    })
  })

  it('closes on Escape with arrow focus and closes on an outside pointer without stealing its focus', async () => {
    render(
      <div>
        <button type="button">外部操作</button>
        <CollabModeControl />
      </div>,
    )
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    fireEvent.click(settings)
    const auto = screen.getByRole('option', { name: /Auto/ })
    fireEvent.keyDown(auto, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(settings)

    fireEvent.click(settings)
    const outside = screen.getByRole('button', { name: '外部操作' })
    fireEvent.pointerDown(outside)
    outside.focus()
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(document.activeElement).toBe(outside)
  })

  it('closes on Tab or Shift+Tab focus leaving the root without restoring arrow focus', () => {
    render(
      <div>
        <button type="button">前一个控件</button>
        <CollabModeControl />
        <button type="button">后一个控件</button>
      </div>,
    )
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })
    const before = screen.getByRole('button', { name: '前一个控件' })
    const after = screen.getByRole('button', { name: '后一个控件' })

    fireEvent.click(settings)
    const auto = screen.getByRole('option', { name: /Auto/ })
    fireEvent.keyDown(auto, { key: 'Tab' })
    fireEvent.focusOut(auto, { relatedTarget: after })
    after.focus()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(after)

    fireEvent.click(settings)
    const reopenedAuto = screen.getByRole('option', { name: /Auto/ })
    fireEvent.keyDown(reopenedAuto, { key: 'Tab', shiftKey: true })
    fireEvent.focusOut(reopenedAuto, { relatedTarget: before })
    before.focus()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(before)
  })

  it('removes the exact pointerdown listener when an open control unmounts', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<CollabModeControl />)
    const settings = screen.getByRole('button', { name: 'Plan 推理设置' })

    fireEvent.click(settings)
    const addedPointerListeners = addSpy.mock.calls.filter(([type]) => type === 'pointerdown')
    expect(addedPointerListeners).toHaveLength(1)
    const listener = addedPointerListeners[0][1]

    unmount()

    const removedPointerListeners = removeSpy.mock.calls.filter(([type]) => type === 'pointerdown')
    expect(removedPointerListeners).toHaveLength(1)
    expect(removedPointerListeners[0][1]).toBe(listener)

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
