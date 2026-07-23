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

function makeMsgs(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    createdAt: Date.now(),
    items: [{ type: 'text' as const, id: `txt-${i}`, startedAt: Date.now(), content: `content-${i}` }],
  }))
}

describe('startEditMessage', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: makeMsgs(5),
      isRunning: false,
      error: undefined,
      input: 'in-flight draft',
      attachments: [],
      pendingReferences: [],
      availableSkills: [],
      selectedModelId: 'gpt-4.1-mini',
      editingMessageId: undefined,
      draftBackup: undefined,
    })
  })

  it('seeds input with the message text and sets editingMessageId', () => {
    useAgentChatStore.getState().startEditMessage('msg-0')
    const s = useAgentChatStore.getState()
    expect(s.editingMessageId).toBe('msg-0')
    expect(s.input).toBe('content-0')
  })

  it('rehydrates user message attachments when entering edit mode', () => {
    useAgentChatStore.setState({
      messages: [
        {
          id: 'msg-with-attachment',
          role: 'user',
          createdAt: Date.now(),
          items: [
            {
              type: 'attachment',
              id: 'att-item',
              startedAt: Date.now(),
              attachments: [
                {
                  id: 'img-1',
                  kind: 'image',
                  name: 'cat.png',
                  mime: 'image/png',
                  size: 123,
                  uri: 'local-file:///C:/Users/me/AppData/Roaming/app/agent/uploads/cat.png',
                },
                {
                  id: 'file-1',
                  kind: 'file',
                  name: 'notes.txt',
                  mime: 'text/plain',
                  size: 456,
                  uri: 'local-file:///C:/Users/me/AppData/Roaming/app/agent/uploads/notes.txt',
                },
              ],
            },
            { type: 'text', id: 'txt', startedAt: Date.now(), content: 'caption' },
          ],
        },
      ],
    })

    useAgentChatStore.getState().startEditMessage('msg-with-attachment')

    expect(useAgentChatStore.getState().input).toBe('caption')
    expect(useAgentChatStore.getState().attachments).toEqual([
      {
        name: 'cat.png',
        mime: 'image/png',
        size: 123,
        path: 'C:/Users/me/AppData/Roaming/app/agent/uploads/cat.png',
      },
      {
        name: 'notes.txt',
        mime: 'text/plain',
        size: 456,
        path: 'C:/Users/me/AppData/Roaming/app/agent/uploads/notes.txt',
      },
    ])
  })

  it('rehydrates audio attachment rows without exploding (Codex 0.145 localAudio flow)', () => {
    useAgentChatStore.setState({
      messages: [
        {
          id: 'msg-with-audio',
          role: 'user',
          createdAt: Date.now(),
          items: [
            {
              type: 'attachment',
              id: 'att-item',
              startedAt: Date.now(),
              attachments: [
                {
                  id: 'audio-1',
                  kind: 'audio',
                  name: 'voice.mp3',
                  mime: 'audio/mpeg',
                  size: 789,
                  uri: 'local-file:///C:/Users/me/AppData/Roaming/app/agent/uploads/voice.mp3',
                },
              ],
            },
            { type: 'text', id: 'txt', startedAt: Date.now(), content: '这段音频说了什么' },
          ],
        },
      ],
    })

    useAgentChatStore.getState().startEditMessage('msg-with-audio')

    expect(useAgentChatStore.getState().input).toBe('这段音频说了什么')
    const restored = useAgentChatStore.getState().attachments
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      name: 'voice.mp3',
      mime: 'audio/mpeg',
      size: 789,
      path: 'C:/Users/me/AppData/Roaming/app/agent/uploads/voice.mp3',
    })
  })

  it('restores chips from codexReconcile.localImages when the DB attachment item is missing (rollout-canonical fallback)', () => {
    useAgentChatStore.setState({
      messages: [
        {
          id: 'msg-reconcile-only',
          role: 'user',
          createdAt: Date.now(),
          items: [
            {
              type: 'text',
              id: 'txt',
              startedAt: Date.now(),
              content: 'caption',
              codexReconcile: {
                codexItemId: 'item-1',
                clientId: 'msg-reconcile-only',
                localImages: ['C:/Users/me/AppData/Roaming/app/agent/uploads/cat.png'],
                textElements: [],
              },
            },
          ],
        },
      ],
    })

    useAgentChatStore.getState().startEditMessage('msg-reconcile-only')

    expect(useAgentChatStore.getState().attachments).toEqual([
      {
        name: 'cat.png',
        mime: 'image/png',
        size: 0,
        path: 'C:/Users/me/AppData/Roaming/app/agent/uploads/cat.png',
      },
    ])
  })

  it('does not duplicate a reconcile path already covered by a DB attachment ref (DB metadata wins)', () => {
    useAgentChatStore.setState({
      messages: [
        {
          id: 'msg-both',
          role: 'user',
          createdAt: Date.now(),
          items: [
            {
              type: 'attachment',
              id: 'att-item',
              startedAt: Date.now(),
              codexReconcile: {
                codexItemId: 'item-1',
                clientId: 'msg-both',
                localImages: [
                  // Same file, different separators/case — must dedupe.
                  'c:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\CAT.png',
                  // Not in the DB rows — must be appended from reconcile.
                  'C:/Users/me/AppData/Roaming/app/agent/uploads/extra.jpg',
                ],
                textElements: [],
              },
              attachments: [
                {
                  id: 'img-1',
                  kind: 'image',
                  name: 'cat.png',
                  mime: 'image/png',
                  size: 123,
                  uri: 'local-file:///C:/Users/me/AppData/Roaming/app/agent/uploads/cat.png',
                },
                {
                  id: 'file-1',
                  kind: 'file',
                  name: 'notes.txt',
                  mime: 'text/plain',
                  size: 456,
                  uri: 'local-file:///C:/Users/me/AppData/Roaming/app/agent/uploads/notes.txt',
                },
              ],
            },
            { type: 'text', id: 'txt', startedAt: Date.now(), content: 'caption' },
          ],
        },
      ],
    })

    useAgentChatStore.getState().startEditMessage('msg-both')

    expect(useAgentChatStore.getState().attachments).toEqual([
      // DB rows keep their richer metadata (size), non-image files survive.
      {
        name: 'cat.png',
        mime: 'image/png',
        size: 123,
        path: 'C:/Users/me/AppData/Roaming/app/agent/uploads/cat.png',
      },
      {
        name: 'notes.txt',
        mime: 'text/plain',
        size: 456,
        path: 'C:/Users/me/AppData/Roaming/app/agent/uploads/notes.txt',
      },
      // Rollout-only path appended with inferred metadata.
      {
        name: 'extra.jpg',
        mime: 'image/jpeg',
        size: 0,
        path: 'C:/Users/me/AppData/Roaming/app/agent/uploads/extra.jpg',
      },
    ])
  })

  it('backs up the in-flight draft so cancel can restore it', () => {
    useAgentChatStore.getState().startEditMessage('msg-0')
    expect(useAgentChatStore.getState().draftBackup?.input).toBe('in-flight draft')
  })

  it('refuses to enter edit mode while running', () => {
    useAgentChatStore.setState({ isRunning: true })
    useAgentChatStore.getState().startEditMessage('msg-0')
    expect(useAgentChatStore.getState().editingMessageId).toBeUndefined()
  })

  it('refuses to edit assistant messages', () => {
    useAgentChatStore.getState().startEditMessage('msg-1') // assistant
    expect(useAgentChatStore.getState().editingMessageId).toBeUndefined()
  })

  it('is a no-op for unknown messageId', () => {
    useAgentChatStore.getState().startEditMessage('nope')
    expect(useAgentChatStore.getState().editingMessageId).toBeUndefined()
  })
})

