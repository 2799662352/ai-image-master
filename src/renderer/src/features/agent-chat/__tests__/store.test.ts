// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import { DEFAULT_MODEL_ID } from '../models'

describe('useAgentChatStore', () => {
  it('appends assistant deltas', () => {
    useAgentChatStore.setState({ threadId: undefined, messages: [], reasoning: '', toolEvents: [], isRunning: true })
    useAgentChatStore.getState().applyEvent({ type: 'message_delta', threadId: 't1', delta: 'hello' })
    useAgentChatStore.getState().applyEvent({ type: 'message_delta', threadId: 't1', delta: ' world' })
    expect(useAgentChatStore.getState().messages[0].content).toBe('hello world')
  })

  it('ignores events from stale threads', () => {
    useAgentChatStore.setState({ threadId: 'active', messages: [], reasoning: '', toolEvents: [], isRunning: true })
    useAgentChatStore.getState().applyEvent({ type: 'message_delta', threadId: 'stale', delta: 'old' })
    expect(useAgentChatStore.getState().messages).toEqual([])
  })
})

describe('useAgentChatStore selected model', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('exposes a default model id', () => {
    expect(useAgentChatStore.getState().selectedModelId).toBe(DEFAULT_MODEL_ID)
  })

  it('persists setSelectedModel to localStorage', () => {
    useAgentChatStore.getState().setSelectedModel('o3-pro')
    expect(useAgentChatStore.getState().selectedModelId).toBe('o3-pro')
    expect(localStorage.getItem('catimation.agent.selectedModel')).toBe('o3-pro')
  })

  it('forwards selectedModelId via send → electronAPI.agent.sendMessage', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'tx' })
    ;(window as any).electronAPI = {
      agent: {
        sendMessage,
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    }
    useAgentChatStore.setState({
      threadId: undefined,
      input: 'hello',
      attachments: [],
      messages: [],
      isRunning: false,
      selectedModelId: 'gpt-4o',
    })

    await useAgentChatStore.getState().send()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      content: 'hello',
      model: 'gpt-4o',
    })
  })
})
