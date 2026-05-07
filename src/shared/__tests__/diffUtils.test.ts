import { describe, expect, it } from 'vitest'
import { countDiffLines, parseChange } from '../diffUtils'

describe('countDiffLines', () => {
  it('counts added and removed lines in a basic diff', () => {
    const diff = [
      '@@ -1,3 +1,4 @@',
      ' context',
      '-old line',
      '+new line 1',
      '+new line 2',
      ' context',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 })
  })

  it('ignores --- and +++ header lines', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 1, removed: 1 })
  })

  it('returns zeros for empty input', () => {
    expect(countDiffLines('')).toEqual({ added: 0, removed: 0 })
  })

  it('handles a create-only diff (all additions)', () => {
    const diff = [
      '@@ -0,0 +1,3 @@',
      '+line 1',
      '+line 2',
      '+line 3',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 3, removed: 0 })
  })

  it('handles a delete-only diff (all removals)', () => {
    const diff = [
      '@@ -1,2 +0,0 @@',
      '-line 1',
      '-line 2',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 0, removed: 2 })
  })
})

describe('parseChange', () => {
  it('maps create kind', () => {
    const result = parseChange({
      path: 'src/foo.ts',
      kind: 'create',
      unifiedDiff: '@@ -0,0 +1,1 @@\n+hello',
    })
    expect(result).toEqual({
      path: 'src/foo.ts',
      operation: 'create',
      diff: '@@ -0,0 +1,1 @@\n+hello',
      added: 1,
      removed: 0,
    })
  })

  it('maps delete kind', () => {
    const result = parseChange({
      path: 'old.txt',
      kind: 'delete',
      unifiedDiff: '@@ -1,1 +0,0 @@\n-gone',
    })
    expect(result.operation).toBe('delete')
    expect(result.removed).toBe(1)
  })

  it('maps modify kind to edit', () => {
    const result = parseChange({
      path: 'x.ts',
      kind: 'modify',
      unifiedDiff: '@@ -1,1 +1,1 @@\n-a\n+b',
    })
    expect(result.operation).toBe('edit')
  })
})
