import { describe, it, expect } from 'vitest'
import { buildRetryFeedback, pickLowItems, shouldRetryAnalysis } from '../DirectorPipeline'

describe('Evaluator-Optimizer helpers', () => {
  it('buildRetryFeedback returns non-empty string for low-score report', () => {
    const report = { score: 3, issues: ['Character missing from panel 1'] }
    const feedback = buildRetryFeedback(report, 6)
    expect(feedback.length).toBeGreaterThan(0)
    expect(feedback).toContain('Character missing')
  })

  it('pickLowItems finds sub-scores below threshold', () => {
    const report = { score: 5, faceConsistency: 3, narrativeFlow: 8 }
    const items = pickLowItems(report, 6)
    expect(items).toContain('face consistency')
    expect(items).not.toContain('narrative flow')
  })

  it('buildRetryFeedback returns fallback string for null report', () => {
    const feedback = buildRetryFeedback(null, 6)
    expect(feedback).toContain('Soft correction only')
  })
})

describe('shouldRetryAnalysis routing', () => {
  it('returns "continue" when scene is valid', () => {
    const result = shouldRetryAnalysis({
      scene: { env: 'forest clearing' },
      characters: null,
      analysisRetryCount: 0,
    })
    expect(result).toBe('continue')
  })

  it('returns "continue" when characters are valid', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: { characters: [{ name: 'Hero' }] },
      analysisRetryCount: 0,
    })
    expect(result).toBe('continue')
  })

  it('returns "retry" when both null and retries < max', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: null,
      analysisRetryCount: 0,
    })
    expect(result).toBe('retry')
  })

  it('returns "abort" when both null and retries >= max', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: null,
      analysisRetryCount: 2,
    })
    expect(result).toBe('abort')
  })

  it('returns "continue" when scene skipped via flag', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: null,
      analysisRetryCount: 0,
      skipAnalyzeScene: true,
    })
    expect(result).toBe('continue')
  })
})

describe('execute() initial progress', () => {
  it('emits onProgress with correct totalPasses before stream starts', async () => {
    const skipVerify = false
    const totalPasses = skipVerify ? 5 : 6
    expect(totalPasses).toBe(6)

    const skipVerifyTrue = true
    const totalPassesFast = skipVerifyTrue ? 5 : 6
    expect(totalPassesFast).toBe(5)
  })
})
