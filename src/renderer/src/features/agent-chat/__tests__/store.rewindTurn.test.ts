// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import type { Message } from '../../../../../types/agent-timeline'

const mockSendMessage = vi.fn().mockResolvedValue({ threadId: 'thread-1' })
const mockCancel = vi.fn().mockResolvedValue({})

beforeEach(() => {
  mockSendMessage.mockClear()
  mockCancel.mockClear()
  ;(window as any).electronAPI = {
    agent: {
      sendMessage: mockSendMessage,
      cancel: mockCancel,
      onEvent: () => () => {},
    },
  }
})

// Build a typical thread:
//   msg-0  user      "first question"
//   msg-1  assistant
//   msg-2  assistant   (e.g. tool-call follow-up — same turn)
//   msg-3  user      "second question"
//   msg-4  assistant
function buildMixedThread(): Message[] {
  const t = Date.now()
  return [
    {
      id: 'msg-0',
      role: 'user',
      createdAt: t,
      items: [{ type: 'text', id: 't0', startedAt: t, content: 'first question' }],
    },
    {
      id: 'msg-1',
      role: 'assistant',
      createdAt: t,
      items: [{ type: 'text', id: 't1', startedAt: t, content: 'first answer A' }],
    },
    {
      id: 'msg-2',
      role: 'assistant',
      createdAt: t,
      items: [{ type: 'text', id: 't2', startedAt: t, content: 'first answer B' }],
    },
    {
      id: 'msg-3',
      role: 'user',
      createdAt: t,
      items: [{ type: 'text', id: 't3', startedAt: t, content: 'second question' }],
    },
    {
      id: 'msg-4',
      role: 'assistant',
      createdAt: t,
      items: [{ type: 'text', id: 't4', startedAt: t, content: 'second answer' }],
    },
  ]
}

function resetStore(messages: Message[]): void {
  useAgentChatStore.setState({
    threadId: 'thread-1',
    messages,
    isRunning: false,
    error: undefined,
    input: '',
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
    selectedModelId: 'gpt-4.1-mini',
    editingMessageId: undefined,
    draftBackup: undefined,
    rewoundTurns: [],
  })
}

describe('rewindMessageTurn', () => {
  beforeEach(() => resetStore(buildMixedThread()))

  it('stashes the user message + every assistant message in that turn', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-0')

    const s = useAgentChatStore.getState()
    // msg-0/1/2 leave; msg-3/4 stay.
    expect(s.messages.map((m) => m.id)).toEqual(['msg-3', 'msg-4'])
    expect(s.rewoundTurns).toHaveLength(1)
    expect(s.rewoundTurns[0].messages.map((m) => m.id)).toEqual(['msg-0', 'msg-1', 'msg-2'])
    expect(s.rewoundTurns[0].originalIndex).toBe(0)
    expect(s.rewoundTurns[0].preview).toContain('first question')
  })

  it('rewinds the trailing turn (no following user message) cleanly', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-3')

    const s = useAgentChatStore.getState()
    expect(s.messages.map((m) => m.id)).toEqual(['msg-0', 'msg-1', 'msg-2'])
    expect(s.rewoundTurns[0].messages.map((m) => m.id)).toEqual(['msg-3', 'msg-4'])
  })

  it('refuses to rewind when target is missing or not a user message', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-1') // assistant
    useAgentChatStore.getState().rewindMessageTurn('does-not-exist')

    const s = useAgentChatStore.getState()
    expect(s.messages).toHaveLength(5)
    expect(s.rewoundTurns).toHaveLength(0)
  })

  it('newest rewound turn is at the front of the queue', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-0')
    // msg-3 used to be at index 3, now it lives at index 0 — the next
    // call still finds it because we look up by id, not by index.
    useAgentChatStore.getState().rewindMessageTurn('msg-3')

    const ids = useAgentChatStore.getState().rewoundTurns.map((t) => t.messages[0].id)
    expect(ids).toEqual(['msg-3', 'msg-0'])
  })

  it('drops edit state if the message being edited is inside the rewound slice', () => {
    useAgentChatStore.setState({ editingMessageId: 'msg-0', draftBackup: undefined })
    useAgentChatStore.getState().rewindMessageTurn('msg-0')

    expect(useAgentChatStore.getState().editingMessageId).toBeUndefined()
  })
})

