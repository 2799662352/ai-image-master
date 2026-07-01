import { describe, expect, it } from 'vitest'
import type { AgentTokenUsage } from '../../../../../types/agent'
import { buildContextSegments } from '../tokenSegments'

const baseUsage: AgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
}

describe('buildContextSegments', () => {
  it('splits a happy-path usage into four ordered segments', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 10_000,
      cachedInputTokens: 8_000,
      outputTokens: 2_000,
      reasoningTokens: 500,
      contextWindow: 110_000,
    })
    expect(result.segments.map((s) => [s.key, s.tokens])).toEqual([
      ['cached', 8_000],
      ['conversation', 2_000],
      ['reasoning', 500],
      ['output', 1_500],
    ])
    expect(result.total).toBe(12_000)
    expect(result.windowTokens).toBe(110_000)
    // Codex effective-window formula: used = max(0, 12k − 12k baseline) = 0 →
    // 0% of the (110k − 12k) effective window.
    expect(result.pctFull).toBe(0)
  })

  it('treats missing cachedInputTokens as zero (Conversation = full inputTokens)', () => {
    const result = buildContextSegments({ ...baseUsage, inputTokens: 5_000, outputTokens: 1_000 })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.cached).toBe(0)
    expect(map.conversation).toBe(5_000)
    expect(map.reasoning).toBe(0)
    expect(map.output).toBe(1_000)
  })

  it('treats missing reasoningTokens as zero (Output = full outputTokens)', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 1_000,
      outputTokens: 800,
      cachedInputTokens: 600,
    })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.reasoning).toBe(0)
    expect(map.output).toBe(800)
  })

  it('clamps cached when gateway reports cached > input', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 1_000,
      cachedInputTokens: 9_999,
      outputTokens: 100,
    })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.cached).toBe(1_000)
    expect(map.conversation).toBe(0)
  })

  it('clamps reasoning when gateway reports reasoning > output', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 999,
    })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.reasoning).toBe(50)
    expect(map.output).toBe(0)
  })

  it('omits pctFull when contextWindow is missing', () => {
    const result = buildContextSegments({ ...baseUsage, inputTokens: 1, outputTokens: 1 })
    expect(result.pctFull).toBeUndefined()
    expect(result.windowTokens).toBeUndefined()
  })

  it('total equals the sum of segment tokens after clamping', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 5_000,
      cachedInputTokens: 6_000,
      outputTokens: 1_000,
      reasoningTokens: 1_500,
    })
    const sum = result.segments.reduce((acc, s) => acc + s.tokens, 0)
    expect(result.total).toBe(sum)
    expect(result.total).toBe(6_000)
  })

  it('uses fallbackContextWindow when usage.contextWindow is missing', () => {
    const result = buildContextSegments(
      { inputTokens: 50_000, outputTokens: 50_000 },
      { fallbackContextWindow: 200_000 },
    )
    expect(result.windowTokens).toBe(200_000)
    // (100k − 12k) / (200k − 12k) = 88k/188k ≈ 47%.
    expect(result.pctFull).toBe(47)
  })

  it('prefers usage.contextWindow over fallbackContextWindow', () => {
    const result = buildContextSegments(
      { inputTokens: 25_000, outputTokens: 25_000, contextWindow: 100_000 },
      { fallbackContextWindow: 200_000 },
    )
    expect(result.windowTokens).toBe(100_000)
    // (50k − 12k) / (100k − 12k) = 38k/88k ≈ 43%.
    expect(result.pctFull).toBe(43)
  })

  // Regression: the popover must mirror the header donut, i.e. show CURRENT
  // context occupancy (codex `last_token_usage`), not cumulative lifetime spend.
  // With cumulative it would read ">100% Full" on a long thread.
  it('builds segments from usage.last (current context), not cumulative totals', () => {
    const result = buildContextSegments({
      // Cumulative (lifetime) totals — should be IGNORED for the breakdown.
      inputTokens: 250_000,
      outputTokens: 18_000,
      contextWindow: 272_000,
      // Current request occupancy.
      last: { inputTokens: 40_000, outputTokens: 2_000, cachedInputTokens: 30_000, reasoningTokens: 500 },
    })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.cached).toBe(30_000)
    expect(map.conversation).toBe(10_000) // 40k input - 30k cached
    expect(map.reasoning).toBe(500)
    expect(map.output).toBe(1_500) // 2k output - 500 reasoning
    expect(result.total).toBe(42_000)
    // (42k − 12k) / (272k − 12k) = 30k/260k ≈ 12%, not >100%.
    expect(result.pctFull).toBe(12)
  })
})
