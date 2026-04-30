// src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts
import { describe, it, expect } from 'vitest'
import { computeProcessingProgress } from './eraseProgress'

const base = {
  startedAt: 1000000,
  durationSeconds: 30,
  status: 'processing' as const,
  now: 1000000,
}

describe('computeProcessingProgress', () => {
  it('finished → 100 regardless of elapsed', () => {
    expect(computeProcessingProgress({ ...base, status: 'finished' })).toBe(100)
  })

  it('queued-upload → 0', () => {
    expect(computeProcessingProgress({ ...base, status: 'queued-upload' })).toBe(0)
  })

  it('now < startedAt → clamp to 0', () => {
    expect(computeProcessingProgress({ ...base, now: base.startedAt - 5000 })).toBe(0)
  })

  it('startedAt = undefined (NaN guard) → 0', () => {
    expect(computeProcessingProgress({ ...base, startedAt: undefined as any })).toBe(0)
  })

  it('durationSeconds = 0 → tau = 15s floor', () => {
    const opts = { ...base, durationSeconds: 0, now: base.startedAt + 15000 }
    expect(computeProcessingProgress(opts)).toBe(60)
  })

  it('5s video: elapsed = τ (15s) → ~60%', () => {
    const opts = { ...base, durationSeconds: 5, now: base.startedAt + 15000 }
    expect(computeProcessingProgress(opts)).toBe(60)
  })

  it('5min video: elapsed = τ (600s) → ~60%', () => {
    const opts = { ...base, durationSeconds: 300, now: base.startedAt + 600_000 }
    expect(computeProcessingProgress(opts)).toBe(60)
  })

  it('progress increases over time', () => {
    const a = computeProcessingProgress({ ...base, now: base.startedAt + 5000 })
    const b = computeProcessingProgress({ ...base, now: base.startedAt + 30000 })
    expect(b).toBeGreaterThan(a)
  })

  it('never exceeds 95 for processing status', () => {
    const opts = { ...base, now: base.startedAt + 999_999_999 }
    expect(computeProcessingProgress(opts)).toBeLessThanOrEqual(95)
  })
})