describe('restoreRewoundTurn', () => {
  beforeEach(() => resetStore(buildMixedThread()))

  it('splices the stashed turn back at its original index', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-0')
    const turnId = useAgentChatStore.getState().rewoundTurns[0].id

    useAgentChatStore.getState().restoreRewoundTurn(turnId)

    const s = useAgentChatStore.getState()
    expect(s.messages.map((m) => m.id)).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4'])
    expect(s.rewoundTurns).toHaveLength(0)
  })

  it('clamps to current length if the timeline shrank in the meantime', () => {
    // Rewind two turns, then restore the second one — its originalIndex
    // (3) is now beyond the current timeline length (0 messages left).
    useAgentChatStore.getState().rewindMessageTurn('msg-0')
    useAgentChatStore.getState().rewindMessageTurn('msg-3')
    const trailingId = useAgentChatStore
      .getState()
      .rewoundTurns.find((t) => t.messages[0].id === 'msg-3')!.id

    useAgentChatStore.getState().restoreRewoundTurn(trailingId)

    const s = useAgentChatStore.getState()
    expect(s.messages.map((m) => m.id)).toEqual(['msg-3', 'msg-4'])
    expect(s.rewoundTurns).toHaveLength(1)
  })

  it('is a no-op for an unknown turn id', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-0')
    useAgentChatStore.getState().restoreRewoundTurn('not-a-real-id')

    const s = useAgentChatStore.getState()
    expect(s.rewoundTurns).toHaveLength(1)
    expect(s.messages.map((m) => m.id)).toEqual(['msg-3', 'msg-4'])
  })
})

describe('clearRewoundTurns', () => {
  beforeEach(() => resetStore(buildMixedThread()))

  it('drops every stashed turn permanently', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-0')
    useAgentChatStore.getState().rewindMessageTurn('msg-3')

    useAgentChatStore.getState().clearRewoundTurns()

    const s = useAgentChatStore.getState()
    expect(s.rewoundTurns).toHaveLength(0)
    // Active timeline must be unaffected.
    expect(s.messages).toHaveLength(0)
  })
})

describe('restoreAllRewoundTurns', () => {
  beforeEach(() => resetStore(buildMixedThread()))

  it('rebuilds the original timeline regardless of rewind order', () => {
    useAgentChatStore.getState().rewindMessageTurn('msg-3')
    useAgentChatStore.getState().rewindMessageTurn('msg-0')

    useAgentChatStore.getState().restoreAllRewoundTurns()

    const s = useAgentChatStore.getState()
    expect(s.messages.map((m) => m.id)).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4'])
    expect(s.rewoundTurns).toHaveLength(0)
  })

  it('is a no-op when the queue is empty', () => {
    useAgentChatStore.getState().restoreAllRewoundTurns()
    const s = useAgentChatStore.getState()
    expect(s.messages).toHaveLength(5)
    expect(s.rewoundTurns).toHaveLength(0)
  })
})

describe('newThread', () => {
  it('clears the rewound turns drawer along with the rest of the thread', () => {
    resetStore(buildMixedThread())
    useAgentChatStore.getState().rewindMessageTurn('msg-0')
    useAgentChatStore.setState({ editingMessageId: 'msg-3' })

    useAgentChatStore.getState().newThread()

    const s = useAgentChatStore.getState()
    expect(s.messages).toHaveLength(0)
    expect(s.rewoundTurns).toHaveLength(0)
    expect(s.editingMessageId).toBeUndefined()
  })
})
