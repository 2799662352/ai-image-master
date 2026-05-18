/**
 * Fuzzy palette matcher — case-insensitive subsequence scorer used by the
 * `/` slash palette to rank Commands + Skills.
 *
 * Goals:
 *  - `rev` reaches `reverse`
 *  - `tdd` reaches `test-driven-development`
 *  - `cl` ranks `clear` above `cancel` (prefix wins over scattered subsequence)
 *  - Empty query returns neutral order (caller-supplied)
 *
 * Non-goals: full fzf scoring, Smith-Waterman, weighted graph search. These
 * are overkill for ≤200-item palettes and harder to reason about in tests.
 *
 * Tier table (returned by `scoreFuzzyMatch`):
 *   exact equality                 → 1000
 *   prefix at index 0              → 800 - target.length / 10  (shorter wins ties)
 *   word-boundary prefix           → 600
 *   contiguous substring (mid-word)→ 400
 *   subsequence match              → 100 + consecutiveRunBonus
 *   no match                       → 0
 *
 * Word boundaries are detected at the start of input, after `-`, `_`, `/`,
 * `.`, or whitespace — the separators that show up in skill / command ids
 * we ship (`test-driven-development`, `mcp.create-server`, etc.).
 *
 * `indices` is the array of positions into the original target whose chars
 * matched the query, in order. UIs can use it to highlight matched glyphs
 * with a single pass.
 */

export interface FuzzyMatch {
  /** Higher is better. 0 means no match. */
  score: number
  /** Positions into the (original) target string that matched the query. */
  indices: number[]
}

const SEPARATORS = new Set(['-', '_', '/', '.', ' ', '\t', '\n'])

function isWordBoundary(target: string, index: number): boolean {
  if (index === 0) return true
  const prev = target[index - 1]
  return prev != null && SEPARATORS.has(prev)
}

/**
 * Score a single (query, target) pair. Both are matched case-insensitively.
 * Returns `{ score: 0, indices: [] }` when no subsequence path exists.
 */
export function scoreFuzzyMatch(query: string, target: string): FuzzyMatch {
  if (query.length === 0) return { score: 1, indices: [] }
  if (target.length === 0) return { score: 0, indices: [] }

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  if (q === t) return { score: 1000, indices: range(query.length) }

  // First, walk the target to find a subsequence path; bail early when no
  // path exists so the more expensive tier checks below are skipped.
  const indices = findSubsequenceIndices(q, t)
  if (indices == null) return { score: 0, indices: [] }

  // Tier 1: prefix at index 0. Subtract length/10 so shorter targets break
  // ties (`cl` ranks `clear` above `clearance`).
  if (t.startsWith(q)) {
    return { score: 800 - target.length / 10, indices: range(q.length) }
  }

  // Tier 2: contiguous match starting at a word boundary anywhere.
  const subIdx = t.indexOf(q)
  if (subIdx !== -1) {
    const indicesAtBoundary = isWordBoundary(target, subIdx)
    const baseScore = indicesAtBoundary ? 600 : 400
    // Shorter targets still beat longer ones at the same tier.
    return {
      score: baseScore - target.length / 100,
      indices: range(q.length, subIdx),
    }
  }

  // Tier 3: scattered subsequence (already known to exist). Add a small
  // bonus for each pair of consecutive indices to reward less-scattered
  // matches: `test` in `test-driven` (consecutive) beats `tdrn` (every-other).
  let consecutivePairs = 0
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1]! + 1) consecutivePairs += 1
  }
  return {
    score: 100 + consecutivePairs * 10 - target.length / 1000,
    indices,
  }
}

/** Walk `t` once and pick the first char from each `q` slot. */
function findSubsequenceIndices(q: string, t: string): number[] | null {
  const out: number[] = []
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    while (ti < t.length && t[ti] !== q[qi]) ti += 1
    if (ti >= t.length) return null
    out.push(ti)
    ti += 1
  }
  return out
}

function range(length: number, start = 0): number[] {
  const out = new Array<number>(length)
  for (let i = 0; i < length; i++) out[i] = start + i
  return out
}

/**
 * Rank an array of items by their best-of-fields fuzzy score against
 * `query`. `extractFields(item)` returns the strings to score against; the
 * highest field score wins. Returns a new array containing only non-zero
 * matches sorted descending by score, **stable** within equal scores
 * (preserves input order — important so the caller can pre-sort by recency
 * or convention without re-sorting being undone).
 *
 * Empty query short-circuits to a copy of the input — palette UIs need to
 * render the full list while the user is just hovering the `/`.
 */
export function rankFuzzyTargets<T>(
  items: readonly T[],
  query: string,
  extractFields: (item: T) => readonly string[],
): T[] {
  if (query.length === 0) return items.slice()
  const scored: Array<{ item: T; score: number; order: number }> = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    let best = 0
    for (const field of extractFields(item)) {
      const { score } = scoreFuzzyMatch(query, field)
      if (score > best) best = score
    }
    if (best > 0) scored.push({ item, score: best, order: i })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.order - b.order
  })
  return scored.map((entry) => entry.item)
}
