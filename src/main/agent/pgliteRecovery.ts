/**
 * Pure helpers for the PGlite NODEFS recovery path.
 *
 * Why this exists:
 *   PGlite #884 + #794 (open upstream, PR #892 in flight): when the dataDir
 *   wasn't cleanly closed (crash, force-quit, installer overwrite, dual
 *   instance), `PGlite.create(dataDir)` aborts inside Emscripten with a
 *   `RuntimeError: Aborted()` deep in callMain. There is no upstream fix
 *   shipped at the time of writing; user-visible workaround is to delete
 *   the data dir.
 *
 *   This module gives `db.ts` the primitives to detect the abort, move the
 *   corrupt dir aside (preserving it for forensics), and gate retries
 *   behind a circuit breaker so a genuinely broken WASM binary or hardware
 *   issue can't trap us in a reset loop.
 *
 * Kept in its own file so the helpers can be unit-tested without dragging
 * in `electron`, `utilityProcess`, or PGlite itself.
 *
 * @see https://github.com/electric-sql/pglite/issues/884
 * @see https://github.com/electric-sql/pglite/issues/794
 * @see https://github.com/electric-sql/pglite/pull/892
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Detect the upstream Emscripten `Aborted()` error pattern. We deliberately
 * cast a wide net (any of `Aborted()`, `RuntimeError`, `callMain`, or the
 * `wasm-function[...]` frame) because the same root cause surfaces with
 * slightly different wrappers depending on whether it bubbles through the
 * worker IPC tunnel as a serialized `error` payload or as a raw `exit(code)`
 * with stderr capture.
 *
 * Negative cases we explicitly DON'T treat as recoverable:
 *   - port conflict (`EADDRINUSE`)              — different problem
 *   - missing worker bundle preflight error    — config issue, no recovery
 */
export function isPgliteAbortedError(err: unknown): boolean {
  const message = extractMessage(err)
  if (!message) return false
  // Recovery-eligible signals
  if (/Aborted\s*\(\s*\)/i.test(message)) return true
  if (/\bRuntimeError\b/.test(message) && /\bcallMain\b/.test(message)) return true
  if (/\bcallMain\b/.test(message) && /wasm-function/i.test(message)) return true
  return false
}

function extractMessage(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return `${err.message}\n${err.stack ?? ''}`
  if (typeof err === 'object') {
    const maybeMessage = (err as { message?: unknown }).message
    if (typeof maybeMessage === 'string') return maybeMessage
  }
  return String(err)
}

export interface MoveCorruptDataDirOpts {
  dataDir: string
  now: () => Date
}

/**
 * Move `dataDir` aside to a sibling `<dataDir>.corrupted-<ISO>` so the next
 * PGlite startup creates a fresh dir but the user (or a future support
 * session) can still inspect what went wrong.
 *
 * Returns the backup path on success, or `null` if there was nothing to
 * move (dir already gone). Throws only if the move itself fails — callers
 * should let that bubble.
 *
 * Suffix collisions (same millisecond) are resolved with a numeric `-N`
 * tail, since `Date#toISOString` only has ms precision and a fast-failing
 * worker could legitimately tick recovery twice in the same instant.
 */
export function moveCorruptDataDir(opts: MoveCorruptDataDirOpts): string | null {
  const { dataDir, now } = opts
  if (!fs.existsSync(dataDir)) return null

  const stamp = now().toISOString().replace(/[:.]/g, '-')
  const parent = path.dirname(dataDir)
  const base = path.basename(dataDir)

  let attempt = 0
  // Bounded loop — disk inode collisions in same ms are vanishingly rare;
  // if 100 isn't enough something is fundamentally wrong with the FS.
  while (attempt < 100) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    const target = path.join(parent, `${base}.corrupted-${stamp}${suffix}`)
    if (!fs.existsSync(target)) {
      fs.renameSync(dataDir, target)
      return target
    }
    attempt += 1
  }
  throw new Error(
    `moveCorruptDataDir: could not find an unused backup name in 100 tries (parent=${parent}, base=${base})`,
  )
}

export interface ResetAttemptsState {
  attempts: string[] // ISO timestamps
}

export interface CircuitOpts {
  markerPath: string
  now: () => Date
  windowMs: number
}

export interface CircuitDecisionOpts extends CircuitOpts {
  maxResets: number
}

export interface CircuitDecision {
  allowed: boolean
  recentResets: number
}

/**
 * Returns whether another auto-recovery is allowed RIGHT NOW based on how
 * many resets happened inside the rolling `windowMs` window. Does NOT
 * mutate the marker file — call `recordResetAttempt` after a successful
 * reset.
 *
 * Robust to:
 *   - missing marker (treats as zero attempts)
 *   - corrupt JSON (treats as zero attempts; better to allow an attempt
 *     than to brick the user because the breaker file got mangled)
 */
export function isResetAllowedNow(opts: CircuitDecisionOpts): CircuitDecision {
  const { markerPath, now, maxResets, windowMs } = opts
  const recent = readRecentAttempts({ markerPath, now, windowMs })
  return {
    allowed: recent.length < maxResets,
    recentResets: recent.length,
  }
}

/**
 * Append `now` to the marker file, pruning entries that fell out of the
 * rolling window. Best-effort: write failures are swallowed (logged via
 * `console.warn`) because the breaker is a safety net, not the primary
 * recovery path — losing it is annoying, not catastrophic.
 */
export function recordResetAttempt(opts: CircuitOpts): void {
  const { markerPath, now, windowMs } = opts
  const recent = readRecentAttempts({ markerPath, now, windowMs })
  const updated: ResetAttemptsState = {
    attempts: [...recent.map((d) => d.toISOString()), now().toISOString()],
  }
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, JSON.stringify(updated, null, 2), 'utf8')
  } catch (err) {
    console.warn('[pgliteRecovery] could not persist reset attempt marker:', err)
  }
}

function readRecentAttempts(opts: CircuitOpts): Date[] {
  const { markerPath, now, windowMs } = opts
  let parsed: ResetAttemptsState | null = null
  try {
    if (!fs.existsSync(markerPath)) return []
    const raw = fs.readFileSync(markerPath, 'utf8')
    const candidate = JSON.parse(raw) as unknown
    if (
      candidate &&
      typeof candidate === 'object' &&
      Array.isArray((candidate as ResetAttemptsState).attempts)
    ) {
      parsed = candidate as ResetAttemptsState
    }
  } catch {
    return []
  }
  if (!parsed) return []

  const cutoff = now().getTime() - windowMs
  const recent: Date[] = []
  for (const iso of parsed.attempts) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    if (d.getTime() >= cutoff) recent.push(d)
  }
  return recent
}
