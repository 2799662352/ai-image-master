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
})
