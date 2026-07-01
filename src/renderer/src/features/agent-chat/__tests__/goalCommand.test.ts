import { describe, it, expect } from 'vitest'
import { parseGoalCommand, parseBudgetAmount } from '../goalCommand'

describe('parseBudgetAmount', () => {
  it('parses plain digits', () => {
    expect(parseBudgetAmount('200000')).toBe(200000)
  })
  it('parses k/m suffixes (case-insensitive)', () => {
    expect(parseBudgetAmount('200k')).toBe(200000)
    expect(parseBudgetAmount('200K')).toBe(200000)
    expect(parseBudgetAmount('1.5m')).toBe(1500000)
  })
  it('tolerates separators', () => {
    expect(parseBudgetAmount('200_000')).toBe(200000)
    expect(parseBudgetAmount('200,000')).toBe(200000)
    expect(parseBudgetAmount(' 200 000 ')).toBe(200000)
  })
  it('rejects non-numbers and non-positive', () => {
    expect(parseBudgetAmount('abc')).toBeNull()
    expect(parseBudgetAmount('0')).toBeNull()
    expect(parseBudgetAmount('-5')).toBeNull()
    expect(parseBudgetAmount('')).toBeNull()
  })
})

describe('parseGoalCommand', () => {
  it('returns null for non-/goal input', () => {
    expect(parseGoalCommand('hello world')).toBeNull()
    expect(parseGoalCommand('/goalpost is close')).toBeNull()
    expect(parseGoalCommand('/other')).toBeNull()
  })

  it('bare /goal → view (with surrounding whitespace)', () => {
    expect(parseGoalCommand('/goal')).toEqual({ kind: 'view' })
    expect(parseGoalCommand('  /goal   ')).toEqual({ kind: 'view' })
  })

  it('parses lifecycle keywords case-insensitively', () => {
    expect(parseGoalCommand('/goal pause')).toEqual({ kind: 'pause' })
    expect(parseGoalCommand('/goal RESUME')).toEqual({ kind: 'resume' })
    expect(parseGoalCommand('/goal clear')).toEqual({ kind: 'clear' })
    expect(parseGoalCommand('/goal edit')).toEqual({ kind: 'edit' })
    expect(parseGoalCommand('/GOAL pause')).toEqual({ kind: 'pause' })
  })

  it('parses budget with amount', () => {
    expect(parseGoalCommand('/goal budget 200k')).toEqual({ kind: 'budget', tokenBudget: 200000 })
    expect(parseGoalCommand('/goal budget 150000')).toEqual({ kind: 'budget', tokenBudget: 150000 })
  })

  it('falls through to set when budget amount is invalid', () => {
    expect(parseGoalCommand('/goal budget soon please')).toEqual({
      kind: 'set',
      objective: 'budget soon please',
    })
  })

  it('treats anything else as a new objective', () => {
    expect(parseGoalCommand('/goal ship the feature')).toEqual({
      kind: 'set',
      objective: 'ship the feature',
    })
    // Multi-line objectives preserved.
    expect(parseGoalCommand('/goal line1\nline2')).toEqual({
      kind: 'set',
      objective: 'line1\nline2',
    })
  })

  it('does not confuse a keyword used as a real objective prefix', () => {
    // "pause the deploy pipeline" is an objective, not the pause lifecycle verb.
    expect(parseGoalCommand('/goal pause the deploy pipeline')).toEqual({
      kind: 'set',
      objective: 'pause the deploy pipeline',
    })
  })
})
