import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

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
}

export interface FirstPartySkillReport {
  /** Skill names freshly created (folder/SKILL.md did not exist). */
  installed: string[]
  /** App-managed skills refreshed to a newer shipped version. */
  updated: string[]
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
  const report: FirstPartySkillReport = { installed: [], updated: [], preserved: [] }

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

  return report
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

// ---------------------------------------------------------------------------
// Shipped skills
// ---------------------------------------------------------------------------

const CATIMATION_IMAGE_SKILL_CONTENT = `---
name: catimation-image
description: >-
  Generate an image, picture, illustration, poster, icon, or any visual from a
  text prompt inside the CATIMATION desktop app. Use this whenever the user asks
  to generate / create / draw / make / render an image or picture or
  illustration, or says 生成图片 / 画一张 / 配图 / 出图 / 来张图, or wants a visual produced
  from a description, or wants to edit / restyle a reference image. Renders
  through the in-app \`generate_image\` tool (the \`catimation\` MCP server) on the
  stable gpt-image-2-vip channel, shows the result directly in the chat, and
  saves it to the app's history page and file panel — capabilities a built-in
  image generator does not have. Always prefer the \`generate_image\` tool here;
  do not look for or call a built-in image_gen tool.
---

# Generate images in CATIMATION

When the user wants an image, call the **\`generate_image\`** tool (provided by the
\`catimation\` MCP server). It is the only image path that renders inside the chat
and persists the result to the app's history page and ATTACHMENTS file panel.

## Steps

1. Turn the request into one clear, descriptive prompt. Cover subject, style,
   composition, lighting, and mood. Keep it concise.
2. Call \`generate_image\` with:
   - \`prompt\` (required): the description from step 1.
   - \`ratio\` (optional): aspect ratio, e.g. \`1:1\`, \`16:9\`, \`9:16\`, \`4:3\`, \`3:2\`.
     Omit or \`auto\` lets the model decide.
   - \`resolution\` (optional): clarity tier — \`1K\` (fast, default), \`2K\`
     (recommended), or \`4K\` (print detail).
   - \`quality\` (optional): \`auto\` (default), \`low\`, \`medium\`, or \`high\`. Use
     \`high\` for images with text or fine detail.
   - \`referenceImages\` (optional): array of data URLs or file paths for
     image-to-image / editing.
   - Do **not** pass \`model\` — the channel is fixed to \`gpt-image-2-vip\`.
3. The tool returns a compact summary like \`{ ok, count, model }\`. The image is
   shown to the user automatically and saved to history — you do **not** need to
   embed, re-describe, or base64 the pixels. Just confirm briefly in the user's
   language.

## Notes

- For edits, image-to-image, or multi-image prompts, still use \`generate_image\`
  with \`referenceImages\`; it handles the in-app channel and persistence.
- If \`generate_image\` is genuinely unavailable in this session, you may fall back
  to whatever image tool you do have — but \`generate_image\` is the preferred,
  in-app path that actually displays and saves the result.
`

export const CATIMATION_IMAGE_SKILL: FirstPartySkill = {
  name: 'catimation-image',
  content: CATIMATION_IMAGE_SKILL_CONTENT,
}

/** All skills this app ships into the Codex USER scope on startup. */
export const FIRST_PARTY_SKILLS: FirstPartySkill[] = [CATIMATION_IMAGE_SKILL]
