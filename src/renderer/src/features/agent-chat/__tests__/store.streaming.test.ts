import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStreamEvent } from '../../../../../types/agent'
import type { TextItem } from '../../../../../types/agent-timeline'
import { useAgentChatStore } from '../store'

function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

function currentTextItem(): TextItem {
  const messages = useAgentChatStore.getState().messages
  expect(messages).toHaveLength(1)
  expect(messages[0].role).toBe('assistant')
  expect(messages[0].items).toHaveLength(1)

  const item = messages[0].items[0]
  expect(item.type).toBe('text')
  return item as TextItem
}

describe('agent chat store streaming text', () => {
  beforeEach(() => {
    // The active view is thread-1 (matching the streamed events' threadId).
    // Per-thread routing requires the active threadId to match for events to
    // land in the visible `messages` (foreign-thread events go to background).
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: [],
      isRunning: false,
      error: undefined,
      tokenUsage: undefined,
      pendingApprovals: [],
      threadSlices: {},
      runningByThread: {},
    })
  })

  it('renders consecutive text deltas immediately on the same item', () => {
    applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'Hel' },
    })

    expect(currentTextItem().content).toBe('Hel')

    applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'lo' },
    })

    expect(currentTextItem().content).toBe('Hello')
  })

  it('keeps streamed text when completion has no final text fields', () => {
    applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'streamed' },
    })

    const streamedItem = currentTextItem()
    expect(streamedItem.content).toBe('streamed')

    applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      final: {},
    })

    const completedItem = currentTextItem()
    expect(completedItem.id).toBe(streamedItem.id)
    expect(completedItem.content).toBe('streamed')
    expect(completedItem.endedAt).toEqual(expect.any(Number))
  })

  it('keeps streamed text when completion has an empty final content field', () => {
    applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'streamed' },
    })

    applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      final: { content: '' },
    })

    expect(currentTextItem().content).toBe('streamed')
  })

  it('creates text from completion final content without a prior delta', () => {
    applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      final: { content: 'completed text' },
    })

    const completedItem = currentTextItem()
    expect(completedItem.content).toBe('completed text')
    expect(completedItem.endedAt).toEqual(expect.any(Number))
  })

  it('normalizes completion final text when content is absent', () => {
    applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'text-1',
      itemType: 'text',
      final: { text: 'completed text' },
    })

    expect(currentTextItem().content).toBe('completed text')
  })
})
