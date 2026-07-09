/**
 * parseUnifiedDiff — reconstructs before/after file contents from a unified
 * diff so the ai-change tab can render a side-by-side compare. Committed
 * empty in the v4.2.7 wip; filled in as part of the baseline cleanup.
 */
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../parseUnifiedDiff'

const SIMPLE_DIFF = [
  'diff --git a/foo.ts b/foo.ts',
  'index 111..222 100644',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' export { a, b }',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('splits context/removed/added lines into before/after contents', () => {
    const res = parseUnifiedDiff(SIMPLE_DIFF)
    expect(res).toEqual({
      ok: true,
      beforeContent: 'const a = 1\nconst b = 2\nexport { a, b }',
      afterContent: 'const a = 1\nconst b = 3\nexport { a, b }',
    })
  })

  it('handles new-file diffs (no before content)', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n')
    const res = parseUnifiedDiff(diff)
    expect(res).toEqual({
      ok: true,
      beforeContent: '',
      afterContent: 'line one\nline two',
    })
  })

  it('handles deleted-file diffs (no after content)', () => {
    const diff = [
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-gone one',
      '-gone two',
    ].join('\n')
    const res = parseUnifiedDiff(diff)
    expect(res).toEqual({
      ok: true,
      beforeContent: 'gone one\ngone two',
      afterContent: '',
    })
  })

  it('normalises CRLF and skips the no-newline marker', () => {
    const diff = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
    ].join('\r\n')
    const res = parseUnifiedDiff(diff)
    expect(res).toEqual({ ok: true, beforeContent: 'old', afterContent: 'new' })
  })

  it('processes multiple hunks in one file', () => {
    const diff = [
      '--- a/multi.ts',
      '+++ b/multi.ts',
      '@@ -1,2 +1,2 @@',
      ' top',
      '-first old',
      '+first new',
      '@@ -10,2 +10,2 @@',
      ' bottom',
      '-second old',
      '+second new',
    ].join('\n')
    const res = parseUnifiedDiff(diff)
    expect(res).toEqual({
      ok: true,
      beforeContent: 'top\nfirst old\nbottom\nsecond old',
      afterContent: 'top\nfirst new\nbottom\nsecond new',
    })
  })

  it('rejects an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual({ ok: false, reason: 'empty diff' })
    expect(parseUnifiedDiff('   \n  ')).toEqual({ ok: false, reason: 'empty diff' })
  })

  it('rejects header-only input with no diff lines', () => {
    const diff = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x'].join('\n')
    expect(parseUnifiedDiff(diff)).toEqual({ ok: false, reason: 'no diff lines found' })
  })
})
