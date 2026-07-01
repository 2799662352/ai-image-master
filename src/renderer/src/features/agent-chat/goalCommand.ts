/**
 * Pure parser for the native `/goal` slash command (codex-tui parity). Kept
 * side-effect free so the branching can be unit-tested in isolation from the
 * React composer. Subcommands mirror codex TUI `slash_dispatch.rs`
 * (`clear / edit / pause / resume / <objective>`), plus a client convenience
 * `budget <n>` that maps onto the RPC's `tokenBudget` (the TUI has no budget
 * syntax; the app-server accepts it on `thread/goal/set`).
 */

export type GoalCommand =
  | { kind: 'view' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'edit' }
  | { kind: 'budget'; tokenBudget: number }
  | { kind: 'set'; objective: string }

/**
 * Parse a human budget token into an integer count.
 * Accepts plain digits and `k`/`m` suffixes (case-insensitive), optional
 * separators/underscores/commas: `200000`, `200k`, `1.5m`, `200_000`.
 * Returns `null` when it isn't a positive finite number.
 */
export function parseBudgetAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,_\s]/g, '').toLowerCase()
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(cleaned)
  if (!m) return null
  let value = Number.parseFloat(m[1])
  if (m[2] === 'k') value *= 1_000
  else if (m[2] === 'm') value *= 1_000_000
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

/**
 * Parse a composer string as a `/goal` command. Returns `null` when the input
 * is not a `/goal` invocation (so the caller sends it as a normal turn).
 *
 * - `/goal`                → view
 * - `/goal pause|resume`   → status change
 * - `/goal clear`          → clear
 * - `/goal edit`           → edit (prefill the current objective for revision)
 * - `/goal budget 200k`    → set/replace the token budget (needs an existing goal)
 * - `/goal <objective>`    → set/replace the objective
 *
 * `budget` with a missing/invalid amount falls through to `set` so the literal
 * text isn't silently swallowed.
 */
export function parseGoalCommand(raw: string): GoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(raw.trim())
  if (!match) return null

  const arg = (match[1] ?? '').trim()
  if (arg === '') return { kind: 'view' }

  const keyword = arg.toLowerCase()
  if (keyword === 'pause') return { kind: 'pause' }
  if (keyword === 'resume') return { kind: 'resume' }
  if (keyword === 'clear') return { kind: 'clear' }
  if (keyword === 'edit') return { kind: 'edit' }

  const budgetMatch = /^budget\s+(.+)$/i.exec(arg)
  if (budgetMatch) {
    const amount = parseBudgetAmount(budgetMatch[1])
    if (amount !== null) return { kind: 'budget', tokenBudget: amount }
    // Invalid amount → treat the whole thing as an objective rather than eat it.
  }

  return { kind: 'set', objective: arg }
}
