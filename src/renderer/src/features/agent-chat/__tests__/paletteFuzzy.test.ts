import { describe, expect, it } from 'vitest'
import { scoreFuzzyMatch, rankFuzzyTargets } from '../paletteFuzzy'

/**
 * Fuzzy palette matcher — subsequence-aware, case-insensitive scorer. Built
 * to rank `/` palette items (commands + skills) by query relevance.
 *
 * Inspired by VS Code's command palette and Cursor's slash menu: the user
 * types a few letters and expects "best matches first", not strict prefix
 * substring filtering. `rev` should reach `reverse`; `tdd` should reach
 * `test-driven-development`. We do NOT use full fzf scoring — that's overkill
 * for ~50-item lists and harder to predict in tests.
 *
 * Scoring tiers (returned by `scoreFuzzyMatch`):
 *  - exact equality                 → 1000
 *  - prefix at index 0              → 800 (shorter target wins ties via subtract)
 *  - word-boundary prefix           → 600  (e.g. `dr` for `test-driven-…`)
 *  - contiguous substring           → 400
 *  - subsequence match              → 100 + bonus for consecutive runs
 *  - no match                       → 0
 *
 * The matcher always also returns the **match indices** into the target so
 * the UI can highlight matched glyphs without re-running a second matcher.
 */

describe('scoreFuzzyMatch — single target scoring', () => {
  it('exact equality scores highest', () => {
    const a = scoreFuzzyMatch('clear', 'clear')
    const b = scoreFuzzyMatch('cle', 'clear')
    expect(a.score).toBeGreaterThan(b.score)
  })

  it('prefix beats substring beats subsequence', () => {
    const prefix = scoreFuzzyMatch('cl', 'clear')
    const substr = scoreFuzzyMatch('le', 'clear')
    const subseq = scoreFuzzyMatch('cer', 'clear')
    expect(prefix.score).toBeGreaterThan(substr.score)
    expect(substr.score).toBeGreaterThan(subseq.score)
    expect(subseq.score).toBeGreaterThan(0)
  })

  it('word-boundary prefix beats arbitrary substring', () => {
    // `dr` is a contiguous substring AND starts at the `d` of the `driven`
    // word (after `-`). `st` is a contiguous substring inside `test` — not
    // at a word boundary. Word-boundary tier (600) must outrank mid-word (400).
    const wb = scoreFuzzyMatch('dr', 'test-driven-development')
    const sub = scoreFuzzyMatch('st', 'test-driven-development')
    expect(wb.score).toBeGreaterThan(sub.score)
  })

  it('subsequence matching works across separators', () => {
    expect(scoreFuzzyMatch('rev', 'reverse').score).toBeGreaterThan(0)
    expect(scoreFuzzyMatch('tdd', 'test-driven-development').score).toBeGreaterThan(0)
    expect(scoreFuzzyMatch('sdb', 'systematic-debugging').score).toBeGreaterThan(0)
  })

  it('returns score 0 and empty indices when no subsequence exists', () => {
    const r = scoreFuzzyMatch('xyz', 'reverse')
    expect(r.score).toBe(0)
    expect(r.indices).toEqual([])
  })

  it('is case-insensitive', () => {
    const a = scoreFuzzyMatch('REV', 'reverse')
    const b = scoreFuzzyMatch('rev', 'REVERSE')
    expect(a.score).toBeGreaterThan(0)
    expect(b.score).toBeGreaterThan(0)
    expect(a.score).toBe(b.score)
  })

  it('returns match indices into the original target', () => {
    const r = scoreFuzzyMatch('tdd', 'test-driven-development')
    // Indices should point at t(0), d(5), d(12) — first occurrence path.
    expect(r.indices).toHaveLength(3)
    expect(r.indices[0]).toBe(0)
    // Each subsequent index must be strictly greater than the prior.
    for (let i = 1; i < r.indices.length; i++) {
      expect(r.indices[i]).toBeGreaterThan(r.indices[i - 1]!)
    }
    // Picked chars must equal the (lowercased) query.
    const picked = r.indices.map((i) => 'test-driven-development'[i]).join('')
    expect(picked.toLowerCase()).toBe('tdd')
  })

  it('empty query yields neutral score and no indices', () => {
    const r = scoreFuzzyMatch('', 'anything')
    expect(r.score).toBeGreaterThan(0)
    expect(r.indices).toEqual([])
  })

  it('shorter targets break ties on prefix matches', () => {
    // Both prefix-match `cl` — the shorter `clear` (5) should outrank
    // a hypothetical longer `clearance` (9).
    const shorter = scoreFuzzyMatch('cl', 'clear')
    const longer = scoreFuzzyMatch('cl', 'clearance')
    expect(shorter.score).toBeGreaterThan(longer.score)
  })

  it('consecutive subsequence runs beat scattered ones', () => {
    const consecutive = scoreFuzzyMatch('test', 'test-driven') // contiguous, prefix
    const scattered = scoreFuzzyMatch('tdrn', 'test-driven') // every other char
    expect(consecutive.score).toBeGreaterThan(scattered.score)
  })
})

describe('rankFuzzyTargets — ordering palette candidates', () => {
  function names<T extends { id: string }>(items: T[]): string[] {
    return items.map((i) => i.id)
  }

  const items = [
    { id: 'clear', label: '/clear', desc: 'Start a new thread' },
    { id: 'cancel', label: '/cancel', desc: 'Cancel the running turn' },
    { id: 'compact', label: '/compact', desc: 'Compact the context' },
    { id: 'help', label: '/help', desc: 'Show shortcuts' },
  ]

  it('orders prefix matches before substring matches', () => {
    const ranked = rankFuzzyTargets(items, 'cl', (i) => [i.id, i.desc])
    // `cl` is a prefix of `clear` and a non-prefix subsequence in `cancel`/
    // `compact`. `clear` should come first.
    expect(names(ranked)[0]).toBe('clear')
  })

  it('drops zero-score candidates entirely', () => {
    const ranked = rankFuzzyTargets(items, 'xyz', (i) => [i.id])
    expect(ranked).toEqual([])
  })

  it('empty query preserves input order and returns everything', () => {
    const ranked = rankFuzzyTargets(items, '', (i) => [i.id])
    expect(names(ranked)).toEqual(['clear', 'cancel', 'compact', 'help'])
  })

  it('uses the best field score when extractor returns multiple strings', () => {
    // Query `shortcut` only matches the description of `/help` — must rank it
    // first even though id/label are misses.
    const ranked = rankFuzzyTargets(items, 'shortcut', (i) => [i.id, i.label, i.desc])
    expect(ranked[0]?.id).toBe('help')
  })

  it('stable order among equal scores follows input order', () => {
    const onlyTwo = [
      { id: 'one', label: 'one', desc: '' },
      { id: 'two', label: 'two', desc: '' },
    ]
    // Query `o` substring-matches both at the same kind of position.
    const ranked = rankFuzzyTargets(onlyTwo, 'o', (i) => [i.id])
    expect(names(ranked)).toEqual(['one', 'two'])
  })
})
