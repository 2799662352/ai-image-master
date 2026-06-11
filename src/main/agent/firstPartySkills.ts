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

When the user wants one image, call the **\`generate_image\`** tool. When the user
wants MORE THAN ONE image, call **\`generate_images\`** instead. Both tools are
provided by the \`catimation\` MCP server and replace the built-in imagegen /
image_gen skill: they render inside the chat AND persist results to local files
(paths returned), the app's history page, and the ATTACHMENTS file panel.

## Steps

1. Turn the request into one clear, descriptive prompt. Cover subject, style,
   composition, lighting, and mood. Keep it concise.
2. If the user asks for exactly ONE image, call \`generate_image\` with:
   - \`prompt\` (required): the description from step 1.
   - \`ratio\` (optional): aspect ratio, e.g. \`1:1\`, \`16:9\`, \`9:16\`, \`4:3\`, \`3:2\`.
     Omit or \`auto\` lets the model decide.
   - \`resolution\` (optional): clarity tier — prefer \`2K\` by default. Use \`1K\`
     only when the user asks for fast/cheap/draft; use \`4K\` only when the user
     explicitly asks for print/ultra-detail/4K.
   - \`quality\` (optional): \`auto\` (default), \`low\`, \`medium\`, or \`high\`. Use
     \`high\` for images with text or fine detail.
   - \`referenceImages\` (optional but **important**): array of local file paths
     or data/http URLs for image-to-image / editing. **If the user gave you any
     image material, you MUST reuse it here** (see "Reference images" below).
   - Do **not** pass \`model\` — the channel is fixed to \`gpt-image-2-vip\`.
3. If the user asks for TWO OR MORE images, call \`generate_images\` ONCE with:
   - \`prompts\` (required): one prompt per requested image. If the user asks for
     N images, provide exactly N prompts.
   - shared \`ratio\`, \`resolution\`, \`quality\`, and \`referenceImages\` when
     appropriate.
   - Do not spawn subagents and do not call \`generate_image\` one-by-one.
     \`generate_images\` performs the parallel fan-out internally and returns one
     combined result.
4. The tool returns a short text result that begins with \`✅ generate_image DONE\`
   or \`✅ generate_images DONE\`,
   names the \`📁 SAVED FOLDER\`, lists the saved \`FILES:\`, and ends with a compact
   \`{ ok, count, model, historyId, paths, dir }\` JSON line (plus one
   \`resource_link\` per file). **A successful return means the task is complete —**
   the image is already shown to the user and saved to history + the file panel.
   You do **not** need to embed, re-describe, or base64 the pixels. Just confirm
   briefly in the user's language and cite the saved path(s) when relevant.
5. **Do NOT inspect the generated image(s) — the user already sees them.**
   A \`✅ DONE\` return means the image is ALREADY rendered in the chat; the user
   is looking at it right now and will tell you if something is off. Just
   confirm briefly and cite the saved path(s). In particular:
   - **NEVER open the result with \`view_image\` / by reading the file "to
     double-check".** Each view injects the full-resolution image as multi-MB
     base64 into the conversation; after a multi-image batch the NEXT model
     request exceeds the gateway's request-size limit and the whole thread
     hangs/dies (\`request_too_large\`). Self-inspection has wedged real user
     threads — it is never worth it.
   - The ONLY time you may view a result: the user explicitly reports a problem
     or asks you to look, AND you view at most ONE image in that turn.
   - **NEVER call \`query_history\` to locate an image you just generated.** It is
     for browsing *older* sessions only and is slower.
   - **NEVER shell out** (\`dir\`, \`ls\`, \`where\`, \`find\`, \`Get-ChildItem\`, etc.) to
     search the filesystem for the file — that scans huge trees and times out
     (\`exit 124\`). The path is already in the return; trust it.
   If the user says the image does not match, offer to regenerate with an
   improved prompt. Keep confirmations short; don't over-narrate.

## Reference images — reuse the user's material (important)

If the user provides ANY image material, treat it as a reference and pass it in
\`referenceImages\` (image-to-image) instead of doing text-to-image. Look for:

- Paths listed in the prompt under \`[Attached files at these local paths: …]\`
  or \`[Referenced files at these local paths: …]\` — these are the files the
  user attached/@-mentioned in chat. Pass the image ones as \`referenceImages\`.
- The user pointing at an image with language like "按这张图 / 参考这张 /
  基于这张 / 用这张做 / edit this / make a variation of this / 换成…风格".
- An image the user just generated in this thread that they now want changed.

Rules:
- Be proactive: when material is present and the request is plausibly about it,
  reuse it. Do **not** silently drop the reference and generate from scratch.
- **You can pass MULTIPLE reference images — you are not limited to one.**
  \`referenceImages\` is an array: include every relevant image the user gave
  (e.g. a character sheet + a background, several angles, a subject + a style
  reference). Pass all of them together so the model can combine/condition on
  the whole set, not just the first.
- Pass the local file path(s) directly (the tool reads the full-resolution bytes
  itself); you do not need to convert them.
- If you are unsure whether the user wants the reference followed, prefer reusing
  it and say briefly that you based it on their image(s).

## Multiple images at once — use generate_images (important)

When the user asks for more than one image (e.g. "生成 3 张…", "make 4 variations",
a set/series, or several distinct subjects), **call \`generate_images\` exactly
once**. Do not try to manually emit several \`generate_image\` calls; models often
serialize those calls even when asked to be parallel. \`generate_images\` is the
parallel-safe batch wrapper and fans out the renderer calls concurrently inside
CATIMATION.

- If the user asks for N images, pass exactly N prompts to \`generate_images.prompts\`.
- For variations, write N distinct but related prompts so the outputs are not clones.
- For many more than 8 images, ask the user to split into batches; the tool caps
  each batch to keep the UI and gateway stable.
- After \`generate_images\` returns, confirm once and cite the saved \`paths\`; don't
  re-announce each image separately.

## Notes

- This is the generate → save → read path. The file is on disk (see \`paths\`), in
  the history page, and in the ATTACHMENTS panel — no extra save step is needed.
  Only move/copy a file if the user wants it somewhere specific.
- For edits, image-to-image, or multi-image prompts, use \`generate_image\` for one
  output or \`generate_images\` for multiple outputs, always with \`referenceImages\`
  when references are present.
- If \`generate_image\` is genuinely unavailable in this session, you may fall back
  to whatever image tool you do have — but \`generate_image\` is the preferred,
  in-app path that actually displays and saves the result.
`

