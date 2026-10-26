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
  CATIMATION_SUBAGENTS_SKILL_CONTENT,
  CATIMATION_UNDERSTAND_SKILL_CONTENT,
  CATIMATION_VIDEO_SKILL_CONTENT,
  CATIMATION_VIDEO_WORKBENCH_SKILL_CONTENT,
  FFMPEG_WIN_SKILL_CONTENT,
  GRAPHIFY_SKILL_CONTENT,
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
  /**
   * Bundled resources shipped beside SKILL.md, keyed by POSIX-relative path
   * (`references/models.md`). Codex pulls SKILL.md into context on every
   * trigger but reads these only when the body points at them, so anything a
   * common request does not need belongs here rather than inline.
   */
  files?: Readonly<Record<string, string>>
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
// A plugin/marketplace install replaces the whole skill directory and with it the
// managed marker, so the skills listed below are the exceptions: a markerless copy
// whose normalized hash is listed here is proven unedited, hence safe to adopt and
// refresh.
//
// MAINTENANCE RULE (append-only; enforced by firstPartySkills.test.ts): whenever the
// SKILL.md of a listed skill changes, append the hash of the NEW content in the same
// change. Every version is then registered before it becomes "history". Skipping this
// strands anyone whose marketplace copy is older than the app: their copy matches
// neither the shipped content nor this list, so it is treated as user-owned and never
// updated again. (ffmpeg-win's list once stopped at 2026-07-10 and silently missed
// the 07-15 and 08-09 versions — that is the failure the test now prevents.)
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
      // Backfilled once the maintenance rule above was enforced: the versions after
      // dcba09ba that were never registered, up to the current content.
      // 5af50fcb (2026-07-15) → e46d8f12 (2026-08-09) → 97fd6e33 (2026-09-20, current).
      'dbfb8345e1c703459696a7bf7b8a7904f529eb9eb23c3dc9fca79901121d934e',
      '3485332f75ee1e4b5b2134511da69a1733cf0bfc0ae229bcf7ea7303656d5eed',
      'c334e7b2c7883a6d06c0a0f0c82ae207ca61cec36cd9b27136024dbd58d1bef6',
    ]),
  ],
  [
    // `catimation-video-workbench` was generated since #178 (2026-08-01) but never
    // listed in FIRST_PARTY_SKILLS, so until it was wired in, the only way to get it
    // was the plugin/skill marketplace — which writes the file WITHOUT a managed
    // marker. Every version below is a byte-exact earlier state of
    // resources/plugins/catimation-video/skills/catimation-video-workbench/SKILL.md
    // (a real markerless copy found on a user machine, dated 2026-09-24, matched
    // the 2026-09-24 version byte for byte). A match proves the copy is unedited,
    // so it is safe to adopt and refresh; anything else stays user-owned.
    //
    // Append the hash of the new content whenever SKILL.md changes (see the
    // maintenance rule above). The content currently shipped also matches directly
    // in canAdoptUnmarkedCopy, but it is listed too so that it is already registered
    // by the time the next change turns it into history.
    'catimation-video-workbench',
    new Set([
      // 30a573bf (#178, original) → 02f94dc7 → 3b800dcd → 912776d3 (2026-08-01)
      'c1d20cd55a877eacbd84a41588a9162bbfd012954ccd2770992f6e6a3f1a929a',
      'dda10fdb0b7d5f993d138ff03fabc5c88e328040c2d180671a17efa6e8719b0f',
      '8faeaae5b1791d9305747e34f7925dff71aab61aaa6db26dc51e2f57ab593e53',
      '9805eb7d48c6e52c6fce19b8bcac51f73c59e40ece3376d5999ac987abfdeb8f',
      // cac5a7c2 → 1f9544f8 (2026-08-03) → 3c0f0ae9 (08-04)
      '1a2ee1e3f400cd2a39c99d6ac5b2a690211522340b9be0392998ccdafc97f28c',
      'b0740a981425559f98775a0c19cfb1cc2e9f8d45454ecf5de15460a8802130c4',
      'ca55394957f39202198929d9c0c3a4d8c33e6a4f1db916b4ac4cda0ff2e31f0a',
      // cebd3139 → 1efa7269 (2026-08-10) → 4d41e4f6 (08-15)
      '167b76a591dbd6aa1924693c0b7e3de5a8e70ee190f9e8ad18183aa72578ff56',
      '308d1a4fd535d3f351d9c5d23ba28b1d78acf67f67c0ea5e959e6708e1af97dd',
      '8f77c5b0a5388d3c558e4b02de9fcca8808c7808f8feb67e41635264687fc05e',
      // 8563bb44 (2026-09-06) → 9ed7b9db (09-24) → 16643036 (10-26, last before #367)
      '3982094b57e574f253392bd504596b1587daea7b8cfc7cab1b90ae23a58e5814',
      'cde4a5b41cedb280065dc5ee9a8bdc412e26c8d21e293ff2ee055634bcfcacd2',
      'fa07ef8c898b21736706cbd9562d9d06ce67991282e881672ab02348692c44b7',
      // fa9f737e (#367, 2026-10-26) — current.
      '5e8414d7a33f53c0be2c5b06065c0aa166e2cb45adeb7ffdca223c1ea65ad981',
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

/**
 * Marker layout. Line 0 is the SKILL.md hash — unchanged from the single-line
 * format older builds wrote, so their installs stay recognizable. Lines 1+
 * inventory the bundled files WE wrote (`<sha256>  <relative/path>`), which is
 * what lets a later run tell "the user rewrote this" from "we shipped a new
 * version" and retire files we stopped shipping without globbing the folder.
 */
interface ManagedMarker {
  skillHash: string
  files: Map<string, string>
}

function parseMarker(raw: string | null): ManagedMarker | null {
  if (raw === null) return null
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  const files = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/)
    if (match) files.set(match[2], match[1])
  }
  return { skillHash: lines[0], files }
}

function formatMarker(skillHash: string, files: ReadonlyMap<string, string>): string {
  const lines = [skillHash]
  for (const rel of [...files.keys()].sort()) lines.push(`${files.get(rel)}  ${rel}`)
  return `${lines.join('\n')}\n`
}

/**
 * Bundled paths are generated, not user input — but a traversal here would
 * write anywhere under the user's home, so it is worth one cheap assertion.
 */
function assertContainedPath(skillName: string, rel: string): void {
  const segments = rel.split(/[\\/]/)
  const escapes =
    rel.length === 0 ||
    path.posix.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)
  if (escapes) {
    throw new Error(`${skillName}: bundled path "${rel}" would escape the skill directory`)
  }
}

