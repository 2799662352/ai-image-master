import { describe, expect, it } from 'vitest'
import {
  buildRetryFeedback,
  pickAffectedPanels,
  pickLowItems,
} from '../DirectorPipeline'

describe('DirectorPipeline partial retry feedback', () => {
  it('pickLowItems should return stable ordered labels', () => {
    const lowItems = pickLowItems({
      score: 8,
      ok: true,
      issues: [],
      faceConsistency: 5,
      outfitConsistency: 9,
      weaponConsistency: 4,
      styleContinuity: 7,
    } as any, 6)

    expect(lowItems).toEqual(['face consistency', 'weapon consistency'])
  })

  it('pickAffectedPanels should extract deduped sorted panel ids from issues', () => {
    const affected = pickAffectedPanels({
      issues: [
        'Panel 4: weapon shape drifts',
        'panel 2: hair color inconsistent',
        'Panel 4: outfit detail mismatch',
      ],
    } as any)

    expect(affected).toEqual([2, 4])
  })

  it('buildRetryFeedback should stay targeted and avoid global rewrite language', () => {
    const feedback = buildRetryFeedback({
      score: 5,
      ok: false,
      issues: ['Panel 3: weapon silhouette changed too much'],
      faceConsistency: 8,
      outfitConsistency: 8,
      weaponConsistency: 5,
      styleContinuity: 9,
    } as any, 6)

    expect(feedback).toContain('Soft correction only. Fix only: weapon consistency.')
    expect(feedback).toContain('Affected panels: 3.')
    expect(feedback).toContain('Panel 3: weapon silhouette changed too much')
    expect(feedback).not.toContain('rewrite all panels')
    expect(feedback).not.toContain('redesign entire storyboard')
  })

  it('buildRetryFeedback should fallback to minimal local subset when no panel number exists', () => {
    const feedback = buildRetryFeedback({
      score: 5,
      ok: false,
      issues: ['weapon consistency is weak but issue text has no panel id'],
      faceConsistency: 8,
      outfitConsistency: 8,
      weaponConsistency: 5,
      styleContinuity: 9,
    } as any, 6)

    expect(feedback).toContain('Affected panels: minimal local subset.')
    expect(feedback).not.toContain('rewrite all panels')
  })
})
