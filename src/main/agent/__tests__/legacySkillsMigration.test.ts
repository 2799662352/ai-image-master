import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { migrateLegacyUserSkills } from '../legacySkillsMigration'

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'codex-legacy-migrate-'))
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// We migrate skills from this app's pre-Codex `<userData>/skills` location
// to the Codex-official `$HOME/.agents/skills` location so the Codex CLI's
// skill registry actually picks them up at session start. The migration
// must be:
//   - copy (not move), so an unexpected crash mid-migration never destroys
//     user data;
//   - non-overwriting, so an existing official-scope skill always wins;
//   - idempotent, so we can safely run it on every launch.

describe('migrateLegacyUserSkills', () => {
  it('copies skills with SKILL.md from legacy root to official USER root', async () => {
    const legacy = await makeTempDir()
    const official = await makeTempDir()
    const skillDir = path.join(legacy, 'trailer-plan-generator')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: trailer-plan-generator\n---\nbody',
      'utf8',
    )
    await mkdir(path.join(skillDir, 'references'), { recursive: true })
    await writeFile(path.join(skillDir, 'references', 'a.md'), 'ref', 'utf8')

    const report = await migrateLegacyUserSkills({ legacyRoot: legacy, officialRoot: official })

    expect(report.copied).toEqual(['trailer-plan-generator'])
    expect(report.skipped).toEqual([])
    const copiedSkill = path.join(official, 'trailer-plan-generator', 'SKILL.md')
    expect(await exists(copiedSkill)).toBe(true)
    expect((await readFile(copiedSkill, 'utf8')).trim()).toContain('trailer-plan-generator')
    expect(await exists(path.join(official, 'trailer-plan-generator', 'references', 'a.md'))).toBe(
      true,
    )

    // Legacy copy left in place — non-destructive, user can clean up later.
    expect(await exists(path.join(skillDir, 'SKILL.md'))).toBe(true)
  })

  it('skips skills whose target already exists at official root (USER wins)', async () => {
    const legacy = await makeTempDir()
    const official = await makeTempDir()
    await mkdir(path.join(legacy, 'shared'), { recursive: true })
    await writeFile(path.join(legacy, 'shared', 'SKILL.md'), 'LEGACY VERSION', 'utf8')
    await mkdir(path.join(official, 'shared'), { recursive: true })
    await writeFile(path.join(official, 'shared', 'SKILL.md'), 'OFFICIAL VERSION', 'utf8')

    const report = await migrateLegacyUserSkills({ legacyRoot: legacy, officialRoot: official })

    expect(report.copied).toEqual([])
    expect(report.skipped).toContain('shared')
    expect((await readFile(path.join(official, 'shared', 'SKILL.md'), 'utf8'))).toBe(
      'OFFICIAL VERSION',
    )
  })

  it('ignores entries that are not directories or lack SKILL.md', async () => {
    const legacy = await makeTempDir()
    const official = await makeTempDir()
    // A loose file at the root, not a skill folder.
    await writeFile(path.join(legacy, 'note.txt'), 'hi', 'utf8')
    // A dir without SKILL.md — malformed skill, ignore.
    await mkdir(path.join(legacy, 'incomplete'), { recursive: true })

    const report = await migrateLegacyUserSkills({ legacyRoot: legacy, officialRoot: official })

    expect(report.copied).toEqual([])
    expect(report.skipped).toEqual([])
    expect(await exists(path.join(official, 'incomplete'))).toBe(false)
    expect(await exists(path.join(official, 'note.txt'))).toBe(false)
  })

  it('returns an empty report when the legacy root does not exist (fresh install)', async () => {
    const official = await makeTempDir()
    const report = await migrateLegacyUserSkills({
      legacyRoot: path.join(official, 'does-not-exist'),
      officialRoot: official,
    })
    expect(report).toEqual({ copied: [], skipped: [] })
  })

  it('is idempotent — second run is a no-op because targets exist', async () => {
    const legacy = await makeTempDir()
    const official = await makeTempDir()
    await mkdir(path.join(legacy, 'demo'), { recursive: true })
    await writeFile(path.join(legacy, 'demo', 'SKILL.md'), 'D', 'utf8')

    const first = await migrateLegacyUserSkills({ legacyRoot: legacy, officialRoot: official })
    expect(first.copied).toEqual(['demo'])

    const second = await migrateLegacyUserSkills({ legacyRoot: legacy, officialRoot: official })
    expect(second.copied).toEqual([])
    expect(second.skipped).toContain('demo')
  })

  // Regression — bundled-Codex-skills mirror path. The same helper is reused
  // a second time at startup with `legacyRoot = <resources>/codex-skills` to
  // ship `codex-research-grounded-prompting` (and any future bundled USER-
  // scope skills) into `$HOME/.agents/skills/`. Behavior contract:
  //   1. Multi-file skills (SKILL.md + references/*) copy fully on first run.
  //   2. User edits to the mirrored copy survive subsequent launches because
  //      the helper is directory-level non-overwriting. This is what makes
  //      the user-scope choice meaningful — without it, every install would
  //      clobber the user's customizations.
  it('mirrors bundled codex skills into USER scope and preserves user edits on re-mirror', async () => {
    const bundled = await makeTempDir()
    const official = await makeTempDir()
    const skillName = 'codex-research-grounded-prompting'
    const skillSrc = path.join(bundled, skillName)
    await mkdir(path.join(skillSrc, 'references'), { recursive: true })
    await writeFile(
      path.join(skillSrc, 'SKILL.md'),
      `---\nname: ${skillName}\n---\nBUNDLED BODY`,
      'utf8',
    )
    await writeFile(
      path.join(skillSrc, 'references', 'methodology-rationale.md'),
      'BUNDLED RATIONALE',
      'utf8',
    )
    await writeFile(path.join(skillSrc, 'references', 'papers.md'), 'BUNDLED PAPERS', 'utf8')

    const first = await migrateLegacyUserSkills({ legacyRoot: bundled, officialRoot: official })
    expect(first.copied).toEqual([skillName])
    const mirroredSkill = path.join(official, skillName, 'SKILL.md')
    const mirroredRationale = path.join(official, skillName, 'references', 'methodology-rationale.md')
    const mirroredPapers = path.join(official, skillName, 'references', 'papers.md')
    expect(await exists(mirroredSkill)).toBe(true)
    expect(await exists(mirroredRationale)).toBe(true)
    expect(await exists(mirroredPapers)).toBe(true)

    // User customizes their mirrored copy.
    await writeFile(mirroredSkill, 'USER EDITED BODY', 'utf8')

    // Next launch: re-mirror. User's edit must survive — directory exists
    // therefore the helper short-circuits at the directory level.
    const second = await migrateLegacyUserSkills({ legacyRoot: bundled, officialRoot: official })
    expect(second.copied).toEqual([])
    expect(second.skipped).toContain(skillName)
    expect(await readFile(mirroredSkill, 'utf8')).toBe('USER EDITED BODY')
  })
})
