import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStreamEvent } from '../../../../../types/agent'
import { useAgentChatStore } from '../store'

/**
 * Regression for the LIVE "对话重复" reproduced on 2026-06-10 (v4.3.30, apiyi
 * gateway, msg cmq7z96v60002ccn7zpsf7chw): the gateway streamed the assistant
 * reply as cumulative SNAPSHOTS — every SSE chunk arrived as a brand-new
 * `agentMessage` item (fresh `msg_*` id) whose content was the FULL text so
 * far, preceded by a fresh EMPTY `reasoning` item (fresh `rs_*` id). 130
 * pairs stacked into one bubble. NO error/willRetry events fired, so the
 * v4.3.29 stream-retry trim never engaged.
 */
function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

function snapshotPair(n: number, cumulativeText: string): void {
  // empty reasoning item, instantly completed
  applyEvent({
    type: 'item_started',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: `rs-${n}`,
    itemType: 'reasoning',
    payload: {},
  })
  applyEvent({
    type: 'item_completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: `rs-${n}`,
    itemType: 'reasoning',
    final: {},
  })
  // new text item carrying the FULL accumulated text in a single delta
  applyEvent({
    type: 'item_started',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: `msg-${n}`,
    itemType: 'text',
    payload: {},
  })
  applyEvent({
    type: 'item_delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: `msg-${n}`,
    itemType: 'text',
    patch: { kind: 'appendText', field: 'content', text: cumulativeText },
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

describe('agent chat store cumulative-snapshot dedup', () => {
  it('collapses per-chunk snapshot items into a single growing paragraph', () => {
    const base = '我按原文的温柔、克制语气扩写了一版，保留雨夜、母亲、小猫的核心意象，把情绪铺得更满。'
    for (let n = 0; n < 8; n++) {
      snapshotPair(n, base.slice(0, 12 + n * 8))
    }
    applyEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1' })

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    const texts = messages[0].items.filter((i) => i.type === 'text')
    const reasonings = messages[0].items.filter((i) => i.type === 'reasoning')
    expect(texts).toHaveLength(1)
    expect((texts[0] as { content: string }).content).toBe(base.slice(0, 12 + 7 * 8))
    expect(reasonings.length).toBeLessThanOrEqual(1)
  })

  it('keeps tool items executed between snapshots', () => {
    snapshotPair(0, '我先读取你给的文本，确认原文')
    applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'shell-1',
      itemType: 'shell',
      payload: { command: 'cat 夜雨里的灯.txt' },
    })
    applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'shell-1',
      itemType: 'shell',
      final: { exitCode: 0 },
    })
    snapshotPair(1, '我先读取你给的文本，确认原文的叙事和语气，再扩写。')

    const { messages } = useAgentChatStore.getState()
    const types = messages[0].items.map((i) => i.type)
    expect(types).toContain('shell')
    expect(messages[0].items.filter((i) => i.type === 'text')).toHaveLength(1)
  })

  it('does not merge genuinely distinct paragraphs streamed as separate items', () => {
    snapshotPair(0, '第一段：这是独立的分析内容。')
    snapshotPair(1, '第二段：这是完全不同的结论。')

    const { messages } = useAgentChatStore.getState()
    const texts = messages[0].items.filter((i) => i.type === 'text')
    expect(texts).toHaveLength(2)
  })
})