function bundledTarget(dir: string, rel: string): string {
  return path.join(dir, ...rel.split('/'))
}

/**
 * A bundled file on disk is ours to overwrite only when it still hashes to what
 * we last wrote. Anything else — hand-edited, or created by the user before we
 * ever shipped that path — belongs to them and is left alone forever after.
 */
function isOursToOverwrite(
  onDisk: string,
  shipped: string,
  recorded: string | undefined,
): boolean {
  const onDiskHash = sha256(onDisk)
  return recorded !== undefined ? onDiskHash === recorded : onDiskHash === sha256(shipped)
}

async function writeManaged(
  dir: string,
  skill: FirstPartySkill,
  previous: ManagedMarker | null,
): Promise<void> {
  const shipped = skill.files ?? {}
  for (const rel of Object.keys(shipped)) assertContainedPath(skill.name, rel)

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), skill.content, 'utf8')

  const inventory = new Map<string, string>()
  for (const [rel, content] of Object.entries(shipped)) {
    const target = bundledTarget(dir, rel)
    const onDisk = await readFileOrNull(target)
    if (onDisk !== null && !isOursToOverwrite(onDisk, content, previous?.files.get(rel))) {
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    inventory.set(rel, sha256(content))
  }

  // Retire files we shipped before but no longer do, so the body never points
  // at a stale doc. Only ones still matching our recorded hash — a file the
  // user took over is theirs to keep.
  for (const [rel, hash] of previous?.files ?? []) {
    if (rel in shipped) continue
    const target = bundledTarget(dir, rel)
    const onDisk = await readFileOrNull(target)
    if (onDisk === null || sha256(onDisk) !== hash) continue
    await fs.rm(target, { force: true })
  }

  await fs.writeFile(
    path.join(dir, MANAGED_MARKER),
    formatMarker(sha256(skill.content), inventory),
    'utf8',
  )
}

