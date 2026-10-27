import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHoldToTalk } from '../useHoldToTalk'

afterEach(cleanup)

describe('useHoldToTalk', () => {
  it('orders a quick release after start and ignores key repetition', async () => {
    let started!: () => void
    const onCommand = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          started = resolve
        }),
    )
    renderHook(() => useHoldToTalk({ enabled: true, disabled: false, onCommand }))
    fireEvent.keyDown(window, { code: 'F8' })
    fireEvent.keyDown(window, { code: 'F8', repeat: true })
    fireEvent.keyUp(window, { code: 'F8' })
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1))
    expect(onCommand).toHaveBeenNthCalledWith(1, 'begin-asr-hold')
    await act(async () => started())
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2))
    expect(onCommand).toHaveBeenNthCalledWith(2, 'finish-asr-hold')
    fireEvent.keyUp(window, { code: 'F8' })
    expect(onCommand).toHaveBeenCalledTimes(2)
  })

  it.each(['escape', 'blur', 'disabled', 'off', 'unmount'])('cancels on %s without sending', async (reason) => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    const { rerender, unmount } = renderHook((props) => useHoldToTalk({ ...props, onCommand }), {
      initialProps: { enabled: true, disabled: false },
    })
    fireEvent.keyDown(window, { code: 'F8' })
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('begin-asr-hold'))
    if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    if (reason === 'blur') fireEvent.blur(window)
    if (reason === 'disabled') rerender({ enabled: true, disabled: true })
    if (reason === 'off') rerender({ enabled: false, disabled: false })
    if (reason === 'unmount') unmount()
    fireEvent.keyUp(window, { code: 'F8' })
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2))
    expect(onCommand).toHaveBeenLastCalledWith('cancel-asr-hold')
  })

  it('does not start while off, blocked, composing, or using a modified shortcut', async () => {
    const onCommand = vi.fn()
    const { rerender } = renderHook((props) => useHoldToTalk({ ...props, onCommand }), {
      initialProps: { enabled: false, disabled: false },
    })
    fireEvent.keyDown(window, { code: 'F8' })
    rerender({ enabled: true, disabled: true })
    fireEvent.keyDown(window, { code: 'F8' })
    rerender({ enabled: true, disabled: false })
    fireEvent.keyDown(window, { code: 'F8', ctrlKey: true })
    fireEvent.keyDown(window, { code: 'F8', isComposing: true })
    fireEvent.keyDown(window, { code: 'Space' })
    await act(async () => {})
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('cancels the hold when starting is refused', async () => {
    const onCommand = vi.fn().mockRejectedValueOnce(new Error('当前无法开始语音输入。')).mockResolvedValue(undefined)
    renderHook(() => useHoldToTalk({ enabled: true, disabled: false, onCommand }))
    fireEvent.keyDown(window, { code: 'F8' })
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2))
    expect(onCommand).toHaveBeenLastCalledWith('cancel-asr-hold')
  })
})
