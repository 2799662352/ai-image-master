import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

import {
  CATIMATION_AUDIO_SKILL_CONTENT,
  CATIMATION_BRAINSTORM_SKILL_CONTENT,
  CATIMATION_CANVAS_SKILL_CONTENT,
  CATIMATION_DIRECTOR_STAGE_SKILL_CONTENT,
  CATIMATION_IMAGE_SKILL_CONTENT,
  CATIMATION_PORTRAIT_LIBRARY_SKILL_CONTENT,
  CATIMATION_UNDERSTAND_SKILL_CONTENT,
  CATIMATION_VIDEO_SKILL_CONTENT,
  FFMPEG_WIN_SKILL_CONTENT,
} from './generated/firstPartySkills.generated'

/**
 * First-party "system" skills that this app always ships into the Codex USER
 * skill scope (`$HOME/.agents/skills/<name>/SKILL.md`).
 *
 * Codex itself only ships *binary-embedded* `.system` skills (re-extracted to
 * `$CODEX_HOME/skills/.system` and wiped per binary version — see
 * `codex-rs/skills/src/lib.rs::install_system_skills`), so we cannot add to
 * that set without rebuilding Codex. The app-controlled equivalent of a
 * "system skill" is a skill we guarantee is present in the USER scope that
 * Codex natively discovers (the same place `save-skill` writes — required so
 * the model actually sees it, per openai/codex#21524). That scope is also what
 * the in-app skills panel lists, so the skill shows up there too.
 *
 * SINGLE SOURCE OF TRUTH: skill contents are NOT authored here. They live as
 * Markdown —
 *   - shared skills (also shipped via the plugin marketplace):
 *     `resources/plugins/<plugin>/skills/<name>/SKILL.md`;
 *   - app-only skills: `resources/first-party-skills/<name>/SKILL.md`.
 * `scripts/generate-first-party-skills.mjs` compiles them into
 * `./generated/firstPartySkills.generated.ts`, which this module re-packages.
 * Never edit the generated file (or inline content here) by hand.
 *
 * Authoring follows the Codex skill spec (`/openai/codex` skill-creator):
 *   - frontmatter has ONLY `name` (lowercase/numbers/hyphens, <= 64 chars) and
 *     `description`;
 *   - `description` is the sole triggering signal, so every "use when" cue must
 *     live there (the body is loaded only AFTER the skill triggers);
 *   - the body is imperative instructions.
 */
export interface FirstPartySkill {
  /** Folder name + frontmatter `name`. Lowercase, numbers, hyphens. */
  name: string
  /** Full SKILL.md contents (frontmatter + body). */
  content: string
}

export interface InstallFirstPartySkillsOptions {
  /** `$HOME/.agents/skills` — the Codex-official USER skill root. */
  officialRoot: string
  /** Override the shipped set (tests). Defaults to {@link FIRST_PARTY_SKILLS}. */
  skills?: FirstPartySkill[]
  /** Override the safe legacy-adoption allowlist (tests). */
  knownUnmarkedSkillHashes?: ReadonlyMap<string, ReadonlySet<string>>
}

export interface FirstPartySkillReport {
  /** Skill names freshly created (folder/SKILL.md did not exist). */
  installed: string[]
  /** App-managed skills refreshed to a newer shipped version. */
  updated: string[]
  /** App-managed skills removed because this app no longer ships them. */
  removed: string[]
  /** Skills left untouched because the user hand-edited them. */
  preserved: string[]
}

// Sidecar file recording the sha256 of the content WE last wrote. Codex skill
// discovery only treats `SKILL.md` as a skill and ignores everything else, and
// the dot prefix keeps it out of any directory listing that filters dotfiles —
// so this marker never registers as a skill of its own. When the on-disk
// SKILL.md still hashes to this value, the copy is app-managed and we may ship
// updates; if it differs, the user edited it and we never clobber their work.
const MANAGED_MARKER = '.catimation-managed'

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizedSha256(text: string): string {
  return sha256(text.replace(/\r\n/g, '\n'))
}

// Markerless copies are normally user-owned and must never be overwritten.
// `ffmpeg-win` is the one historical exception: before the managed sidecar was
// introduced it was distributed through the app/skills installer in these
// exact canonical forms. Matching normalized hashes prove the file was not
// edited, so it is safe to adopt and refresh. Keep this allowlist append-only.
export const KNOWN_UNMARKED_FIRST_PARTY_SKILL_HASHES: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  [
    'ffmpeg-win',
    new Set([
      // 8c432db2 → dcba09ba (marketplace v1.0.0 through the
      // single-entry orchestration refactor).
      'c24cfd4c15b9c459ab31d3eb85d42b2d4fa8b36ae0eacfc316f738fbe6a477a0',
      'c8ff5fb98e6d5ed89a11390f7308cd3152130a60f4261b0b8ea1c26f81473a3c',
      '1afaace17075bc49d9ca01beda16ebbf99dcea6c06e842a9769e829877fc8ae5',
      '524d07e412b5621030b4f3cac79b0fe57017115910456a6acc5ee36a7f493a83',
      'afea328a3370ca2b6006da3e75c16261e35e4172a36058f02ca5d4053ab4661a',
      'a21c9b2c7dacdccc92c96ab6c73219221ad95a0b0cf1b58e3ad656990925a557',
      'b21308a1232e11a7d8fc678ca2340d75a4fee0e8aedeed978c95f21a38da7840',
    ]),
  ],
])

function canAdoptUnmarkedCopy(
  skill: FirstPartySkill,
  existing: string,
  knownHashes: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const existingHash = normalizedSha256(existing)
  if (existingHash === normalizedSha256(skill.content)) return true
  return knownHashes.get(skill.name)?.has(existingHash) ?? false
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null
    throw err
  }
}

