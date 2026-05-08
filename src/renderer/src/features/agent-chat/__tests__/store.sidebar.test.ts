import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  globalThis.localStorage?.clear()
})

describe('sidebar state', () => {
  it('refreshCodexThreadList loads codex sessions separately from local threads', async () => {
    const listCodexThreads = vi.fn().mockResolvedValue([
      {
        id: 'codex-1',
        title: 'Codex session',
        createdAt: '2026-05-08T01:00:00Z',
        updatedAt: '2026-05-08T01:10:00Z',
      },
    ])
    ;(globalThis as unknown as { window: { electronAPI: { agent: { listCodexThreads: typeof listCodexThreads } } } }).window = {
      electronAPI: { agent: { listCodexThreads } },
    }
    const { useAgentChatStore } = await import('../store')

    useAgentChatStore.setState({
      threadList: [{ id: 'local-1', title: 'Local', createdAt: '', updatedAt: '' }],
    })
    await useAgentChatStore.getState().refreshCodexThreadList()

    expect(useAgentChatStore.getState().threadList.map((thread) => thread.id)).toEqual(['local-1'])
    expect(useAgentChatStore.getState().codexThreadList.map((thread) => thread.id)).toEqual(['codex-1'])
  })

  it('forkCodexThread calls preload API and refreshes codex sessions', async () => {
    const listCodexThreads = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'before', title: 'Before', createdAt: '', updatedAt: '' }])
      .mockResolvedValueOnce([{ id: 'after', title: 'After', createdAt: '', updatedAt: '' }])
    const forkCodexThread = vi.fn().mockResolvedValue({
      id: 'after',
      title: 'After',
      createdAt: '',
      updatedAt: '',
    })
    ;(globalThis as unknown as {
      window: { electronAPI: { agent: { listCodexThreads: typeof listCodexThreads; forkCodexThread: typeof forkCodexThread } } }
    }).window = {
      electronAPI: { agent: { listCodexThreads, forkCodexThread } },
    }
    const { useAgentChatStore } = await import('../store')

    await useAgentChatStore.getState().refreshCodexThreadList()
    await useAgentChatStore.getState().forkCodexThread('before')

    expect(forkCodexThread).toHaveBeenCalledWith('before')
    expect(listCodexThreads).toHaveBeenCalledTimes(2)
    expect(useAgentChatStore.getState().codexThreadList.map((thread) => thread.id)).toEqual(['after'])
  })

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
