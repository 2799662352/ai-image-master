import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStreamEvent } from '../../../../types/agent'
import { useAgentChatStore } from '../store'

function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

function steerFallbackNotice(threadId: string): AgentStreamEvent {
  return {
    type: 'notice',
    notice: {
      id: `steer-fallback:${threadId}`,
      kind: 'steerFallback',
      level: 'info',
      threadId,
      message: '上一回合刚好已结束,插话已作为新一轮消息发送。',
    },
  }
}

beforeEach(() => {
  useAgentChatStore.setState({
    threadId: undefined,
    messages: [],
    isRunning: false,
    error: undefined,
    tokenUsage: undefined,
    notices: [],
    threadSlices: {},
    runningByThread: {},
  })
})

describe('agent chat store — steerFallback notice re-arms the running state', () => {
  // The main process converts a lost turn/steer race into a FRESH turn
  // (AgentManager.steer fallback). The renderer's isRunning went false at the
  // original turn_completed, so without this the fallback turn streams with no
  // stop button and no sidebar dot.
  it('marks the active thread running again when its steerFallback notice arrives', () => {
    useAgentChatStore.setState({ threadId: 'A' })

    applyEvent(steerFallbackNotice('A'))

    const state = useAgentChatStore.getState()
    expect(state.isRunning).toBe(true)
    expect(state.runningByThread.A).toBe(true)
    // The notice itself still lands in the banner stack.
    expect(state.notices.some((n) => n.kind === 'steerFallback')).toBe(true)
  })

  it('marks a background thread running (sidebar dot) without touching the active view', () => {
    useAgentChatStore.setState({ threadId: 'A' })

    applyEvent(steerFallbackNotice('B'))

    const state = useAgentChatStore.getState()
    expect(state.isRunning).toBe(false) // active view (A) untouched
    expect(state.runningByThread.B).toBe(true)
  })

  it('leaves running flags alone for other notice kinds', () => {
    useAgentChatStore.setState({ threadId: 'A' })

    applyEvent({
      type: 'notice',
      notice: {
        id: 'cfg-1',
        kind: 'configWarning',
        level: 'info',
        threadId: 'A',
        message: 'some config note',
      },
    })

    const state = useAgentChatStore.getState()
    expect(state.isRunning).toBe(false)
    expect(state.runningByThread.A).toBeUndefined()
  })
})