/** True when every bundled file is already in the state a rewrite would leave it. */
async function bundledFilesSettled(
  dir: string,
  skill: FirstPartySkill,
  previous: ManagedMarker | null,
): Promise<boolean> {
  const shipped = skill.files ?? {}
  for (const [rel, content] of Object.entries(shipped)) {
    const onDisk = await readFileOrNull(bundledTarget(dir, rel))
    if (onDisk === null) return false
    if (sha256(onDisk) === sha256(content)) continue
    // Differs from what we ship — fine only if the file is the user's, since
    // then a rewrite would skip it anyway.
    if (isOursToOverwrite(onDisk, content, previous?.files.get(rel))) return false
  }

  for (const [rel, hash] of previous?.files ?? []) {
    if (rel in shipped) continue
    const onDisk = await readFileOrNull(bundledTarget(dir, rel))
    if (onDisk !== null && sha256(onDisk) === hash) return false
  }
  return true
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
      await writeManaged(dir, skill, null)
      report.installed.push(skill.name)
      continue
    }

    const managed = parseMarker(await readFileOrNull(path.join(dir, MANAGED_MARKER)))
    const isAppManaged = managed !== null && managed.skillHash === sha256(existing)

    if (
      !isAppManaged &&
      managed === null &&
      canAdoptUnmarkedCopy(skill, existing, knownUnmarkedSkillHashes)
    ) {
      await writeManaged(dir, skill, null)
      report.updated.push(skill.name)
      continue
    }

    if (!isAppManaged) {
      report.preserved.push(skill.name)
      continue
    }

    if (
      sha256(existing) === sha256(skill.content) &&
      (await bundledFilesSettled(dir, skill, managed))
    ) {
      // Already up to date.
      continue
    }

    await writeManaged(dir, skill, managed)
    report.updated.push(skill.name)
  }

  const activeNames = new Set(skills.map((s) => s.name))
  for (const name of RETIRED_FIRST_PARTY_SKILL_NAMES) {
    if (activeNames.has(name)) continue
    const dir = path.join(options.officialRoot, name)
    const existing = await readFileOrNull(path.join(dir, 'SKILL.md'))
    if (existing === null) continue

    const managed = parseMarker(await readFileOrNull(path.join(dir, MANAGED_MARKER)))
    const isAppManaged = managed !== null && managed.skillHash === sha256(existing)
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

export const CATIMATION_SUBAGENTS_SKILL: FirstPartySkill = {
  name: 'catimation-subagents',
  content: CATIMATION_SUBAGENTS_SKILL_CONTENT,
}

/**
 * The video workbench is an in-app surface and the embedded agent that drives it
 * has no session hook — it only ever sees SKILL.md — so the skill has to be
 * present on every install, not only for users who happened to add it from the
 * marketplace. Single file by design: `writeManaged` ships only SKILL.md.
 */
export const CATIMATION_VIDEO_WORKBENCH_SKILL: FirstPartySkill = {
  name: 'catimation-video-workbench',
  content: CATIMATION_VIDEO_WORKBENCH_SKILL_CONTENT,
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
 * Code/folder → knowledge graph via the graphify CLI (tree-sitter AST, local).
 * Shares its name with the official skill so a user-installed
 * `~/.agents/skills/graphify` (from `graphify install --platform agents`) is
 * preserved by the hash check rather than duplicated.
 */
export const GRAPHIFY_SKILL: FirstPartySkill = {
  name: 'graphify',
  content: GRAPHIFY_SKILL_CONTENT,
}

/**
 * First-party skills no longer shipped by default. If an older app version
 * installed an app-managed copy, remove it on startup so Codex stops discovering
 * it. User-edited copies are preserved.
 */
const RETIRED_FIRST_PARTY_SKILL_NAMES = ['mediakit-cli']

/** All skills this app ships into the Codex USER scope on startup. */
export const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  CATIMATION_IMAGE_SKILL,
  CATIMATION_VIDEO_SKILL,
  CATIMATION_VIDEO_WORKBENCH_SKILL,
  CATIMATION_AUDIO_SKILL,
  CATIMATION_PORTRAIT_LIBRARY_SKILL,
  CATIMATION_BRAINSTORM_SKILL,
  CATIMATION_CANVAS_SKILL,
  CATIMATION_UNDERSTAND_SKILL,
  CATIMATION_SUBAGENTS_SKILL,
  CATIMATION_FFMPEG_WIN_SKILL,
  CATIMATION_DIRECTOR_STAGE_SKILL,
  GRAPHIFY_SKILL,
]
