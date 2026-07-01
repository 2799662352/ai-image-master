import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStreamEvent, AgentTokenUsage } from '../../../../../types/agent'
import { deriveContextWatermarkNotice, useAgentChatStore } from '../store'

/**
 * Tests for the proactive 70% context-window warning (see openai/codex#10823).
 *
 * Two layers exercised:
 *   1. `deriveContextWatermarkNotice` — pure helper, easy to assert thresholds.
 *   2. `applyEvent('token_usage_updated')` — integration with zustand state,
 *      verifies that the notice is actually pushed and deduped per thread.
 */

function makeUsage(overrides: Partial<AgentTokenUsage>): AgentTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides,
  } as AgentTokenUsage
}

function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

describe('deriveContextWatermarkNotice', () => {
  const threadId = 'thread-watermark'

  it('returns null when threadId is missing (cannot scope dedup)', () => {
    const usage = makeUsage({ contextUsage: 180_000, contextWindow: 200_000 })
    expect(
      deriveContextWatermarkNotice({ threadId: undefined, usage, seen: {} }),
    ).toBeNull()
  })

  it('returns null when contextWindow is missing or zero', () => {
    expect(
      deriveContextWatermarkNotice({
        threadId,
        usage: makeUsage({ contextUsage: 180_000 }),
        seen: {},
      }),
    ).toBeNull()
    expect(
      deriveContextWatermarkNotice({
        threadId,
        usage: makeUsage({ contextUsage: 180_000, contextWindow: 0 }),
        seen: {},
      }),
    ).toBeNull()
  })

  it('returns null just below the 70% threshold on the effective window', () => {
    // Codex effective window = 200_000 − 12_000 baseline = 188_000. 70% crossing
    // is at used = 0.7 × 188_000 + 12_000 = 143_600. 143_000 → ≈ 69.7% — below.
    const usage = makeUsage({ contextUsage: 143_000, contextWindow: 200_000 })
    expect(deriveContextWatermarkNotice({ threadId, usage, seen: {} })).toBeNull()
  })

  it('fires exactly at 70% (effective window) with a warning-level notice carrying details', () => {
    // used = 0.7 × (200_000 − 12_000) + 12_000 = 143_600 → exactly 70%.
    const usage = makeUsage({ contextUsage: 143_600, contextWindow: 200_000 })
    const notice = deriveContextWatermarkNotice({ threadId, usage, seen: {} })
    expect(notice).not.toBeNull()
    expect(notice!.kind).toBe('contextHighWatermark')
    expect(notice!.level).toBe('warning')
    expect(notice!.threadId).toBe(threadId)
    expect(notice!.id).toBe(`context-watermark:${threadId}:l1`)
    expect(notice!.message).toContain('70%')
    expect(notice!.details).toMatchObject({
      ratio: 0.7,
      used: 143_600,
      window: 200_000,
      watermark: 'l1',
    })
  })

  it('still fires near 90% (single-tier: never returns null above l1)', () => {
    // used = 0.9 × (200_000 − 12_000) + 12_000 = 181_200 → exactly 90%.
    const usage = makeUsage({ contextUsage: 181_200, contextWindow: 200_000 })
    const notice = deriveContextWatermarkNotice({ threadId, usage, seen: {} })
    expect(notice).not.toBeNull()
    expect(notice!.message).toContain('90%')
  })

  it('returns null when the l1 watermark for this thread is already marked seen', () => {
    const usage = makeUsage({ contextUsage: 180_000, contextWindow: 200_000 })
    const seen = { [`${threadId}:l1`]: true as const }
    expect(deriveContextWatermarkNotice({ threadId, usage, seen })).toBeNull()
  })

  it('uses inputTokens+outputTokens when contextUsage is absent', () => {
    const usage = makeUsage({
      inputTokens: 100_000,
      outputTokens: 50_000,
      contextWindow: 200_000,
    })
    const notice = deriveContextWatermarkNotice({ threadId, usage, seen: {} })
    expect(notice).not.toBeNull()
    expect(notice!.details).toMatchObject({ used: 150_000 })
  })
})

describe('agent chat store — token_usage_updated → 70% notice integration', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: [],
      isRunning: false,
      error: undefined,
      tokenUsage: undefined,
      notices: [],
      contextWatermarkSeen: {},
      pendingApprovals: [],
    })
  })

  it('pushes a single warning notice on the first crossing and marks dedup state', () => {
    applyEvent({
      type: 'token_usage_updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      usage: makeUsage({ contextUsage: 145_000, contextWindow: 200_000 }),
    })

    const state = useAgentChatStore.getState()
    expect(state.notices).toHaveLength(1)
    expect(state.notices[0].kind).toBe('contextHighWatermark')
    expect(state.notices[0].level).toBe('warning')
    expect(state.contextWatermarkSeen['thread-1:l1']).toBe(true)
  })

  it('does NOT re-push on subsequent token_usage events for the same thread, even after dismissal', () => {
    applyEvent({
      type: 'token_usage_updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      usage: makeUsage({ contextUsage: 145_000, contextWindow: 200_000 }),
    })

    expect(useAgentChatStore.getState().notices).toHaveLength(1)
    const noticeId = useAgentChatStore.getState().notices[0].id
    useAgentChatStore.getState().dismissNotice(noticeId)
    expect(useAgentChatStore.getState().notices).toHaveLength(0)

    // Usage climbs further — still no new notice (dismissed by user, respect that).
    applyEvent({
      type: 'token_usage_updated',
      threadId: 'thread-1',
      turnId: 'turn-2',
      usage: makeUsage({ contextUsage: 175_000, contextWindow: 200_000 }),
    })

    expect(useAgentChatStore.getState().notices).toHaveLength(0)
  })

  it('does not push below the threshold', () => {
    applyEvent({
      type: 'token_usage_updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      usage: makeUsage({ contextUsage: 100_000, contextWindow: 200_000 }),
    })

    expect(useAgentChatStore.getState().notices).toHaveLength(0)
    expect(useAgentChatStore.getState().contextWatermarkSeen).toEqual({})
  })

  it('newThread() clears the watermark seen tracker so re-entry triggers a fresh warning', () => {
    applyEvent({
      type: 'token_usage_updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      usage: makeUsage({ contextUsage: 145_000, contextWindow: 200_000 }),
    })
    expect(useAgentChatStore.getState().notices).toHaveLength(1)

    useAgentChatStore.getState().newThread()
    expect(useAgentChatStore.getState().contextWatermarkSeen).toEqual({})
  })

  it('drops token_usage_updated events for a non-active thread without firing a notice', () => {
    applyEvent({
      type: 'token_usage_updated',
      threadId: 'other-thread',
      turnId: 'turn-x',
      usage: makeUsage({ contextUsage: 180_000, contextWindow: 200_000 }),
    })

    const state = useAgentChatStore.getState()
    expect(state.tokenUsage).toBeUndefined()
    expect(state.notices).toHaveLength(0)
  })
})
