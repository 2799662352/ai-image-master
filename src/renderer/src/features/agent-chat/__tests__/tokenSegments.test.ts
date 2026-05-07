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
    expect(result.pctFull).toBe(11)
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
})
