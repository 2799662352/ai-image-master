import { describe, it, expect, beforeEach } from 'vitest'
import { useTabStore } from '../useTabStore'

describe('useTabStore', () => {
  beforeEach(() => {
    useTabStore.setState({ activeTab: 'generate', previousTab: null })
  })

  it('has generate as default tab', () => {
    expect(useTabStore.getState().activeTab).toBe('generate')
  })

  it('switches tab', () => {
    useTabStore.getState().switchTab('history')
    expect(useTabStore.getState().activeTab).toBe('history')
    expect(useTabStore.getState().previousTab).toBe('generate')
  })

  it('rejects invalid tab', () => {
    useTabStore.getState().switchTab('nonexistent')
    expect(useTabStore.getState().activeTab).toBe('generate')
  })

  it('does not switch to same tab', () => {
    useTabStore.getState().switchTab('generate')
    expect(useTabStore.getState().previousTab).toBeNull()
  })

  it('supports subscribe with selector', () => {
    const calls: string[] = []
    const unsub = useTabStore.subscribe(
      (state) => state.activeTab,
      (tab) => calls.push(tab)
    )

    useTabStore.getState().switchTab('history')
    expect(calls).toEqual(['history'])

    useTabStore.getState().switchTab('settings')
    expect(calls).toEqual(['history', 'settings'])

    unsub()
    useTabStore.getState().switchTab('generate')
    expect(calls).toEqual(['history', 'settings'])
  })
})
