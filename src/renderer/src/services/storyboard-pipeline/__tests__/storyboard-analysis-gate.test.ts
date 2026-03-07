import { describe, it, expect } from 'vitest'
import { shouldRetryStoryboardAnalysis } from '../StoryboardProPipeline'

describe('shouldRetryStoryboardAnalysis', () => {
  it('returns "continue" when scene has valid d field', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: 'A→B→C' },
      objs: null,
      analysisRetryCount: 0,
    })).toBe('continue')
  })

  it('returns "continue" when objs array is non-empty', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: [{ n: 'Alice' }],
      analysisRetryCount: 0,
    })).toBe('continue')
  })

  it('returns "retry" when both null and retries < max', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: null,
      analysisRetryCount: 0,
    })).toBe('retry')
  })

  it('returns "retry" when scene has "(analysis failed)" marker', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: '(analysis failed)' },
      objs: null,
      analysisRetryCount: 1,
    })).toBe('retry')
  })

  it('returns "abort" when both null and retries >= max', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: null,
      analysisRetryCount: 2,
    })).toBe('abort')
  })

  it('returns "continue" when scene failed but objs exist', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: '(analysis failed)' },
      objs: [{ n: 'Bob' }],
      analysisRetryCount: 0,
    })).toBe('continue')
  })
})
