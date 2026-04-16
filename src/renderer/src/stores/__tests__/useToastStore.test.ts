import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToastStore } from '../useToastStore'

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    vi.useFakeTimers()
  })

  it('adds a toast', () => {
    useToastStore.getState().addToast({ message: 'hello', type: 'success' })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useToastStore.getState().toasts[0].message).toBe('hello')
  })

  it('removes a toast by id', () => {
    useToastStore.getState().addToast({ message: 'a', type: 'info' })
    const id = useToastStore.getState().toasts[0].id
    useToastStore.getState().removeToast(id)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('auto-removes after duration', () => {
    useToastStore.getState().addToast({ message: 'temp', type: 'warning', duration: 1000 })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(1100)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('clears all toasts', () => {
    useToastStore.getState().addToast({ message: 'a', type: 'info' })
    useToastStore.getState().addToast({ message: 'b', type: 'error' })
    useToastStore.getState().clearAll()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
