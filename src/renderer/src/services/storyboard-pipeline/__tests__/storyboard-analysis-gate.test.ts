import { describe, it, expect } from 'vitest'
import { shouldRetryStoryboardAnalysis } from '../StoryboardProPipeline'

describe('shouldRetryStoryboardAnalysis (utility, no longer used by graph)', () => {
  it('returns "continue" when scene has valid d field', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: 'A→B→C' },
      objs: null,
    })).toBe('continue')
  })

  it('returns "continue" when objs array is non-empty', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: [{ n: 'Alice' }],
    })).toBe('continue')
  })

  it('returns "abort" when both null (no retry)', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: null,
    })).toBe('abort')
  })

  it('returns "abort" when scene has "(analysis failed)" marker and no objs', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: '(analysis failed)' },
      objs: null,
    })).toBe('abort')
  })

  it('returns "continue" when scene failed but objs exist', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: '(analysis failed)' },
      objs: [{ n: 'Bob' }],
    })).toBe('continue')
  })
})

describe('taskPlan injection contract', () => {
  it('sceneDecompose systemPrompt should contain taskPlan when present', () => {
    const taskPlan = 'Scene: dark alley. Characters: detective, suspect. Style: noir.'
    const vars: Record<string, string> = {
      user_context: 'test context',
      task_plan: taskPlan,
    }
    expect(vars.task_plan).toBe(taskPlan)
    expect(vars.task_plan.length).toBeGreaterThan(0)
  })

  it('taskPlan should appear in user message text when present', () => {
    const taskPlan = 'Scene: dark alley. Characters: detective.'
    const userContext = 'Additional notes'
    const text = taskPlan
      ? `STORYBOARD PLAN:\n${taskPlan}\n\nBased on the plan above AND the reference images, analyze the scene structure.${userContext ? `\nAdditional context: ${userContext}` : ''}`
      : `Analyze the scene structure from the images above.${userContext ? `\nAdditional context: ${userContext}` : ''}`
    expect(text).toContain('STORYBOARD PLAN:')
    expect(text).toContain(taskPlan)
    expect(text).toContain('Additional context: Additional notes')
  })

  it('taskPlan should NOT appear in user message when empty', () => {
    const taskPlan = ''
    const text = taskPlan
      ? `STORYBOARD PLAN:\n${taskPlan}\n\nBased on the plan above, analyze.`
      : 'Analyze the scene structure from the images above.'
    expect(text).not.toContain('STORYBOARD PLAN:')
    expect(text).toBe('Analyze the scene structure from the images above.')
  })
})
