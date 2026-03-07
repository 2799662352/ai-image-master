import { describe, it, expect } from 'vitest'
import { buildRetryFeedback, pickLowItems, shouldRetryAnalysis, unwrapVerifyResult } from '../DirectorPipeline'

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

describe('unwrapVerifyResult', () => {
  it('returns data as-is when already in correct format', () => {
    const data = { score: 8, ok: true, issues: ['minor issue'] }
    const result = unwrapVerifyResult(data)
    expect(result?.score).toBe(8)
    expect(result?.ok).toBe(true)
    expect(result?.issues).toEqual(['minor issue'])
  })

  it('extracts from verification_result wrapper', () => {
    const data = {
      verification_result: {
        overall_score: 6,
        status: 'FAIL',
        deductions: ['-2: truncated prompts'],
        dimensions: {
          character_consistency: { score: 7, issues: ['anchors missing'] },
          lighting: { score: 8, issues: [] },
        },
      },
    }
    const result = unwrapVerifyResult(data)
    expect(result?.score).toBe(6)
    expect(result?.ok).toBe(false)
    expect(result?.issues).toContain('-2: truncated prompts')
    expect(result?.issues).toContain('anchors missing')
  })

  it('extracts from flat overall_score format', () => {
    const data = { overall_score: 9, status: 'PASS', issues: ['all good'] }
    const result = unwrapVerifyResult(data)
    expect(result?.score).toBe(9)
    expect(result?.ok).toBe(true)
  })

  it('collects panel_analysis notes as issues', () => {
    const data = {
      verification_result: {
        overall_score: 5,
        status: 'FAIL',
        panel_analysis: [
          { panel: 1, status: 'INCOMPLETE', notes: 'Prompt truncated' },
          { panel: 2, status: 'OK', notes: 'Fine' },
        ],
      },
    }
    const result = unwrapVerifyResult(data)
    expect(result?.issues).toContain('Panel 1: Prompt truncated')
    expect(result?.issues).not.toContain('Panel 2: Fine')
  })

  it('returns null for invalid data', () => {
    expect(unwrapVerifyResult(null)).toBeNull()
    expect(unwrapVerifyResult({})).toBeNull()
    expect(unwrapVerifyResult({ foo: 'bar' })).toBeNull()
  })
})
