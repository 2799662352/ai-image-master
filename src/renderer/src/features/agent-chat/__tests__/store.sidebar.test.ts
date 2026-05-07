import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  globalThis.localStorage?.clear()
})

describe('sidebar state', () => {
  it('toggleSidebar flips sidebarOpen and persists to localStorage', async () => {
    const { useAgentChatStore } = await import('../store')
    const initial = useAgentChatStore.getState().sidebarOpen
    useAgentChatStore.getState().toggleSidebar()
    expect(useAgentChatStore.getState().sidebarOpen).toBe(!initial)
    expect(globalThis.localStorage?.getItem('catimation.agent.sidebarOpen')).toBe(String(!initial))
  })

  it('setSidebarWidth clamps to [200, 360] and persists', async () => {
    const { useAgentChatStore } = await import('../store')
    useAgentChatStore.getState().setSidebarWidth(50)
    expect(useAgentChatStore.getState().sidebarWidth).toBe(200)
    useAgentChatStore.getState().setSidebarWidth(9999)
    expect(useAgentChatStore.getState().sidebarWidth).toBe(360)
    useAgentChatStore.getState().setSidebarWidth(280)
    expect(useAgentChatStore.getState().sidebarWidth).toBe(280)
    expect(globalThis.localStorage?.getItem('catimation.agent.sidebarWidth')).toBe('280')
  })
})
