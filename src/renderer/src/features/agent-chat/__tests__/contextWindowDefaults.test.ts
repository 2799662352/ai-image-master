import { describe, expect, it } from 'vitest'
import {
  CONTEXT_BASELINE_TOKENS,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  contextUsedPercent,
} from '../contextWindowDefaults'

/**
 * Locks the Codex effective-window percentage formula (codex-rs/tui/src/
 * token_usage.rs). The whole point of these constants is pixel-parity with the
 * TUI status line, so these are exact-value assertions, not smoke tests.
 */
describe('contextUsedPercent', () => {
  it('keeps the baseline + default window in sync with codexLaunch', () => {
    expect(CONTEXT_BASELINE_TOKENS).toBe(12_000)
    expect(DEFAULT_MODEL_CONTEXT_WINDOW).toBe(200_000)
  })

  it('subtracts the 12K baseline from BOTH used and window', () => {
    // (62k − 12k) / (100k − 12k) = 50k / 88k ≈ 56.8%.
    expect(contextUsedPercent(62_000, 100_000)).toBeCloseTo(56.818, 2)
  })

  it('returns 0 when occupancy is at or below the baseline', () => {
    expect(contextUsedPercent(12_000, 200_000)).toBe(0)
    expect(contextUsedPercent(5_000, 200_000)).toBe(0)
    expect(contextUsedPercent(0, 200_000)).toBe(0)
  })

  it('returns 100 when occupancy fills (or overshoots) the window', () => {
    expect(contextUsedPercent(200_000, 200_000)).toBe(100)
    expect(contextUsedPercent(999_000, 200_000)).toBe(100)
  })

  it('hits the 70% and 90% watermark crossings on a 200K window', () => {
    // 0.7 × (200k − 12k) + 12k = 143_600 → exactly 70%.
    expect(contextUsedPercent(143_600, 200_000)).toBeCloseTo(70, 5)
    // 0.9 × (200k − 12k) + 12k = 181_200 → exactly 90%.
    expect(contextUsedPercent(181_200, 200_000)).toBeCloseTo(90, 5)
  })

  it('returns null when the window is unusable (≤ baseline)', () => {
    expect(contextUsedPercent(5_000, CONTEXT_BASELINE_TOKENS)).toBeNull()
    expect(contextUsedPercent(5_000, 8_000)).toBeNull()
    expect(contextUsedPercent(5_000, 0)).toBeNull()
  })
})
