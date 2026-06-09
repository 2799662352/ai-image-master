// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'

const sendMessage = vi.fn()
const listThreads = vi.fn()

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ threadId: 'new-thread-1' })
  listThreads.mockReset().mockResolvedValue([
    { id: 'new-thread-1', title: 'New chat', createdAt: '', updatedAt: '', lastMessageAt: new Date().toISOString() },
  ])
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { sendMessage, listThreads, onEvent: () => () => undefined },
  }
  useAgentChatStore.setState({
    threadId: undefined,
    messages: [],
    isRunning: false,
    input: 'hello',
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
    selectedModelId: 'gpt-5.5',
    threadSlices: {},
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
  })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('send() refreshes the sidebar immediately for a new chat', () => {
  it('calls listThreads right after the new thread is created (no waiting for turn_completed)', async () => {
    await useAgentChatStore.getState().send()

    // The thread list was refreshed as part of send — not deferred to the
    // turn-completion title-refresh schedule.
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(listThreads).toHaveBeenCalled()
    expect(useAgentChatStore.getState().threadId).toBe('new-thread-1')
  })

  it('does NOT refresh for an existing thread send (avoids extra churn)', async () => {
    useAgentChatStore.setState({ threadId: 'existing-1' })
    sendMessage.mockResolvedValue({ threadId: 'existing-1' })

    await useAgentChatStore.getState().send()

    expect(listThreads).not.toHaveBeenCalled()
  })
})
