import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeAgentApi = {
  listThreads: vi.fn(),
  openThread: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  loadThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  onToolRequest: vi.fn(() => () => undefined),
  sendToolResponse: vi.fn(),
  setApiKey: vi.fn(),
  testConnection: vi.fn(),
}

beforeEach(async () => {
  vi.resetModules()
  ;(globalThis as unknown as { window: { electronAPI: { agent: typeof fakeAgentApi } } }).window = {
    electronAPI: { agent: fakeAgentApi },
  }
  fakeAgentApi.listThreads.mockReset()
  fakeAgentApi.openThread.mockReset()
  globalThis.localStorage?.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('bootstrap()', () => {
  it('lists threads, switches to the most recent one, and stores the list', async () => {
    fakeAgentApi.listThreads.mockResolvedValue([
      { id: 'recent', title: 'Recent', createdAt: '', updatedAt: '', lastMessageAt: '2026-05-07T10:00:00Z' },
      { id: 'older', title: 'Older', createdAt: '', updatedAt: '', lastMessageAt: '2026-05-01T10:00:00Z' },
    ])
    fakeAgentApi.openThread.mockResolvedValue({ id: 'recent', messages: [] })

    const { useAgentChatStore } = await import('../store')
    await useAgentChatStore.getState().bootstrap()

    expect(fakeAgentApi.listThreads).toHaveBeenCalledTimes(1)
    expect(fakeAgentApi.openThread).toHaveBeenCalledWith('recent')
    expect(useAgentChatStore.getState().threadList.map((t) => t.id)).toEqual(['recent', 'older'])
    expect(useAgentChatStore.getState().threadId).toBe('recent')
  })

  it('does nothing destructive when there are no threads', async () => {
    fakeAgentApi.listThreads.mockResolvedValue([])
    const { useAgentChatStore } = await import('../store')
    await useAgentChatStore.getState().bootstrap()
    expect(fakeAgentApi.openThread).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().threadId).toBeUndefined()
    expect(useAgentChatStore.getState().threadList).toEqual([])
  })

  it('is a no-op on second call (already bootstrapped)', async () => {
    fakeAgentApi.listThreads.mockResolvedValue([
      { id: 't1', title: 'T1', createdAt: '', updatedAt: '', lastMessageAt: '2026-05-07T10:00:00Z' },
    ])
    fakeAgentApi.openThread.mockResolvedValue({ id: 't1', messages: [] })
    const { useAgentChatStore } = await import('../store')
    await useAgentChatStore.getState().bootstrap()
    await useAgentChatStore.getState().bootstrap()
    expect(fakeAgentApi.listThreads).toHaveBeenCalledTimes(1)
  })
})
