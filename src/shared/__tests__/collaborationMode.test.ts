import { describe, expect, it } from 'vitest'
import {
  isPlanReasoningEffort,
  normaliseSupportedPlanEfforts,
  resolvePlanReasoningEffort,
} from '../collaborationMode'

describe('resolvePlanReasoningEffort', () => {
  it('uses the known preset effort for auto preference', () => {
    expect(resolvePlanReasoningEffort('auto', 'medium')).toBe('medium')
  })

  it('falls back to medium when auto has no preset effort', () => {
    expect(resolvePlanReasoningEffort('auto', null)).toBe('medium')
  })

  it('preserves an explicit preference', () => {
    expect(resolvePlanReasoningEffort('high', 'medium')).toBe('high')
  })
})

describe('normaliseSupportedPlanEfforts', () => {
  it('keeps every model effort in canonical order and filters unknown values', () => {
    expect(
      normaliseSupportedPlanEfforts(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('deduplicates known efforts in display order', () => {
    expect(normaliseSupportedPlanEfforts(['xhigh', 'low', 'low', 'medium'])).toEqual([
      'low',
      'medium',
      'xhigh',
    ])
  })

  it('filters unknown effort values', () => {
    expect(normaliseSupportedPlanEfforts(['medium', 'future-level'])).toEqual(['medium'])
  })
})

describe('isPlanReasoningEffort', () => {
  it.each(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'accepts the known effort %s',
    (value) => {
      expect(isPlanReasoningEffort(value)).toBe(true)
    },
  )

  it.each([
    'future-level',
    '',
    null,
    undefined,
    1,
    true,
    {},
    ['medium'],
  ])('rejects unknown or non-string value %j', (value) => {
    expect(isPlanReasoningEffort(value)).toBe(false)
  })
})
