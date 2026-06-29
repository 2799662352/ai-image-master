import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'
import type { ArtifactItem, AttachmentRef } from '../../../../../types/agent-timeline'

function ref(id: string): AttachmentRef {
  return { id, kind: 'image', name: `${id}.png`, mime: 'image/png', size: 1, uri: `data:image/png;base64,${id}` }
}

function lastArtifact(): ArtifactItem {
  const { messages } = useAgentChatStore.getState()
  return messages[messages.length - 1].items[0] as ArtifactItem
}

beforeEach(() => {
  useAgentChatStore.setState({ messages: [] })
})

describe('image-generation status machine', () => {
  it('beginImageGeneration appends a generating assistant bubble and returns its id', () => {
    const id = useAgentChatStore.getState().beginImageGeneration('a neon cat')
    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    const item = lastArtifact()
    expect(item.id).toBe(id)
    expect(item.status).toBe('generating')
    expect(item.prompt).toBe('a neon cat')
    expect(item.artifacts).toHaveLength(0)
  })

  it('resolveImageGeneration settles the SAME bubble in place (no extra message)', () => {
    const id = useAgentChatStore.getState().beginImageGeneration('a cat')
    useAgentChatStore.getState().resolveImageGeneration(id, [ref('a'), ref('b')])

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    const item = lastArtifact()
    expect(item.status).toBe('done')
    expect(item.artifacts.map((a) => a.id)).toEqual(['a', 'b'])
    expect(item.endedAt).toBeTypeOf('number')
  })

  it('failImageGeneration marks the bubble error with a message', () => {
    const id = useAgentChatStore.getState().beginImageGeneration('a cat')
    useAgentChatStore.getState().failImageGeneration(id, 'rate limit')

    const item = lastArtifact()
    expect(item.status).toBe('error')
    expect(item.error).toBe('rate limit')
  })

  it('resolve/fail on an unknown id are no-ops (no crash, no new message)', () => {
    useAgentChatStore.getState().beginImageGeneration('a cat')
    const before = useAgentChatStore.getState().messages
    useAgentChatStore.getState().resolveImageGeneration('nope', [ref('a')])
    useAgentChatStore.getState().failImageGeneration('nope', 'x')
    // Same array reference back when nothing matched.
    expect(useAgentChatStore.getState().messages).toBe(before)
  })

  it('replaceImageArtifacts swaps the bubble artifacts in place, keeping status/save', () => {
    const id = useAgentChatStore.getState().beginImageGeneration('a cat')
    useAgentChatStore.getState().resolveImageGeneration(id, [ref('a')])
    useAgentChatStore.getState().annotateImageGeneration(id, { status: 'saved', dir: 'D:\\imgs' })

    const light: AttachmentRef = {
      id: 'a',
      kind: 'image',
      name: 'a.png',
      mime: 'image/png',
      size: 0,
      uri: 'D:\\imgs\\a.png',
    }
    useAgentChatStore.getState().replaceImageArtifacts(id, [light])

    const item = lastArtifact()
    expect(item.status).toBe('done')
    expect(item.save).toEqual({ status: 'saved', dir: 'D:\\imgs' })
    // base64 dropped — artifact now points at the local path, not a data: URL.
    expect(item.artifacts).toHaveLength(1)
    expect(item.artifacts[0].uri).toBe('D:\\imgs\\a.png')
    expect(item.artifacts[0].uri.startsWith('data:')).toBe(false)
  })

  it('replaceImageArtifacts on an unknown id is a no-op (same array reference)', () => {
    useAgentChatStore.getState().beginImageGeneration('a cat')
    const before = useAgentChatStore.getState().messages
    useAgentChatStore.getState().replaceImageArtifacts('nope', [ref('a')])
    expect(useAgentChatStore.getState().messages).toBe(before)
  })
})
