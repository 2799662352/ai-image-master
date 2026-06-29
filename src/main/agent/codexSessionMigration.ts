import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'

export interface MigrateLegacySessionsInput {
  /** Legacy per-app sessions dir (`<userData>/codex-runtime/sessions`). */
  legacySessionsDir: string
  /**
   * Canonical pinned sessions dir (`<CODEX_HOME>/sessions`, default
   * `~/.codex/sessions`) that every codex spawn now reads/writes.
   */
  targetSessionsDir: string
}

export interface MigrateLegacySessionsResult {
  moved: number
  skipped: number
}

/**
 * One-time, best-effort consolidation of codex session rollouts.
 *
 * Background: the app historically spawned codex with an UNPINNED `CODEX_HOME`.
 * The very first spawn each launch fell back to codex's default (`~/.codex`),
 * while a later provider switch (`restartCodex`) flipped it to
 * `<userData>/codex-runtime`. Rollouts written after a switch therefore landed
 * in `codex-runtime` and became unfindable on the next launch's fresh
 * (`~/.codex`) spawn — `thread/resume` looked in the wrong `CODEX_HOME` and the
 * chat lost its memory. We now pin `CODEX_HOME` to one stable home; this copies
 * any orphaned `codex-runtime` rollouts into that home so old chats stay
 * resumable.
 *
 * codex stores rollouts at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * (openai/codex `find_codex_home` + official docs), so we preserve that relative
 * structure and never clobber a destination that already exists. `codex-runtime`
 * is 100% app-created, so copying OUT of it is safe — unlike touching the user's
 * personal `~/.codex` CLI history. Fully best-effort: per-file errors are
 * swallowed and counted as skipped.
 */
export async function migrateLegacyCodexSessions(
  input: MigrateLegacySessionsInput,
): Promise<MigrateLegacySessionsResult> {
  const result: MigrateLegacySessionsResult = { moved: 0, skipped: 0 }
  const legacy = path.resolve(input.legacySessionsDir)
  const target = path.resolve(input.targetSessionsDir)
  // When the user pinned CODEX_HOME to the per-app runtime dir there is nothing
  // to migrate (source === destination).
  if (legacy === target) return result

  let rollouts: string[]
  try {
    rollouts = await collectRollouts(legacy)
  } catch {
    // Legacy dir missing / unreadable → first-ever launch or already consolidated.
    return result
  }

  for (const absSource of rollouts) {
    const rel = path.relative(legacy, absSource)
    const dest = path.join(target, rel)
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true })
      // COPYFILE_EXCL makes copyFile fail when the destination already exists,
      // so a rollout already present in the pinned home is never overwritten.
      await fs.copyFile(absSource, dest, fsConstants.COPYFILE_EXCL)
      result.moved += 1
    } catch {
      result.skipped += 1
    }
  }
  return result
}

async function collectRollouts(dir: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(abs)
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        out.push(abs)
      }
    }
  }
  return out
}
