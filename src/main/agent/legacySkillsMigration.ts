import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * One-shot migration: copy AI-created skills sitting at this app's pre-Codex
 * `<userData>/skills` root into the Codex-official `$HOME/.agents/skills`
 * location so the Codex CLI's skill registry actually picks them up at
 * session start.
 *
 * Why copy (not move):
 *   The legacy folder may still be referenced by other code paths (the
 *   `legacyUserSkillsRoots` scanner in `codexConfigDiscovery` /
 *   `codexConfigStore`) and we don't want a crash mid-migration to destroy
 *   user data. Users can delete the legacy folder themselves once they
 *   confirm everything is in place.
 *
 * Why non-overwriting:
 *   If a user already curated a skill at the official location, that
 *   version always wins. Re-running this helper is a no-op (idempotent).
 *
 * Discovery rule:
 *   An entry under `legacyRoot` is treated as a skill folder iff it is a
 *   directory containing a `SKILL.md` file. Loose files at `legacyRoot`
 *   and dirs without `SKILL.md` are ignored.
 */
export interface MigrateLegacyUserSkillsOptions {
  legacyRoot: string
  officialRoot: string
}

export interface MigrationReport {
  /** Skill folder names successfully copied to the official root. */
  copied: string[]
  /** Skill folder names skipped because the target already existed. */
  skipped: string[]
}

export async function migrateLegacyUserSkills({
  legacyRoot,
  officialRoot,
}: MigrateLegacyUserSkillsOptions): Promise<MigrationReport> {
  const report: MigrationReport = { copied: [], skipped: [] }

  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(legacyRoot, { withFileTypes: true })
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return report
    throw err
  }

  await fs.mkdir(officialRoot, { recursive: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourceDir = path.join(legacyRoot, entry.name)
    const sourceSkill = path.join(sourceDir, 'SKILL.md')
    try {
      await fs.access(sourceSkill)
    } catch {
      // Malformed legacy folder (no SKILL.md) — skip silently.
      continue
    }

    const targetDir = path.join(officialRoot, entry.name)
    let targetExists = false
    try {
      await fs.access(targetDir)
      targetExists = true
    } catch {
      targetExists = false
    }

    if (targetExists) {
      report.skipped.push(entry.name)
      continue
    }

    await copyDirRecursive(sourceDir, targetDir)
    report.copied.push(entry.name)
  }

  return report
}

async function copyDirRecursive(source: string, target: string): Promise<void> {
  // Node 16.7+ ships `fs.cp` with `recursive: true`; using it avoids a hand-
  // rolled walker that needs to handle symlinks, perms, and Windows quirks.
  // `errorOnExist: false` keeps the helper non-overwriting at the *file*
  // level too — but since we gate at the directory level above, no individual
  // file conflict should ever fire.
  await fs.cp(source, target, { recursive: true, errorOnExist: false, force: false })
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
