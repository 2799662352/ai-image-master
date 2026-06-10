import { describe, expect, it } from 'vitest'
import { applyAssistantEvent } from '../AgentManager'
import type { TimelineItem } from '../../../types/agent-timeline'
import type { AgentStreamEvent } from '../../../types/agent'

/**
 * Guards the main-process persistence accumulator against the stream-retry
 * duplication bug: codex retries a failed model request (error notification
 * with willRetry:true) by re-streaming the whole response under NEW item
 * ids. Without trimming, every retry appended another copy of the same
 * paragraph and the duplicated transcript was persisted at turn_completed.
 */
function streamText(items: TimelineItem[], itemId: string, text: string): TimelineItem[] {
  let next = applyAssistantEvent(items, {
    type: 'item_started',
    threadId: 't',
    itemId,
    itemType: 'text',
    payload: {},
  } as AgentStreamEvent)
  next = applyAssistantEvent(next, {
    type: 'item_delta',
    threadId: 't',
    itemId,
    itemType: 'text',
    patch: { kind: 'appendText', field: 'content', text },
  } as AgentStreamEvent)
  return next
}

describe('applyAssistantEvent stream retry', () => {
  it('drops the failed attempt trailing text/reasoning on willRetry errors', () => {
    let items: TimelineItem[] = []
    items = applyAssistantEvent(items, {
      type: 'item_started',
      threadId: 't',
      itemId: 'reason-a',
      itemType: 'reasoning',
      payload: {},
    } as AgentStreamEvent)
    items = streamText(items, 'text-a', '我已按技能里的原则…(partial)')

    items = applyAssistantEvent(items, {
      type: 'error',
      threadId: 't',
      error: 'stream disconnected before completion',
      willRetry: true,
    } as AgentStreamEvent)

    // Retry re-streams with new ids.
    items = streamText(items, 'text-b', '我已按技能里的原则把重点收束成三个方向。')

    const texts = items.filter((i) => i.type === 'text')
    expect(texts).toHaveLength(1)
    expect((texts[0] as { content: string }).content).toBe('我已按技能里的原则把重点收束成三个方向。')
    expect(items.some((i) => i.type === 'reasoning')).toBe(false)
  })

  it('preserves completed tool items before the trailing run', () => {
    let items: TimelineItem[] = []
    items = applyAssistantEvent(items, {
      type: 'item_started',
      threadId: 't',
      itemId: 'shell-1',
      itemType: 'shell',
      payload: { command: 'ls' },
    } as AgentStreamEvent)
    items = applyAssistantEvent(items, {
      type: 'item_completed',
      threadId: 't',
      itemId: 'shell-1',
      itemType: 'shell',
      final: { exitCode: 0 },
    } as AgentStreamEvent)
    items = streamText(items, 'text-a', 'partial')

    items = applyAssistantEvent(items, {
      type: 'error',
      threadId: 't',
      error: 'stream error',
      willRetry: true,
    } as AgentStreamEvent)

    expect(items.map((i) => i.type)).toEqual(['shell'])
  })

  it('keeps items untouched on terminal errors (willRetry false)', () => {
    let items: TimelineItem[] = []
    items = streamText(items, 'text-a', 'partial')
    const next = applyAssistantEvent(items, {
      type: 'error',
      threadId: 't',
      error: 'fatal',
      willRetry: false,
    } as AgentStreamEvent)
    expect(next).toBe(items)
  })
})
