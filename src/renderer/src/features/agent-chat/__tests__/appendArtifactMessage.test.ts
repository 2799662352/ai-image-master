import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'
import type { ArtifactItem, AttachmentRef, Message } from '../../../../../types/agent-timeline'

function ref(id: string): AttachmentRef {
  return { id, kind: 'image', name: `${id}.png`, mime: 'image/png', size: 1, uri: `data:image/png;base64,${id}` }
}

beforeEach(() => {
  useAgentChatStore.setState({ messages: [] })
})

describe('appendArtifactMessage', () => {
  it('pushes a new assistant message holding one ArtifactItem', () => {
    useAgentChatStore.getState().appendArtifactMessage([ref('a'), ref('b')])
    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.role).toBe('assistant')
    expect(msg.items).toHaveLength(1)
    const item = msg.items[0] as ArtifactItem
    expect(item.type).toBe('artifact')
    expect(item.artifacts.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('does not mutate existing messages (appends as a separate bubble)', () => {
    const existing: Message = {
      id: 'prev',
      role: 'assistant',
      createdAt: 1,
      items: [{ type: 'text', id: 't1', startedAt: 1, content: 'hi' }],
    }
    useAgentChatStore.setState({ messages: [existing] })

    useAgentChatStore.getState().appendArtifactMessage([ref('x')])
    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(2)
    expect(messages[0]).toBe(existing)
    expect((messages[1].items[0] as ArtifactItem).type).toBe('artifact')
  })

  it('is a no-op for an empty artifact list', () => {
    useAgentChatStore.getState().appendArtifactMessage([])
    expect(useAgentChatStore.getState().messages).toHaveLength(0)
  })
})