export const CATIMATION_IMAGE_SKILL: FirstPartySkill = {
  name: 'catimation-image',
  content: CATIMATION_IMAGE_SKILL_CONTENT,
}

const CATIMATION_SUBAGENTS_SKILL_CONTENT = `---
name: catimation-subagents
description: >-
  Use parallel Codex subagents inside CATIMATION ONLY when the user explicitly
  asks for parallel delegation or subagents. Trigger on explicit phrases like
  "并行 / 同时 / 分头 / 拆开做 / 开子代理 / 子代理 / spawn agents / delegate in
  parallel / one agent per point". Do NOT trigger merely because a task could be
  split naturally.
---

# Use parallel subagents ONLY when explicitly requested

Codex can spawn specialized **subagents** that work concurrently and report back.
This app raises the concurrency ceiling to **8 parallel agent threads**
(\`agents.max_threads=8\`, \`agents.max_depth=1\`).

## Hard trigger rule

Use subagents **ONLY** when the user explicitly asks for them or explicitly asks
to split work in parallel. Do **not** infer subagents from task shape alone.

Explicit trigger examples:

- "并行做 / 同时做 / 分头做 / 拆开做"
- "开几个子代理 / 用子代理 / spawn agents"
- "one agent per file / one agent per point"
- "delegate this in parallel"

Non-triggers (do NOT spawn subagents):

- A task merely has multiple independent parts.
- The user asks for multiple images, prompts, files, or examples but does not
  mention parallel/subagents.
- You think subagents would be faster.

Each subagent does its own model + tool work, so it costs more tokens than one
combined pass. User intent controls this feature.

## How to delegate

1. **Split the work explicitly** in your reasoning: name each subtask and what
   each subagent should return (a short, distilled result — not raw dumps).
2. **Spawn them in one go** so they run concurrently — e.g. "spawn 3 agents:
   agent 1 does …, agent 2 does …, agent 3 does …". Up to ~8 run at once; ask
   for more only in batches.
3. **For row-per-worker batches**, use \`spawn_agents_on_csv\`: it reads a CSV and
   starts one worker agent per row, concurrently.
4. **State whether to wait** for all agents before continuing, and what the final
   synthesis should look like.
5. **Synthesize**: combine the subagents' distilled results into one answer;
   don't just paste each agent's output.

## Notes

- Built-in agents (e.g. \`explorer\`) are available; you can also pin a cheaper/
  faster model for light subagent work when you spawn them.
- Subagents are for delegating *agent work*. To generate multiple IMAGES, use the
  \`catimation-image\` skill's \`generate_images\` batch tool instead — that's the
  right tool for image fan-out.
- Keep delegation depth shallow (one level); deep recursion multiplies cost and
  latency without clear benefit.
`

export const CATIMATION_SUBAGENTS_SKILL: FirstPartySkill = {
  name: 'catimation-subagents',
  content: CATIMATION_SUBAGENTS_SKILL_CONTENT,
}

/**
 * First-party skills no longer shipped by default. If an older app version
 * installed an app-managed copy, remove it on startup so Codex stops discovering
 * it. User-edited copies are preserved.
 */
const RETIRED_FIRST_PARTY_SKILL_NAMES = ['catimation-subagents']

/** All skills this app ships into the Codex USER scope on startup. */
export const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  CATIMATION_IMAGE_SKILL,
]
