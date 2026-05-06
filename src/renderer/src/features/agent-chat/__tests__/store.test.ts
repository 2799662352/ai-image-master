import { describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'

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