describe('cancelEditMessage', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: makeMsgs(5),
      isRunning: false,
      input: 'in-flight draft',
      attachments: [],
      pendingReferences: [],
      availableSkills: [],
      selectedModelId: 'gpt-4.1-mini',
      editingMessageId: undefined,
      draftBackup: undefined,
    })
  })

  it('restores the saved draft', () => {
    useAgentChatStore.getState().startEditMessage('msg-0')
    useAgentChatStore.setState({ input: 'edited text in progress' })
    useAgentChatStore.getState().cancelEditMessage()

    const s = useAgentChatStore.getState()
    expect(s.editingMessageId).toBeUndefined()
    expect(s.draftBackup).toBeUndefined()
    expect(s.input).toBe('in-flight draft')
  })

  it('is a no-op when not editing', () => {
    useAgentChatStore.getState().cancelEditMessage()
    expect(useAgentChatStore.getState().input).toBe('in-flight draft')
  })
})

describe('submitEditMessage', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: makeMsgs(5),
      isRunning: false,
      input: '',
      attachments: [],
      pendingReferences: [],
      availableSkills: [],
      selectedModelId: 'gpt-4.1-mini',
      editingMessageId: undefined,
      draftBackup: undefined,
    })
  })

  it('truncates messages up to the edited one and resends current draft', async () => {
    useAgentChatStore.getState().startEditMessage('msg-2')
    useAgentChatStore.setState({ input: 'rewritten text' })

    await useAgentChatStore.getState().submitEditMessage()

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage.mock.calls[0][0].content).toBe('rewritten text')
    expect(useAgentChatStore.getState().editingMessageId).toBeUndefined()
  })

  it('preserves messages before the edited one', async () => {
    useAgentChatStore.getState().startEditMessage('msg-2')
    useAgentChatStore.setState({ input: 'rewritten' })
    await useAgentChatStore.getState().submitEditMessage()

    // After truncation we expect msg-0, msg-1 + the new user msg appended by send().
    const after = useAgentChatStore.getState().messages
    const ids = after.slice(0, 2).map((m) => m.id)
    expect(ids).toEqual(['msg-0', 'msg-1'])
  })

  it('refuses to submit while a turn is already running', async () => {
    useAgentChatStore.getState().startEditMessage('msg-0')
    useAgentChatStore.setState({ isRunning: true })
    await useAgentChatStore.getState().submitEditMessage()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('is a no-op when no message is being edited', async () => {
    await useAgentChatStore.getState().submitEditMessage()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })
})

describe('deleteMessage', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: makeMsgs(4),
      isRunning: false,
    })
  })

  it('removes the target message from the list', () => {
    const before = useAgentChatStore.getState().messages.length
    useAgentChatStore.getState().deleteMessage('msg-1')
    const after = useAgentChatStore.getState().messages
    expect(after.length).toBe(before - 1)
    expect(after.find((m) => m.id === 'msg-1')).toBeUndefined()
  })

  it('keeps other messages intact', () => {
    useAgentChatStore.getState().deleteMessage('msg-1')
    const after = useAgentChatStore.getState().messages
    expect(after.map((m) => m.id)).toEqual(['msg-0', 'msg-2', 'msg-3'])
  })

  it('is a no-op for nonexistent id', () => {
    const before = useAgentChatStore.getState().messages.length
    useAgentChatStore.getState().deleteMessage('nope')
    expect(useAgentChatStore.getState().messages.length).toBe(before)
  })
})