async function writeManaged(dir: string, skill: FirstPartySkill): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), skill.content, 'utf8')
  await fs.writeFile(path.join(dir, MANAGED_MARKER), `${sha256(skill.content)}\n`, 'utf8')
}

/**
 * Install (or update) the app's first-party skills into the Codex USER scope.
 *
 * Idempotent and non-destructive:
 *   - missing            → install + write managed marker;
 *   - present & managed  → rewrite only if the shipped content changed;
 *   - present & edited   → preserve (user wins).
 */
export async function installFirstPartySkills(
  options: InstallFirstPartySkillsOptions,
): Promise<FirstPartySkillReport> {
  const skills = options.skills ?? FIRST_PARTY_SKILLS
  const knownUnmarkedSkillHashes =
    options.knownUnmarkedSkillHashes ?? KNOWN_UNMARKED_FIRST_PARTY_SKILL_HASHES
  const report: FirstPartySkillReport = { installed: [], updated: [], removed: [], preserved: [] }

  await fs.mkdir(options.officialRoot, { recursive: true })

  for (const skill of skills) {
    const dir = path.join(options.officialRoot, skill.name)
    const existing = await readFileOrNull(path.join(dir, 'SKILL.md'))

    if (existing === null) {
      await writeManaged(dir, skill)
      report.installed.push(skill.name)
      continue
    }

    const marker = (await readFileOrNull(path.join(dir, MANAGED_MARKER)))?.trim() ?? null
    const isAppManaged = marker !== null && marker === sha256(existing)

    if (
      !isAppManaged &&
      marker === null &&
      canAdoptUnmarkedCopy(skill, existing, knownUnmarkedSkillHashes)
    ) {
      await writeManaged(dir, skill)
      report.updated.push(skill.name)
      continue
    }

    if (!isAppManaged) {
      report.preserved.push(skill.name)
      continue
    }

    if (sha256(existing) === sha256(skill.content)) {
      // Already up to date.
      continue
    }

    await writeManaged(dir, skill)
    report.updated.push(skill.name)
  }

  const activeNames = new Set(skills.map((s) => s.name))
  for (const name of RETIRED_FIRST_PARTY_SKILL_NAMES) {
    if (activeNames.has(name)) continue
    const dir = path.join(options.officialRoot, name)
    const existing = await readFileOrNull(path.join(dir, 'SKILL.md'))
    if (existing === null) continue

    const marker = (await readFileOrNull(path.join(dir, MANAGED_MARKER)))?.trim() ?? null
    const isAppManaged = marker !== null && marker === sha256(existing)
    if (!isAppManaged) {
      report.preserved.push(name)
      continue
    }

    await fs.rm(dir, { recursive: true, force: true })
    report.removed.push(name)
  }

  return report
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

// ---------------------------------------------------------------------------
// Shipped skills (contents generated from Markdown — see header comment)
// ---------------------------------------------------------------------------

export const CATIMATION_IMAGE_SKILL: FirstPartySkill = {
  name: 'catimation-image',
  content: CATIMATION_IMAGE_SKILL_CONTENT,
}

export const CATIMATION_VIDEO_SKILL: FirstPartySkill = {
  name: 'catimation-video',
  content: CATIMATION_VIDEO_SKILL_CONTENT,
}

export const CATIMATION_AUDIO_SKILL: FirstPartySkill = {
  name: 'catimation-audio',
  content: CATIMATION_AUDIO_SKILL_CONTENT,
}

export const CATIMATION_PORTRAIT_LIBRARY_SKILL: FirstPartySkill = {
  name: 'catimation-portrait-library',
  content: CATIMATION_PORTRAIT_LIBRARY_SKILL_CONTENT,
}

export const CATIMATION_BRAINSTORM_SKILL: FirstPartySkill = {
  name: 'catimation-brainstorm',
  content: CATIMATION_BRAINSTORM_SKILL_CONTENT,
}

export const CATIMATION_CANVAS_SKILL: FirstPartySkill = {
  name: 'catimation-canvas',
  content: CATIMATION_CANVAS_SKILL_CONTENT,
}

export const CATIMATION_UNDERSTAND_SKILL: FirstPartySkill = {
  name: 'catimation-understand',
  content: CATIMATION_UNDERSTAND_SKILL_CONTENT,
}

export const CATIMATION_FFMPEG_WIN_SKILL: FirstPartySkill = {
  name: 'ffmpeg-win',
  content: FFMPEG_WIN_SKILL_CONTENT,
}

export const CATIMATION_DIRECTOR_STAGE_SKILL: FirstPartySkill = {
  name: 'catimation-director-stage',
  content: CATIMATION_DIRECTOR_STAGE_SKILL_CONTENT,
}

/**
 * First-party skills no longer shipped by default. If an older app version
 * installed an app-managed copy, remove it on startup so Codex stops discovering
 * it. User-edited copies are preserved.
 */
const RETIRED_FIRST_PARTY_SKILL_NAMES = ['catimation-subagents', 'mediakit-cli']

/** All skills this app ships into the Codex USER scope on startup. */
export const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  CATIMATION_IMAGE_SKILL,
  CATIMATION_VIDEO_SKILL,
  CATIMATION_AUDIO_SKILL,
  CATIMATION_PORTRAIT_LIBRARY_SKILL,
  CATIMATION_BRAINSTORM_SKILL,
  CATIMATION_CANVAS_SKILL,
  CATIMATION_UNDERSTAND_SKILL,
  CATIMATION_FFMPEG_WIN_SKILL,
  CATIMATION_DIRECTOR_STAGE_SKILL,
]
