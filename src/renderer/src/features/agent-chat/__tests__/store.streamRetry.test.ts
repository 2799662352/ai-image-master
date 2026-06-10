import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStreamEvent } from '../../../../../types/agent'
import { useAgentChatStore } from '../store'

/**
 * Codex stream-retry semantics (upstream openai/codex PR #7611 +
 * bespoke_event_handling.rs):
 *
 *   - `EventMsg::StreamError` → `error` notification with `willRetry: true`.
 *     The backend retries the SAME model request; the retry re-streams the
 *     whole response with NEW item ids.
 *   - terminal errors → `willRetry: false` (or absent).
 *
 * Bug being guarded against ("对话重复"): each retry appended a brand-new
 * text/reasoning item next to the failed attempt's partial output, so the
 * same paragraph stacked up once per retry in a single assistant bubble.
 */
function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

function streamText(itemId: string, text: string): void {
  applyEvent({
    type: 'item_started',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId,
    itemType: 'text',
    payload: {},
  })
  applyEvent({
    type: 'item_delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId,
    itemType: 'text',
    patch: { kind: 'appendText', field: 'content', text },
  })
}

function streamReasoning(itemId: string, text: string): void {
  applyEvent({
    type: 'item_started',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId,
    itemType: 'reasoning',
    payload: {},
  })
  applyEvent({
    type: 'item_delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId,
    itemType: 'reasoning',
    patch: { kind: 'appendText', field: 'content', text },
  })
}

beforeEach(() => {
  useAgentChatStore.setState({
    threadId: 'thread-1',
    messages: [],
    isRunning: true,
    error: undefined,
    tokenUsage: undefined,
    pendingApprovals: [],
    notices: [],
    threadSlices: {},
    runningByThread: { 'thread-1': true },
  })
})

describe('agent chat store stream retry (willRetry)', () => {
  it('drops the failed attempt partial text+reasoning so the retry replaces instead of duplicating', () => {
    // Attempt 1: reasoning + partial answer, then the stream breaks.
    streamReasoning('reason-a', '想法 A')
    streamText('text-a', '我已按技能里的原则把重点收束成三个方向：首')

    applyEvent({
      type: 'error',
      threadId: 'thread-1',
      error: 'stream disconnected before completion',
      willRetry: true,
    })

    // Attempt 2 (retry): new item ids, full re-stream.
    streamReasoning('reason-b', '想法 B')
    streamText('text-b', '我已按技能里的原则把重点收束成三个方向：首帧参考只负责场景。')
    applyEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1' })

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    const texts = messages[0].items.filter((i) => i.type === 'text')
    const reasonings = messages[0].items.filter((i) => i.type === 'reasoning')
    expect(texts).toHaveLength(1)
    expect(reasonings).toHaveLength(1)
    expect((texts[0] as { content: string }).content).toBe(
      '我已按技能里的原则把重点收束成三个方向：首帧参考只负责场景。',
    )
  })

  it('keeps isRunning true and no terminal error while retrying', () => {
    streamText('text-a', 'partial')
    applyEvent({ type: 'error', threadId: 'thread-1', error: 'stream error', willRetry: true })

    const s = useAgentChatStore.getState()
    expect(s.isRunning).toBe(true)
    expect(s.error).toBeUndefined()
    expect(s.runningByThread['thread-1']).toBe(true)
  })

  it('preserves completed tool items before the failed trailing text/reasoning run', () => {
    // Tool call from an earlier model request inside the same turn — it
    // actually executed and must NOT be dropped by a later stream retry.
    applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'shell-1',
      itemType: 'shell',
      payload: { command: 'ls' },
    })
    applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'shell-1',
      itemType: 'shell',
      final: { exitCode: 0 },
    })
    streamText('text-a', 'partial answer')

    applyEvent({ type: 'error', threadId: 'thread-1', error: 'stream error', willRetry: true })

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    const types = messages[0].items.map((i) => i.type)
    expect(types).toEqual(['shell'])
  })

  it('still treats willRetry:false (terminal) errors as before', () => {
    streamText('text-a', 'partial')
    applyEvent({ type: 'error', threadId: 'thread-1', error: 'fatal', willRetry: false })

    const s = useAgentChatStore.getState()
    expect(s.isRunning).toBe(false)
    expect(s.error).toBe('fatal')
    // Terminal error keeps the partial output visible (user can see how far it got).
    expect(s.messages[0].items.some((i) => i.type === 'text')).toBe(true)
  })

  it('applies the same retry trimming to background thread slices', () => {
    useAgentChatStore.setState({ threadId: 'active-thread' })
    const bg = 'thread-1'

    streamText('text-a', 'partial')
    applyEvent({ type: 'error', threadId: bg, error: 'stream error', willRetry: true })
    streamText('text-b', 'full answer')
    applyEvent({ type: 'turn_completed', threadId: bg, turnId: 'turn-1' })

    const slice = useAgentChatStore.getState().threadSlices[bg]
    expect(slice).toBeDefined()
    const texts = slice.messages[0].items.filter((i) => i.type === 'text')
    expect(texts).toHaveLength(1)
    expect((texts[0] as { content: string }).content).toBe('full answer')
  })
})
