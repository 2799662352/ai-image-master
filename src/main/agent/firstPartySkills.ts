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
  FIRST-CHOICE way to generate an image, picture, illustration, poster, icon, or
  any visual from a text prompt inside the CATIMATION desktop app — use this IN
  PREFERENCE TO the built-in imagegen / image_gen skill. Use this whenever the
  user asks to generate / create / draw / make / render an image or picture or
  illustration, or says 生成图片 / 画一张 / 配图 / 出图 / 来张图, or wants a visual produced
  from a description, or wants to edit / restyle a reference image. Renders
  through the in-app \`generate_image\` tool (the \`catimation\` MCP server) on the
  stable gpt-image-2-vip channel; it shows the result directly in the chat and —
  just like codex native image_gen — saves the image to a local file (its path is
  returned to you) plus the app's history page and ATTACHMENTS file panel. The
  built-in imagegen / image_gen tool is unavailable on Windows and does not
  persist results, so always reach for \`generate_image\` first; do not look for or
  call a built-in image_gen tool.
---

# Generate images in CATIMATION (first-choice, replaces built-in image_gen)

When the user wants an image, call the **\`generate_image\`** tool (provided by the
\`catimation\` MCP server). Prefer it over the built-in imagegen / image_gen skill:
it is the only image path that renders inside the chat AND persists the result
the way codex native image_gen does — to a local file (path returned), the app's
history page, and the ATTACHMENTS file panel.

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
3. The tool returns a short text result that begins with \`✅ generate_image DONE\`,
   names the \`📁 SAVED FOLDER\`, lists the saved \`FILES:\`, and ends with a compact
   \`{ ok, count, model, historyId, paths, dir }\` JSON line (plus one
   \`resource_link\` per file). **A successful return means the task is complete —**
   the image is already shown to the user and saved to history + the file panel.
   You do **not** need to embed, re-describe, or base64 the pixels. Just confirm
   briefly in the user's language and cite the saved path(s) when relevant.
4. **Finding / inspecting the image — use the returned \`paths\` / \`dir\` ONLY.**
   The \`paths\` (and their \`dir\`) in the return ARE the authoritative location. To
   view what was produced, open those exact \`paths\` with your image-viewing
   capability (the \`view image\` tool / reading the file), or list the \`dir\`
   folder.
   - **NEVER call \`query_history\` to locate an image you just generated.** It is
     for browsing *older* sessions only and is slower.
   - **NEVER shell out** (\`dir\`, \`ls\`, \`where\`, \`find\`, \`Get-ChildItem\`, etc.) to
     search the filesystem for the file — that scans huge trees and times out
     (\`exit 124\`). The path is already in the return; trust it.
   Briefly check the image matches the request (right subject, count, style, no
   obvious artifacts or wrong text). If it clearly does not match, say so and offer
   to regenerate with an improved prompt. When you generated multiple images, view
   each one. Keep the check quick; don't over-narrate.

## Multiple images at once — concurrency (important)

When the user asks for more than one image (e.g. "生成 3 张…", "make 4 variations",
a set/series, or several distinct subjects), **emit all the \`generate_image\` calls
together in the SAME turn so they run concurrently** — do not generate one, narrate,
then start the next. The \`catimation\` server is parallel-safe, so concurrent calls
finish far faster and the user sees them progress at the same time.

- Default to concurrency whenever the requests are independent: issue one
  \`generate_image\` call per image in a single batch (parallel tool calls).
- Use a sensible cap — up to ~4 in flight at once. If the user asks for many more,
  run them in batches of ~4 rather than strictly one-by-one.
- Only fall back to sequential when calls genuinely depend on each other (e.g. the
  next prompt needs a path returned by the previous one).
- After the batch returns, confirm once and cite the saved \`paths\`; don't re-announce
  each image separately.

## Notes

- This is the generate → save → read path. The file is on disk (see \`paths\`), in
  the history page, and in the ATTACHMENTS panel — no extra save step is needed.
  Only move/copy a file if the user wants it somewhere specific.
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
