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
  FIRST-CHOICE image generator in the CATIMATION desktop app — use IN PREFERENCE
  TO the built-in imagegen / image_gen tool (which is unavailable on Windows and
  does not persist results). Trigger whenever the user asks to generate / draw /
  render / edit / restyle an image, picture, illustration, poster, or icon, or
  says 生成图片 / 画一张 / 配图 / 出图 / 来张图 / 改图. Runs the in-app generate_image tool.
---

# Generate images in CATIMATION (first-choice, replaces built-in image_gen)

When the user wants one image, call the **\`generate_image\`** tool. When the user
wants MORE THAN ONE image, call **\`generate_images\`** instead. Both tools are
provided by the \`catimation\` MCP server and replace the built-in imagegen /
image_gen skill: they render inside the chat AND persist results to local files
(paths returned), the app's history page, and the ATTACHMENTS file panel.

## When to Use

- 用户要生成 / 画 / 渲染 / 编辑 / 重绘图片、插画、海报、图标、配图(生成图片 / 画一张 / 出图 / 改图)。
- 你自己回答时需要一张配图。
- 用户给了图想以图改图 / 换风格 → 走本 skill 并带上 \`referenceImages\`。
- 优先于内置 imagegen / image_gen(后者 Windows 不可用且不落盘)。

## Steps

0. **Before writing the prompt, load \`director-orchestrator\`** (the
   导演总调度 router). It runs a STEP 0 self-reflection on which \`director-*\` /
   \`storyboard-*\` craft skills apply, then writes the prompt as structured text
   on the 13-dimension framework (physical params over emotion adjectives,
   positive prompts by default). Do this even when YOU generate an illustration
   for your own answer. For open-ended asks, go through \`catimation-brainstorm\`
   first. Skip only for a trivially clear one-off.
1. Turn the request into one clear, descriptive prompt. Cover subject, style,
   composition, lighting, and mood. Keep it concise.
2. If the user asks for exactly ONE image, call \`generate_image\` with:
   - \`prompt\` (required): the description from step 1.
   - \`model\` (optional): rendering channel **override**. **Omit it** to honor the
     user's channel picker in the chat composer (default VIP). Only set it when you
     have a concrete reason — a consistent 组图 series (→ \`wan2.7-image-pro\`) or a
     channel the user explicitly names this turn (see "Choosing a model" below):
     - \`gpt-image-2-vip\` — OpenAI 官逆 (stable alternate; same ratio/resolution/quality spec).
     - \`wan2.7-image-pro\` — 阿里万相 2.7 pro (超清文生图 / 图像编辑 / 组图).
     - \`gemini-3.1-flash-image\` — Nano Banana 2（谷歌 Gemini 原生端点，快、多尺寸 4K）.
     站点会自动处理(见下方「站点要求」)——你无需让用户手动切站点。
   - \`ratio\` (optional): aspect ratio, e.g. \`1:1\`, \`16:9\`, \`9:16\`, \`4:3\`, \`3:2\`.
     Omit or \`auto\` lets the model decide.
   - \`resolution\` (optional): clarity tier — prefer \`2K\` by default. Use \`1K\`
     only when the user asks for fast/cheap/draft; use \`4K\` only when the user
     explicitly asks for print/ultra-detail/4K.
   - \`quality\` (optional): \`auto\` (default), \`low\`, \`medium\`, or \`high\`. Use
     \`high\` for images with text or fine detail.
   - \`count\` (optional, **wan2.7 only**): number of images from THIS one prompt
     (1–12, default 1). Set \`model: 'wan2.7-image-pro'\` + \`count > 1\` to get a
     front-to-back **consistent 组图 series** (same character/subject across
     frames, e.g. 同一只猫的四季). Other channels ignore \`count\` (always 1). For
     several *unrelated* images, use \`generate_images\` (one prompt each) instead.
   - \`referenceImages\` (optional but **important**): array of local file paths
     or data/http URLs for image-to-image / editing. **If the user gave you any
     image material, you MUST reuse it here** (see "Reference images" below).
3. If the user asks for TWO OR MORE images, call \`generate_images\` ONCE with:
   - \`prompts\` (required): one prompt per requested image. If the user asks for
     N images, provide exactly N prompts.
   - shared \`model\` (optional, same choices as above), \`ratio\`, \`resolution\`,
     \`quality\`, and \`referenceImages\` when appropriate.
   - Do not spawn subagents and do not call \`generate_image\` one-by-one.
     \`generate_images\` performs the parallel fan-out internally and returns one
     combined result.
3.5. **Before you call the tool, tell the user in ONE short line that you are
   submitting the render and it usually takes a few minutes.** The call blocks for
   up to ~1 minute and then, for a normal multi-minute render, hands control back
   to you with a \`⏳ STILL RUNNING\` + \`taskId\` (see step 4) — so this heads-up is
   what the user sees first. (The app also shows a live "生成中" bubble in the chat
   the whole time, and the finished image lands there automatically.)
4. The tool returns a short text result that begins with \`✅ generate_image DONE\`
   or \`✅ generate_images DONE\`,
   names the \`📁 SAVED FOLDER\`, lists the saved \`FILES:\`, and ends with a compact
   \`{ ok, count, model, historyId, paths, dir }\` JSON line (plus one
   \`resource_link\` per file). **A successful return means the task is complete —**
   the image is already shown to the user and saved to history + the file panel.
   You do **not** need to embed, re-describe, or base64 the pixels. Just confirm
   briefly in the user's language and cite the saved path(s) when relevant.
   - **\`⏳ STILL RUNNING\`** (the COMMON case — any render that takes longer than the
     ~1 min block, i.e. most of them): the result carries a \`taskId\` instead of a
     path. The image will STILL appear in the user's chat automatically — you now
     have control back, so tell the user it's generating, then call
     **\`check_image_task\`** with that \`taskId\` (it long-polls ~25s server-side, so
     just call it again right away) and **keep calling until \`✅ DONE\` or
     \`❌ FAILED\`** — do not end your turn on STILL RUNNING. **Never** resubmit
     \`generate_image\` / \`generate_images\` for the same request (that renders a
     duplicate).
5. **Self-review the result, then improve if needed (autonomous QA loop).**
   A \`✅ DONE\` return means the image is ALREADY rendered in the chat. Before you
   hand off, open the generated image(s) with \`view_image\`(支持批量;超大批量看代表性子集)
   and过一遍**四项验收清单**:
   - **① 符合用户要求**:主体 / 数量 / 画幅比例 / 文字内容 / 明确指定的元素是否都对上;
     用户给了 \`referenceImages\` 时是否真的体现了参考(而非从零另画)。
   - **② 质量合理**:无多/缺手指与肢体、无崩脸、无乱码文字、无明显伪影/拼接错位;
     分辨率与清晰度匹配用途。
   - **③ 风格一致**:与用户指定风格一致;**系列/组图**内各帧画风、色调、角色外观前后一致;
     若项目有角色锚点 / 圣经(character_bible)或既定风格,新图须与之吻合(见
     \`director-style-consistency\` / \`director-character-consistency\`)。
   - **④ 过 skill / 插件门**:提示词是否经 \`director-orchestrator\` 的 13 维框架(物理参数优先);
     角色身份是否遵循单锚点纪律(默认大头照+全身照,三视图/四视图为可选补充);
     涉敏感/合规内容是否过 \`storyboard-negative-control\`;在制片流程中是否满足 \`film-studio\` 的资产门。
   - 若任一项不达标:简述哪里不对,**带改进后的提示词重生成**(保留可用部分时把上一版回传为
     \`referenceImages\` 做图生图),再复检。最多迭代 2–3 次即收敛——别在边角小瑕疵上死磕,
     每次重生成都花钱。
   - When it's good (or good enough), confirm briefly in the user's language and
     cite the saved path(s). Don't over-narrate each pass.
   - You still do NOT need \`query_history\` to find an image you just generated,
     and do NOT shell out (\`dir\`/\`ls\`/\`where\`/\`find\`/\`Get-ChildItem\`) to hunt for
     the file — the path is already in the return; \`view_image\` that path directly.

## Choosing a model (user's composer picker is the default; you may override)

The \`model\` param is an **optional override**. By default (omit it) generation runs
on the channel the **user picked in the chat composer** (VIP / 腾讯 / Nano2 / 万相
2.7 pro; default VIP) — 所有渠道同一套 ratio × resolution(1K/2K/4K) × quality 参数。
Omitting \`model\` honors the user's pick — do this for ordinary requests. Set \`model\`
only when you have a concrete reason to override:

- **\`gpt-image-2-vip\` (OpenAI 官逆)** — pick when the user says 官逆 / vip /
  OpenAI / 稳定渠道. Stable alternate; same param surface as the default.
- **\`wan2.7-image-pro\` (阿里万相 2.7 pro)** — pick when the user says 万相 /
  wanxiang / wan / 通义万相, OR when they want a **consistent multi-image 组图
  series** (e.g. "同一只猫的四季组图，前后一致"). For a 组图 series, call
  \`generate_image\` with \`model: 'wan2.7-image-pro'\` and \`count\` = how many frames
  (2–12) — it returns one front-to-back-consistent set from a single prompt
  (do NOT use \`generate_images\`, which makes unrelated images). Wan excels at
  超清文生图、图像编辑、组图; it also supports 4K (text-to-image only —
  editing/组图 cap at 2K).
- **\`gemini-3.1-flash-image\` (Nano Banana 2)** — pick when the user says nano /
  nano2 / nano banana / gemini / 谷歌. 谷歌 Gemini 原生端点，出图快(~15s)、支持
  超多宽高比与 4K，中文/文字与一致性也不错。
- All four accept \`referenceImages\` for image-to-image / editing.

### 站点要求(已自动处理 — 无需手动切站点)

\`custom-imagemodel-gt\`(腾讯 image2)和 \`wan2.7-image-pro\`(阿里万相 2.7 pro)
**都只经 Miau API 代理提供**。codex 出图时会**自动把这两个渠道的请求固定走 Miau API
站点**(无论用户当前在「API 设置」里选了哪个站点),所以你**不需要**让用户手动切站点——
直接调用即可。

- 唯一前提:Miau API 站点已配置 API Key。若没配,工具会返回清晰错误
  「未配置『Miau API』站点的 API Key …」——这时再提醒用户到「API 设置」为 Miau API
  站点填入 Key 即可,无需切换当前站点。
- \`gpt-image-2-vip\` 和 \`gemini-3.1-flash-image\`(Nano Banana 2)走当前选中站点
  (任意站点可用,无需 Miau)。

When the user does not name a channel, **do not guess** — just omit \`model\` so the
render honors the user's composer picker (default VIP). Set \`model\` only for a
concrete reason (组图 → \`wan2.7-image-pro\`, or a channel the user named). Never
invent a model name; only these four values are valid.

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

## Organize finished assets into the user's workspace (when in a project)

When you're working inside a user project/workspace folder (e.g. a film /
storyboard project, or the user asked you to organize outputs), proactively
**COPY** each finalized image into a tidy assets subfolder of that working
directory and give it a descriptive, ordered name — e.g.
\`<workspace>/assets/images/S01_hero_wide.png\`.

- **COPY, don't move**, from the saved path in the tool result, so the chat /
  history / ATTACHMENTS copy stays intact.
- Group by purpose/shot and use zero-padded ordinals (\`S01_\`, \`S02_\`…) so files
  sort naturally.
- For a one-off casual generation outside any project, skip this unless asked —
  the file is already saved and in history.

## Common Mistakes

- 用户给了图却忘传 \`referenceImages\`,改成从零文生图。
- 多张图却逐个调 \`generate_image\`,而不是一次 \`generate_images\`。
- 凭空编造 \`model\` 名;只有四个合法值。用户没点名就省略 \`model\`(交给用户在 composer 选的渠道,默认 VIP)。
- 用户点名某渠道却不显式传 \`model\`(应显式传:vip/官逆 → \`gpt-image-2-vip\`、
  nano/nano2 → \`gemini-3.1-flash-image\`、万相/组图 → \`wan2.7-image-pro\`)。

## Notes

- This is the generate → save → read path. The file is on disk (see \`paths\`), in
  the history page, and in the ATTACHMENTS panel — no extra save step is needed.
  Only move/copy a file if the user wants it somewhere specific (see the organize
  section above when working in a project).
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

const CATIMATION_VIDEO_SKILL_CONTENT = `---
name: catimation-video
description: >-
  FIRST-CHOICE video generator in the CATIMATION desktop app. Trigger whenever the
  user asks to generate / create / render a video, clip, or animation, to animate
  an image, or says 生成视频 / 来段视频 / 做个动画 / 让它动起来 / 图生视频 / 视频编辑 / 视频延长.
  Covers text-to-video, image-to-video, omni-reference (全能参考, the default), plus
  video editing and extension — all via the in-app generate_video tool (Seedance
  2.0 / 2.0-fast). Do not call a built-in video tool; see the body for usage.
---

# Generate videos in CATIMATION (first-choice, blocking like generate_image)

When the user wants a video, call the **\`generate_video\`** tool from the
\`catimation\` MCP server. It is a SINGLE blocking call: it submits the render
and returns only when the video is DONE (or FAILED) — you do not need to poll,
sleep, or check anything in between. The user watches a live progress bubble
the whole time, and the finished MP4 plays inline in the chat, is saved to a
local file, and lands in the app history page.

## Default mode = 全能参考 (omni-reference) — use it unless told otherwise

For almost EVERY video request, default to **全能参考 (omni-reference)** — and
prefer it heavily. Feed the user's material as references and let the model keep
subject/motion/voice consistent. Caps:

- \`referenceImages\`: up to **9** images.
- \`referenceVideos\`: up to **3** videos, COMBINED total duration **≤15s**.
- \`referenceAudios\`: up to **3** audios, COMBINED total duration **≤15s**.

> **音频参考/音频素材导入只收真实音频 \`mp3\` / \`wav\`。** 视频容器(\`.mov\` / \`.mp4\`,
> 哪怕是**黑屏或波形占位**)会被音频接口拒收:\`Unsupported audio format: mov.
> Allowed formats: mp3, wav.\`。素材若是视频或含视频轨,先用 \`ffmpeg-win\` 抽音轨:
> \`ffmpeg -y -i in.mov -vn -acodec libmp3lame -q:a 2 out.mp3\`(或 \`-vn out.wav\`),
> 再把 \`out.mp3\` / \`out.wav\` 传 \`referenceAudios\`。⚠️ 把音频包成「黑屏 MP4」**只用于
> \`understand_video\`(视频理解接口)**,绝不能当作音频参考 / 音频分析素材上传。

Only switch to other modes when the user **specifically asks** for them or clearly
needs them — e.g. strict \`firstFrame\`/\`lastFrame\` (fixed first/last frame). Do
NOT reach for first/last-frame mode by default.

**Always name the mode you used.** In your reply, state it explicitly in the
user's language — e.g.「我用**全能参考**模式生成」「用**视频延长**模式串联了 3 段」
「按你要求用**首尾帧**模式」. When you default to omni-reference (the usual case),
say 全能参考 out loud so the user knows which path you took.

## All modes share ONE tool (\`generate_video\`) — pick by inputs + prompt

Seedance has no separate edit/extend endpoints; every mode is the same call with
different content + prompt wording. Use these when the user asks:

- **文生视频 (text-to-video)**: \`prompt\` only, no references. Pure imagination.
- **图生视频 (image-to-video)**: put the still in \`referenceImages\` (default) — or
  \`firstFrame\` (+\`lastFrame\`) only if the user wants that exact frame fixed.
- **全能参考 (omni-reference, DEFAULT)**: \`referenceImages\`/\`referenceVideos\`/
  \`referenceAudios\` — inherit subject, motion/运镜, voice/音色.
- **视频编辑 (video editing — 替换/增删/修改元素)**: pass the source clip in
  \`referenceVideos\` (+ any new element image in \`referenceImages\`) and write an
  edit prompt. Formulas: 增加元素=描述「元素特征+出现时机+位置」; 删除元素=点名要删的、
  强调要保留的; 修改元素=直接描述更换后的样子（如「将视频1礼盒中的香水替换成图片1中的面霜，运镜不变」）.
- **视频延长 (video extension / 多片段串联)**: pass **1–3** source clips in
  \`referenceVideos\` and describe how they连接/向前向后延长（如「向后延长视频1：…」或
  「视频1 + 过渡描述 + 接视频2 + 接视频3」）.

**Prompt material-reference rule (必须遵守)**: in the prompt, refer to inputs by
ordinal — \`图片1 / 视频1 / 音频1\` (the Nth item of that type in the request) — NEVER
by assetId. ✅「图片1中的美妆博主」 ❌「asset-2026… 是美妆博主」.

**Real human faces**: Seedance does NOT accept real human faces in reference
images/videos directly. Use a 人像库 virtual-avatar \`asset://assetId\`, or a clip
Seedance itself generated earlier (model-product 二创 is审核-safe). When reusing an
earlier generated video for edit/extend, pass its saved local path / asset:// —
remote upstream URLs expire in ~24h, so prefer the local copy.

**别把未经处理的 Seedance 视频直接当视频参考喂回去(效果打折)**: 把上一段 Seedance
生成的 MP4 原封不动塞进 \`referenceVideos\` 去做延长/编辑/续接,会经历一次二次编码 +
运动重采样,画质与跨镜一致性明显打折。**优先用 \`ffmpeg-win\` 把它先「降维」成干净的延续
条件再喂回去**——抽**尾帧/关键帧成静图**(尾帧做下一段 \`firstFrame\` 衔接最稳,或抽
3×3 多宫格关键帧塞 \`referenceImages\` 传递主体/风格),或**抽出音频/音乐**塞
\`referenceAudios\` 续接节奏/配乐。确实需要整段视频参考时(例如靠它规避真人脸审核)再退回
直接传 MP4——那是兜底,不是首选。要做抽帧/抽音频先载入 \`ffmpeg-win\` 技能。

## Co-direct the shot — brainstorm with the user + your local craft skills

Before you write the \`prompt\`, **load \`director-orchestrator\`** (the 导演总调度
router): it runs a mandatory STEP 0 self-reflection — 「涉及 13 维里哪几维?要用哪些本地
director-* / storyboard- skill?」 — loads the matching craft skills, and writes
the prompt as structured text (never JSON) with physical/camera-reproducible
params over emotion adjectives. Do this even when YOU generate a clip for your
own answer. Then take a beat to shape the shot **with** the user.
You have a LARGE library of local video / storytelling craft skills in your own
skills directory (usually \`~/.agents/skills/\`, e.g. \`C:\\Users\\<you>\\.agents\\skills\`)
— 镜头/景别/运镜, 导演思维, 前景遮挡, 打光/光影, 构图/伪透视, 角色动机与演技, 调色,
分镜/storyboard, 画面反推, 规避审查, and many more. They are intentionally NOT listed
here: **browse your skills directory freely and load whatever fits** — there's a
lot in there, so lean on it generously instead of reinventing technique. The user
may also trigger one directly through their prompt.

**Scale the collaboration to the request — don't over-interrogate:**

- **Clear / simple ask** (e.g.「让这张图动起来」) → pick sensible defaults, load the
  obvious craft skill, and just generate. A heavy Q&A here only annoys the user.
- **Open-ended or high-stakes ask** (e.g.「做个产品宣传片」「来个有电影感的片段」) →
  guide the user the way a director would, in short focused exchanges. For this,
  load the **\`catimation-brainstorm\`** skill — it drives a clickable
  \`ask_user\` card so the user just taps a choice instead of typing:
  1. Ask **one question at a time** via \`ask_user\`, with concrete options —
     「想要什么景别?(特写 / 中景 / 广角)」「什么情绪和风格?」「要不要某种运镜?(推 / 拉 / 环绕 / 手持)」
  2. Offer **as many concrete visual directions as you actually have** (3–6 is
     common, up to 8) inside ONE \`ask_user\` card — each with a one-line
     trade-off, and mark the one you'd recommend. Never list 方案 as plain text.
  3. Once the direction is set, load the matching local craft skill(s) and fold
     their technique into the prompt.

Keep it lightweight and collaborative — you're co-directing, not running a survey.
When unsure, propose a sensible default out loud and let the user correct you.

## 角色片 / 多镜项目:先备齐资产,再开生成(人物卡 → 故事板 → 分镜多参)

只要视频里有**反复出现的角色**或**不止一个镜头/事件**,就**不要**直接 \`generate_video\`。
先把资产锁好——这正是跨镜一致性的来源(\`sd2-pe\` 把素材拆成「空间层(画面里有什么)+
时间层(怎么随时间变化)」来理解,素材越齐、绑定越清,出片越稳)。绑定语法与路径 A/B 判定
统一以 **\`sd2-pe\`** skill 为准,先把它载入。

1. **人物卡 (Character Card) — 先锁人,再开拍。** 每个出镜角色先建一张人物卡并存进
   人像库,作为该角色**唯一身份锚**,全片所有镜头都引用同一张卡:
   - 一张**大头照**(仅头部、正脸、无表情)+ 一张**全身照**(定妆造 / 服装 / 配饰)。
     默认用此单锚点,**三视图 / 四视图可作可选补充,慎用**——多视图易触发 ID 漂移与双胞胎(\`sd2-pe\` 人脸最佳实践)。
   - 缺图就先用 \`generate_image\` 出一张定妆照补齐,再 \`add_to_portrait_library\`
     存成 \`asset://assetId\`;默认**不**拿现成多视图整张当唯一身份锚(如需,多视图可作可选补充参考)。
   - 提示词里绑成稳定主体:\`<主体1> 的面部参考 图片1(大头照)、妆造参考 图片2(全身照)\`。

2. **故事板 / 分镜 (Storyboard) — 多事件 / 多镜先排板。** 只要不是「单场景一个连续动作」
   (\`sd2-pe\` 路径 A),就先排故事板:拆成 \`镜头1 / 镜头2 / …\`,每镜按
   **运镜 → 主体动作 / 表情 → 位置 / 空间 → 音频** 四要素写清(\`sd2-pe\` 路径 B 三段论),
   给用户过一遍再开生成。**一镜一运镜、用镜头序号、不写绝对秒数。**

3. **资产齐备 GATE — 备齐才开生成(硬门)。** 调 \`generate_video\` 之前,逐镜清点该镜
   **所有可用资产**是否就位:人物卡(大头照 + 全身照)、场景 / 环境图、关键道具图、
   氛围 / 色调参考图、运镜 / 动作 / 风格参考视频(如需)、音乐 / 配乐 / 音色参考音频(如需)。
   **任一该有却没备的,先补齐再生成,绝不先生成再补。** 推荐每镜 **4–5 个素材**,够用即可,
   不必塞满上限。**注意:参考视频和音乐 / 音频本身就是素材**——它们和图片一样走 全能参考,
   在生成时一并喂入(\`referenceVideos\` / \`referenceAudios\`,各 ≤3 个、合计 ≤15s),见第 4 条。

   **缺资产时不要干等,也不要硬生——先用一句话向用户报缺口清单**(缺什么、各项你打算
   怎么补),再按情况**三选一**逐项处理:
   - **① 先在项目 / 库里找。** 翻用户工作区的 \`assets/\` 等目录、\`list_portrait_library\`
     找现成的人物卡 / 场景 / 道具 / 氛围图——能复用就别重造,顺手保住一致性。
   - **② 能自己出的就自主补。** 非身份关键、可合理想象的资产(环境 / 场景图、氛围 / 色调
     参考图、通用道具、空镜)——直接用 \`generate_image\` 当场出图,再 \`add_to_portrait_library\`
     入库,然后带进生成。补出来的图先按上面的「自检」过一眼再用。
   - **③ 必须用户给的才问。** 身份 / 意图关键、你不能凭空捏造的(特定真人形象、用户指定的
     角色 / IP、品牌 Logo、特定真实产品、用户心里已有具体样子的道具)——用 \`ask_user\`
     请用户上传图或给 \`asset://\`。用户给不出时,和他敲定一个可生成的替代方案,别硬编。

4. **生成必须用上全部可用资产 (use ALL usable assets)。** 调用时把已备齐的每一项都
   传进去并在 prompt 里逐一绑定:角色卡 / 场景图 / 道具 / 氛围图 → \`referenceImages\`,
   运镜 / 动作 / 风格参考视频 → \`referenceVideos\`,音乐 / 配乐 / 音色参考音频 →
   \`referenceAudios\`(或严格首尾帧 → \`firstFrame\` / \`lastFrame\`),并用
   \`图片N / 视频N / 音频N\` 指代。**图片、视频、音乐 / 音频都是全能参考素材,一个都别落下;
   有素材却只发纯文字 = 错。**

5. **每次生成的素材归一个新建专属文件夹(便于复用与检查)。** 把这一镜 / 这次生成要用到的
   全部素材(人物卡、场景 / 环境、道具、氛围图、参考视频、音频)先**复制**进一个**新建的专属夹**
   ——一次生成对应一个夹子,例如 \`<workspace>/assets/jobs/S01_<slug>/\`(非项目场景用一个
   临时素材夹即可);再从该夹取本地路径喂给 \`generate_video\`。这样每次用的料都聚在一起:
   复用时直接拷夹子,检查时只看一个夹,出问题也能一眼定位是哪份素材。

> **轻量例外:** 单图「让它动起来」「随手来一段」这类一次性简单请求,不必强排人物卡 /
> 故事板——把用户给的那张图当参考 / 首帧直接动起来,本身就已是「用上了全部可用资产」。
> 这套纪律是给**角色片 / 多镜 / 项目级**工作准备的(也正是 \`film-studio\` 编排器的
> G3 → G5 阶段)。

## 写 \`prompt\` 前先用 skill 渐进式写好(强制,不许脱离 skill + 素材硬写)

**生成前必须先把提示词用相关 skill 编写到位——绝不脱离 skill 和已备素材凭记忆自行硬写。**
按下列顺序、**渐进式披露**地加载并应用(只加载这一镜实际涉及的维度,用不到的不强加):

1. **导演 / 镜头(先):** 载入 \`director-orchestrator\` 跑它的 STEP 0 反问(这镜涉及 13 维里
   哪几维?要用哪些本地 \`director-*\` / \`storyboard-*\`?),据此按需加载景别 / 运镜 / 构图 /
   前景遮挡 / 打光 / 调色 / 角色演技 / 连续性等技法 skill。
2. **提示词工程(后):** 用 \`sd2-pe\`(八大要素 + 路径 A/B 判定 + 多模态绑定 \`@图片N\` / \`<主体N>\`)
   与 \`storyboard-video-prompt-optimization\` 把这镜落成**结构化文本**(never JSON),物理 /
   可复现参数(焦段 mm、光圈、色温 K、运镜)优先于情绪形容词,并把已备素材逐一绑进 prompt。
3. **渐进式披露:** 边写边按需要继续加载缺的技法 skill;真实技法词来源不确定时先联网查证再落笔。

> 即便你只是为自己的回答顺手出一个镜头,也要走这套。**没用 skill、凭空想出来的 prompt = 错。**

| 你冒出的念头 | 现实 |
|---|---|
| 「这镜很简单,直接写 prompt 就行」 | 简单镜也先过 skill;\`sd2-pe\` 路径 A 本身就是给简单镜的最短句式。 |
| 「我记得怎么写运镜 / 打光」 | 记得概念 ≠ 用了 skill;载入对应 \`director-*\` 拿真实技法词。 |
| 「素材一会儿再说,先把词写了」 | 反了——先备齐素材(见上一节),prompt 要绑定的是**已经在手的**素材。 |
| 「skill 太多懒得加载」 | 渐进式披露:只加载这镜用得到的那几个,不是全量。 |

## Steps

1. Turn the request into one clear video prompt. Cover subject, action, camera
   movement (运镜/景别), scene, lighting, and mood. Dialogue lines and
   \`--style\` parameters may be appended. **First co-direct the shot** (see the
   section above): consult your local craft skills and ask the user any quick
   clarifying question that would improve the result.
1.5. **Proactively confirm the output spec before rendering.** Unless the user
   already stated it, fire one \`ask_user\` card to let them pick the 规格 —
   typically resolution (\`480p\` draft / **\`720p\` default** / \`1080p\` HD),
   duration (4–15s, default 5), and aspect ratio (\`16:9\` / \`9:16\`). Recommend
   the defaults (满血 2.0 model + 720p) and let them tap to confirm or change.
   **Do NOT silently default to 1080p** — 720p is the default unless the user
   asks for HD. Keep it to one quick card; skip it only when the user already
   gave an explicit spec.
2. Call \`generate_video\` with:
   - \`prompt\` (required): the description from step 1.
   - \`model\` (optional): \`2.0\` (default — 满血/full-quality, best for almost
     every request: top quality, complex multi-shot motion, 1080p). Only switch to
     \`2.0-fast\` when the user explicitly asks for fast/cheap/draft.
   - \`resolution\` (optional): \`480p\` draft, \`720p\` default, \`1080p\` (model
     \`2.0\` only).
   - \`ratio\` (optional): \`16:9\` default; \`9:16\` for vertical/手机 video.
   - \`duration\` (optional): 4–15 seconds, default 5. Longer = more expensive.
   - \`referenceImages\` (全能参考, default & **important**): up to 9 images for
     character/subject consistency (人物一致性). **If the user attached or
     referenced any image, you MUST pass it here** (paths appear in the prompt
     under \`[Attached files at these local paths: …]\`). \`asset://assetId\` from
     the 人像库 page also works.
   - \`referenceVideos\` / \`referenceAudios\` (全能参考): up to 3 each (total ≤15s)
     for motion/style or lip-sync/voice. Each clip ≤50MB and 4–15s.
   - \`firstFrame\` / \`lastFrame\` (strict mode, **only on explicit request**):
     image to start/end the video from — local path, https URL, or
     \`asset://assetId\`.
3. Wait for the tool to return — it blocks until the render finishes. There is
   nothing useful to do in between; do NOT resubmit, do NOT call other tools to
   "check progress".
4. Read the result banner:
   - \`✅ generate_video DONE\` + \`📁 SAVED FILE: <path>\` → the task is COMPLETE.
     The video is already playing in the chat. Confirm briefly in the user's
     language, **name the mode you used** (e.g.「已用全能参考生成」), and cite the
     saved path. Do NOT re-check, do NOT search the filesystem, do NOT re-generate.
   - \`✅ DONE\` with "local file save … background/FAILED" → generation itself is
     complete; mention the save status briefly.
   - \`⏳ STILL RUNNING\` (rare, >10 min renders) → call \`check_video_task\` with
     the returned taskId repeatedly (each call long-polls ~25s) until DONE or
     FAILED. Never resubmit \`generate_video\` for the same request.
   - \`❌ FAILED\` → report the upstream error. You may retry ONCE with an
     adjusted prompt only if the error suggests a content/parameter problem.

## QA the clip: 九宫格 contact sheet + understand_video(合成一次自检,别二选一)

\`view_image\` can't open an MP4 directly, and injecting the raw video bytes into the
chat is wasteful — so a real self-check pairs **two complementary lenses in ONE
pass** (the grid samples only ~9 frames; \`understand_video\` covers what happens
between them — you need both):

0. **拿到 \`<clip>.mp4\` 的本地路径(别搜盘).** If you already generated the clip you
   have its path. If the clip lives **ON THE CANVAS** (a video shape), call
   \`get_canvas_video\` (the video sibling of \`get_canvas_image\`) — it returns
   \`videoPath\`, an absolute on-disk mp4/webm/mov for the selected (or only) canvas
   video: the recorded path, or a freshly materialized copy if the shape had none.
   Use that \`videoPath\` as \`<clip>\` below. **Never** \`canvas_exec\`-probe or hunt the
   disk by filename/size for a canvas video — that path is solved by this tool.

1. **视觉扫描 — 九宫格 contact sheet.** Extract 9 evenly-spaced frames tiled into a
   grid with ffmpeg (\`ffmpeg-win\` or any ffmpeg). Set \`fps ≈ 9 / clip_duration\` so
   the 9 tiles span the whole clip:

   \`\`\`
   ffmpeg -i "<clip>.mp4" -vf "fps=9/<DURATION>,scale=320:-1,tile=3x3:padding=6:color=black" -frames:v 1 -y "<clip>_grid.png"
   \`\`\`

   (For a 5s clip, \`fps=9/5=1.8\`; set \`<DURATION>\` to the real length. Nudge fps if
   tiles come out too few/many.) Then \`view_image\` the \`_grid.png\` and judge
   subject/character consistency, motion sanity (no melting / teleporting / extra
   limbs), artifacts, and prompt adherence. One small PNG — cheap and safe.
2. **内容审查 — \`understand_video\`.** Run \`catimation-understand\`'s \`understand_video\`
   to "watch" the WHOLE clip for 剧情 / 字幕 / 连续性 / 穿帮 that a 9-frame grid
   samples too sparsely to catch. **这两步是同一次自检的两面,不是二选一。**
3. If either lens flags a problem, regenerate with an adjusted prompt (or switch
   mode) and re-check. Iterate at MOST 2–3 times — each render costs money and ~1–3 min.
4. **Never** inject the full MP4 or its raw bytes into the chat — inspect via the
   contact sheet + \`understand_video\`, never by dumping the video. The user is
   already watching the clip play inline.

> 进阶 — 上面这套「九宫格 + understand_video」自检,背后是一个**跨两个技能的
> inspect→process→verify 大循环**,**不止发布前审片**:任何要**理解或处理 视频/音频/多媒体**
> 的时候都自主触发——处理前先 probe 摸清、处理后必复核,**九宫格视觉与 understand_video
> 内容两面一起看,不拆开**。\`ffmpeg-win\` 主导技术面(ffprobe 粗检 → 九宫格视觉 → 响度 →
> 修复 → release checkpoint,checkpoint 仅交付时),\`catimation-understand\`
> (\`understand_video\`)同一循环里负责模型内容理解/审查(剧情/字幕/连续性/穿帮);不达标就
> ffmpeg 修复后回到粗检复检,过了再交付。详见 \`ffmpeg-win\` 技能的 **inspect→process→verify** 段。

> 宫格图 / 故事板 = 素材,不只是检查工具:按剧情裁剪、拼接出的九宫格、分镜板本身是**优质可复用参考**——回喂 \`referenceImages\` 传主体/风格,或抽其中关键帧/尾帧作下一镜 \`firstFrame\`(配合上文「别把未处理的 Seedance 视频直接当参考」纪律:跨镜续接优先抽帧,不整段回喂)。

## Organize finished clips into the user's workspace (when in a project)

When working inside a user project/workspace, **COPY** the finalized MP4 (and its
\`_grid.png\` contact sheet) into a tidy assets subfolder with a descriptive,
ordered name — e.g. \`<workspace>/assets/video/S01_station_wide.mp4\` and
\`<workspace>/assets/contact-sheets/S01_station_wide_grid.png\`.

- **COPY, don't move**, from the saved path in the \`DONE\` banner so the chat /
  history copy stays intact.
- Use zero-padded shot ordinals (\`S01_\`, \`S02_\`…) so clips assemble in order — this
  is exactly what a later ffmpeg concat/拼接 step needs.
- Skip for a one-off casual clip unless the user asks.

## Portrait library (人像库) — push materials in, then reference

The \`catimation\` MCP server exposes portrait-library tools
(\`add_to_portrait_library\`, \`list_portrait_library\`, \`edit_portrait_library\`,
\`download_portrait_asset\` — see the \`catimation-portrait-library\` skill). Use
them **proactively** around video generation:

- Every input image you pass to \`generate_video\` is automatically imported into
  the library and referenced as \`asset://assetId\`; identical images dedupe
  upstream, keeping the SAME character consistent across multiple videos.
- When the user gives you OTHER material to save/reuse for the video (a video or
  audio reference, or "记住这个角色/场景"), call \`add_to_portrait_library\` first,
  then pass the returned \`asset://assetId\` into \`referenceImages\` /
  \`referenceVideos\` / \`referenceAudios\` (全能参考), or \`firstFrame\` if the user
  asked for strict first-frame mode.
- To reuse an earlier character/scene ("还是上次那个人/同一角色"), call
  \`list_portrait_library\` to find the matching \`asset://assetId\` and reference
  it — this is what keeps identity consistent.
- The user can also pick assets on the 人像库 page and give you an
  \`asset://assetId\` directly — pass it straight in without conversion.

## Notes

- One \`generate_video\` call produces ONE video. For several videos, call the
  tool once per video, reusing the same asset:// references for character
  consistency. You MAY run multiple in parallel — but **if you're about to launch
  20 or more video tasks at once, STOP and confirm with the user first**: each
  video costs money and renders ~1–3 min, so a large batch is a real time/cost
  commitment worth a quick "确认要并发生成 N 个视频吗?".
- Local input files are handled for you: small files are inlined, larger files
  are relayed through the app's upload pipeline automatically — pass plain
  local paths and let the tool deal with size limits (images ≤30MB,
  video/audio ≤50MB & 4–15s).
- To self-check quality, build an ffmpeg 九宫格 contact sheet and \`view_image\`
  that (see the QA section above) — never open the resulting MP4 with view_image
  or read its raw bytes; the user is already watching it play in the chat.
- **Background saving never blocks you.** Success is decided by the render: once
  the banner says DONE the video is already playing, even if the local file is
  still saving in the background (\`persistencePending\`). Treat the task as
  COMPLETE and reply right away — do NOT wait for, poll, or re-check the save.
`

export const CATIMATION_VIDEO_SKILL: FirstPartySkill = {
  name: 'catimation-video',
  content: CATIMATION_VIDEO_SKILL_CONTENT,
}

const CATIMATION_PORTRAIT_LIBRARY_SKILL_CONTENT = `---
name: catimation-portrait-library
description: >-
  Autonomously manage the CATIMATION portrait library (人像库 / 素材库) — the
  persistent, deduplicated pool of image / video / audio assets that powers video
  generation and keeps characters & scenes consistent. Use whenever the user
  mentions 人像库 / 素材库 / 参考素材 / 角色库, wants to save / 收藏 / 搜索 / 整理 / 重命名 / 分组 /
  删除 / 下载 a reference asset, or whenever you need an asset for 视频生成 / video
  generation. Add, search, organize, rename, group, hide, download proactively.
---

# Autonomously manage the CATIMATION portrait library (人像库)

The portrait library is a persistent, content-deduplicated pool of image /
video / audio assets. It feeds \`generate_video\` (reference images, first/last
frames) and keeps the SAME character or scene consistent across clips. Four
\`catimation\` MCP tools let you manage it — use them proactively; you do not
need permission to add, search, organize, or download on the user's behalf.

## Tools

- **\`add_to_portrait_library\`** — upload ONE asset. \`source\` may be a local
  file path, \`data:\` URL, \`https\` URL, or an existing \`asset://assetId\`. Kind
  (image/video/audio) is auto-detected (override with \`kind\`); for people use
  \`imageCategory: image_people\` (default). Identical content dedupes to the same
  \`assetId\`. Returns \`{ assetId, assetUrl, name, duplicated }\`. **图像** asset 的
  \`assetUrl\` (\`asset://…\`) 可直传 \`generate_video\`;但**视频/音频 asset 不直接当视觉参考**
  ——先用 \`ffmpeg-win\` 抽干净关键帧 / 拼宫格图(或抽音轨),把**静帧 / 音频**入库再喂,原始
  视频仅留底(尤其是 Seedance 自产片段,整段回喂会二次编码、画质打折)。
- **\`list_portrait_library\`** — search / browse. Optional \`query\` (name text),
  \`kind\` (\`all\`/\`image_people\`/\`image_environment\`/\`video\`/\`audio\`),
  \`group\`, \`page\`, \`pageSize\`, \`includeHidden\`. Returns items with
  \`assetId\`, display name, kind, custom \`group\`, and \`asset://assetId\`. This
  is how you FIND material and look up assetIds before editing/downloading.
- **\`edit_portrait_library\`** — organize via \`action\`:
  \`rename\` (\`assetId\` + \`name\`), \`move_group\` (\`assetIds\` + \`group\`; omit
  \`group\` to ungroup), \`hide\` / \`unhide\` (\`assetIds\`; hide = soft-delete,
  recoverable), \`new_group\` / \`delete_group\` (\`group\`). Edits appear live on
  the user's 人像库 page.
- **\`download_portrait_asset\`** — save an asset locally; pass the \`sourceUrl\`
  from \`list_portrait_library\`. Returns the saved local path.

## 审核闸门(上传后别立刻拿去生成 ⚠️)

\`add_to_portrait_library\` 上传**新**素材后,上游会先做**内容审核(审核)**。审核
未通过 / 仍在审核中的素材,直接把它的 \`asset://assetId\` 喂给 \`generate_video\`
**会让生成任务直接失败**(如 \`内容审核未通过\` / 素材不可用)。所以:

- ✅ **复用库里已存在的素材最稳**——它们早已审核通过。
- ✅ \`add_to_portrait_library\` 返回 \`duplicated: true\` = 命中去重 = 已在库 =
  已审核,**可以立刻用**。
- ⛔ 全新上传(\`duplicated: false\`)**不要审核没过就抢着生成**:先确认审核通过
  ——用 \`list_portrait_library\` 能正常查到、人像库页面对该素材无「审核中 / 待审核」
  标记后再 \`generate_video\`;或直接告诉用户「素材正在审核,通过后再生成」并停下,
  **不要赌它已通过**。
- 一句话:**先入库 → 等审核过 → 再生成**,顺序不能颠倒。

## Proactive workflows

1. **User mentions video generation with material** → \`add_to_portrait_library\`
   each provided image/video/audio FIRST. Then — only after it clears review
   (see 审核闸门 above; a \`duplicated:true\` result is already reviewed) —
   reference the returned \`asset://assetId\` in \`generate_video\`. (Images passed
   directly to \`generate_video\` are auto-imported; videos/audio and any "save
   for later" material are on you.)
2. **Reuse a character/scene** ("还是上次那个人 / 同一个角色 / 同一个场景") →
   \`list_portrait_library\` to find the matching \`asset://assetId\`, then
   reference it — this is what keeps identity consistent.
3. **User likes a generated image and may reuse it** → proactively
   \`add_to_portrait_library\` it (\`imageCategory: image_people\` for people).
4. **Tidy up** → give new assets clear names (\`rename\`) and group related
   material (\`new_group\` + \`move_group\`) when it helps the user find things.
5. **Save/export** → \`list_portrait_library\` to get the \`sourceUrl\`, then
   \`download_portrait_asset\`.

## Notes

- The library can be LARGE. \`list_portrait_library\` is paginated — narrow first
  with \`query\`/\`kind\`/\`group\`, read the returned \`page\`/\`totalPages\`/\`hasMore\`,
  and when \`hasMore\` is true page through with \`page:N+1\`. Do NOT crank up
  \`pageSize\` to dump everything (large results get truncated and waste context).
- Always \`list_portrait_library\` to obtain \`assetId\` / \`sourceUrl\` before any
  \`edit_portrait_library\` or \`download_portrait_asset\` call — do not guess ids.
- All four tools need the Seedance **API Key AND API Secret** configured
  (Settings → Seedance; the library interface is HMAC-signed). If missing, the
  tool tells you to ask the user to set them — relay that and stop.
- Renaming / grouping / hiding is a local organizing layer shared with the UI;
  it never deletes upstream data (hide is reversible via \`unhide\`).
`

export const CATIMATION_PORTRAIT_LIBRARY_SKILL: FirstPartySkill = {
  name: 'catimation-portrait-library',
  content: CATIMATION_PORTRAIT_LIBRARY_SKILL_CONTENT,
}

const CATIMATION_BRAINSTORM_SKILL_CONTENT = `---
name: catimation-brainstorm
description: >-
  Co-direct open-ended or high-value creative work in CATIMATION via clickable
  choice cards (the ask_user tool). Trigger when the user is vague/ambitious
  about a video/image ("做个宣传片" / "来点有电影感的" / "帮我想想" / "随便发挥"), asks to
  brainstorm / 头脑风暴 / 给我几个方案 / 你来引导, OR asks you to offer choices
  ("给我几个选项" / "让我选" / "二选一" / "可选" / "options" / "which should I"). Ask ONE
  focused question at a time with concrete options. Skip for clear simple asks.
---

# Brainstorm + co-direct with clickable choices

For open-ended or high-stakes creative requests, don't guess silently and don't
dump a wall of questions. Shape the work **with** the user using the
\`ask_user\` tool, which renders a real clickable card in the chat (single-select,
multi-select, free text, or skip). The user taps a choice and you continue.

## When to use this

- **Use it** when the ask is vague / ambitious / high-value: 「做个产品宣传片」
  「来个有电影感的片段」「帮我想个开场」「随便发挥」, the user asks to brainstorm or be
  guided, OR asks you to offer choices: 「给我几个选项」「让我选」「二选一」「options」.
  Any time you'd list options as text, render them as a card instead.
- **Strong default: most of the time, put 方案 / 方向 / 选项 into a single
  \`ask_user\` card rather than a numbered text list (方案1 / 方案2 / …)** so the
  user can just tap. If you brainstormed 8 方案, the card gets 8 options. Writing
  方案 as plain text and then stopping usually leaves the user nothing to click —
  prefer the card. (Not an absolute rule: it's fine to stay in plain text when the
  user is clearly just discussing/iterating and isn't being asked to pick yet.)
- **Skip it** for clear, simple asks (「把这张图做成 5 秒视频」「生成一只猫」). A
  pop-up there just annoys the user — pick sensible defaults and go.

## The flow

1. **One question at a time.** Call \`ask_user\` with a short \`question\` and
   **as many concrete \`options\` as the situation needs** — usually 3–6, and up to
   8 when you genuinely have that many distinct directions. There is **no 4-option
   cap**; list every real 方案 you came up with. Each option = a short \`label\` +
   optional one-line \`description\` trade-off. (Don't stack five *questions* into
   one card — many *options* for ONE question is fine.)
2. **Recommend.** Put the option you'd suggest first and say why in its
   description — you're a director with a point of view, not a form.
3. **Pick the mode:**
   - \`mode: "single"\` — one choice (景别 / 风格 / 时长).
   - \`mode: "multi"\` — combinable choices (要哪些元素 / 多个风格标签).
   - no options + \`allowFreeText\` — open question (片名 / 一句话主题).
   - keep \`allowSkip: true\` so the user can hand the decision back to you.
4. **Act on the answer.** The tool returns the chosen option ids + labels and any
   free text. If the user skipped, choose a sensible default and say what you
   picked. Then continue (e.g. load a local craft skill, write the prompt, call
   \`generate_video\` / \`generate_image\`).
5. **Converge fast.** 1–3 questions is usually enough. Stop asking once you have
   what you need; over-interrogating is worse than a good default.

## Example

\`\`\`
ask_user({
  question: "这个宣传片想要什么气质?",
  options: [
    { id: "cinematic", label: "电影感 / 高级", description: "低饱和、浅景深、慢运镜（推荐）" },
    { id: "energetic", label: "活力快剪", description: "高饱和、快切、强节奏" },
    { id: "clean", label: "干净产品图风", description: "纯色背景、聚焦产品" }
  ],
  mode: "single",
  allowSkip: true
})
\`\`\`

## 怎么把弹窗真正弹出来(直接调用,别只是「想」)⚠️

想给用户弹选择卡片,就是**直接调用工具 \`ask_user\`**(带 question + options),
名字就是字面的 \`ask_user\`(它和 \`generate_image\` / \`canvas_snapshot\` 一样,**永远直接可调用**,
不需要先搜索/加载)。不要在脑子里盘算「要不要用 / 它是不是没暴露」——盘算不会弹窗,调用才会。

## Notes

- \`ask_user\` BLOCKS until the user answers — that's intended; just await it.
- **工具名就是字面的 \`ask_user\`(带下划线),直接照抄调用,别自己拼前缀。**
  万一真返回 \`unsupported call\`,**不要反复重试各种变体**——立刻退回**编号文字选项**
  (方案1 / 方案2 / …,让用户回个数字)继续推进,别让流程卡死。
- This skill is general-purpose: use it for video, image, or any creative
  decision that's genuinely the user's to make.
- It pairs with \`catimation-video\` / \`catimation-image\`: brainstorm here, then
  generate there.
`

export const CATIMATION_BRAINSTORM_SKILL: FirstPartySkill = {
  name: 'catimation-brainstorm',
  content: CATIMATION_BRAINSTORM_SKILL_CONTENT,
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

const CATIMATION_CANVAS_SKILL_CONTENT = `---
name: catimation-canvas
description: >-
  Interactive AI image canvas (tldraw) in the CATIMATION desktop app. Trigger when
  the user wants to work on the 画布 / canvas, place a generated image there, or
  iterate on an image by drawing annotations (arrows+notes, circles, boxes).
  Especially trigger on 打开画布 / 开启自动修图 / 自动修图模式 / 按标注修图 / 在画布上改图 / canvas edit.
  The canvas AUTO-SUBMITS an edit request when the user finishes annotating (no
  button); keep watching for and applying those. Uses the canvas_* + generate_image tools.
---

# CATIMATION Canvas — generate on canvas + auto-edit from annotations

The canvas is an infinite tldraw surface embedded in the Codex page. You drive it
through MCP tools; the user draws on it. There is **no manual submit button** — when
the user finishes annotating, the canvas auto-enqueues an edit request and you pick
it up via the watch loop below.

## Open the canvas

Call \`canvas_open\` first (idempotent). If the canvas is not visible the tool opens
it as the active center tab.

## See what's on the canvas

You CAN inspect the canvas — do not tell the user you cannot see it. Call
\`canvas_snapshot\`: it returns a structured list of every shape (images, dashed
holders, arrows/circles/text annotations with their positions/bounds, plus each
image's \`assetId\`/\`assetPath\`/intrinsic size) AND an \`imagePath\` — a real on-disk
PNG render of the whole canvas. Open/view that \`imagePath\` to actually see the
pixels (layout, what the user drew, current image). Use \`canvas_snapshot\` whenever
the user asks "what's on the canvas / 看一下画布", or before editing so you know the
exact target and where the marks are.

### Picking and fetching one image (list → fetch)

When you need to act on a specific image (not the whole layout), prefer the
focused pair instead of eyeballing the full snapshot:

1. \`list_canvas_images\` (cheap, read-only) → a flat index of image shapes:
   \`shapeId\`, \`assetId\`, on-canvas \`w\`/\`h\`, \`role\`, \`version\`, \`assetPath\`, and
   \`hasFile\`. Use it to choose the right \`shapeId\`.
2. \`get_canvas_image { shapeId }\` → that one image's focused metadata plus an
   \`imagePath\` — an on-disk PNG of just that image, **annotations excluded**. This
   is the clean edit source: pass its \`imagePath\` to \`generate_image\` as a
   \`referenceImages\` entry. Never claim you can't find the image's file — fetch it
   here. (If \`hasFile\` was already true in the list, \`assetPath\` is also usable.)

## Open-canvas hook

When the user opens the canvas themselves, the next turn arrives with a leading
\`[canvas]\` note telling you the canvas is now the active surface. Treat it as a
signal to stay in canvas mode: the canvas is already open (no need to call
\`canvas_open\`), and if you need to know what's on it, call \`canvas_snapshot\`
before acting. Do not echo the \`[canvas]\` note back to the user.

## Generate an image onto the canvas

1. \`prepare_image_generation\` with the user's request + aspect ratio → returns a
   holder shape id, bounds, and a suggested prompt.
2. \`generate_image\` with that prompt (and any \`referenceImages\` the user gave).
3. \`insert_image_into_holder\` with the returned \`holderShapeId\` + the generated
   image path. The image now lives on the canvas.

## Put a video on the canvas

After you generate a video (e.g. a Seedance/Sora clip), call \`insert_video\` with
\`videoPath\` (the local file path) to drop it onto the canvas as a real video shape
that plays inline. Optional \`x\`/\`y\` to position it (e.g. next to its source image)
and \`w\`/\`h\` to size it — omit them to use the clip's intrinsic size (capped to
640px on the longest edge). Use this for "把视频也放到画布上 / 出个视频放上去" requests.
(The user can also drag a file straight from the workspace file tree — or the OS —
onto the canvas; images and videos land as real shapes. \`insert_video\` /
\`insert_image_into_holder\` are the programmatic paths so YOU can place media
precisely.) For text/labels, use
\`canvas_exec\` to create a \`text\`/\`note\` shape (\`toRichText\` is injected).

To go the OTHER way — get a canvas video's file back so you can ffmpeg / contact-sheet
it — call \`get_canvas_video\` (no args; acts on the selected, or only, video). It
returns \`videoPath\`: an absolute on-disk mp4/webm/mov (the clip's recorded path, or a
materialized copy if it had none) plus \`shapeId\`/\`assetUrl\`/\`title\`. This is the video
analog of \`list_canvas_images\`→\`get_canvas_image\`: never hunt the disk by filename for
a canvas clip. (For semantic 理解/分析 of the clip instead, use \`understand_canvas_video\`.)

## Auto-edit mode (Codex 直接监听) — the main loop

When the user says 开启自动修图 / 自动修图模式 (or asks you to keep applying canvas edits),
enter this loop and DO NOT stop until the user tells you to:

1. Call \`watch_edit_requests\` (it long-polls ~25s and claims the next request). If
   it returns nothing, call it again — keep looping.
2. When a request arrives, set it to processing if useful, then call
   \`generate_image\` with the request's \`editPrompt\` and pass its \`targetImagePath\`
   as a \`referenceImages\` entry (image-to-image edit). \`targetImagePath\` is ALWAYS a
   real, on-disk PNG that the canvas exported for you — use it directly; never claim
   the file is missing.
3. **Geometry-only marks** (\`needsClarification: true\`, e.g. the user drew an arrow,
   circle, or box but no text label): the marks tell you WHERE to change; take WHAT
   to change from the user's most recent chat instruction (e.g. "人物换成真人"). Combine
   them into the edit and proceed — do NOT dead-end. Only stop and ask one short
   question if neither the annotations nor the recent conversation give any intent.
4. Call \`create_image_version\` with \`sourceShapeId\` = the request's
   \`targetShapeId\` and the new image path. This places the new version **to the
   right of the original and preserves the old image** — never overwrite it.
5. Call \`update_edit_request\` with \`status: 'completed'\` (or \`needs_clarification\`
   only when there is genuinely no intent anywhere).
6. Go back to step 1.

If the watch loop has been idle for a long time and stops, the canvas shows the
user that you've paused; when they ask you to continue, just re-enter the loop.

## Reading annotations directly (one-off, no loop)

To apply the current marks once without the loop: \`prepare_annotation_edit\`
(optionally with a \`targetShapeId\`) returns the parsed annotation plan + a ready
\`editPrompt\`. Then do generate_image → create_image_version exactly as above.

## Free-form canvas control (canvas_exec + canvas_search)

For layout/edits the fixed tools above don't cover — move, align, distribute,
group, delete, resize, reorder, draw custom shapes/connectors — use the escape
hatch:

1. \`canvas_search { code }\` (read-only): write JS that gets \`spec\` and returns a
   result, to discover the Editor API. e.g.
   \`return spec.members.filter(m => m.category === 'layout').map(m => m.signature)\`
   or \`return spec.types.shapes.find(s => s.shapeType === 'arrow')\`.
2. \`canvas_exec { code }\`: write JS that runs on the live tldraw \`editor\`. In scope:
   \`editor\` (real tldraw Editor API) + helpers \`createShapeId\`, \`createBindingId\`,
   \`createArrowBetweenShapes(fromId,toId,{text?,bend?})\`, \`boxShapes(ids,{text?,color?})\`,
   \`zoomToFit(ids)\`, \`Box\`, \`Vec\`, \`Mat\`, \`clamp\`, \`getArrowBindings\`, \`toRichText\`.
   Use \`return\` to read data back. Examples:
   - \`return editor.getCurrentPageShapes().map(s => ({ id: s.id, type: s.type }))\`
   - \`editor.createShape({ type:'geo', x:200, y:120, props:{ geo:'rectangle', w:320, h:180 } })\`
   - \`createArrowBetweenShapes('shape:a','shape:b',{ text:'next' })\`
   - \`editor.distributeShapes(editor.getSelectedShapeIds(), 'horizontal')\`

\`canvas_exec\` returns \`{ success, result?, error? }\`. On \`success:false\` the code did
NOT apply — read \`error\`, fix the snippet, and retry. Prefer the dedicated image
tools (insert_image_into_holder / create_image_version) for the image-version flow;
use exec for everything else. Don't delete the user's images unless asked.

## Saving / exposing the canvas as a file

\`save_snapshot\` persists the canvas and returns \`imagePath\` — an on-disk PNG of the
whole canvas you can open or share, like an uploaded attachment. Use it when the
user wants to "save / 导出 / 存一下画布".

## Restorable checkpoints (save / load / list)

Beyond the flat PNG, you can save the **full editable canvas state** and restore it
later — useful as a "fork"/branch point before risky edits, or to keep named
versions:

- \`save_checkpoint { name? }\` → saves the whole canvas (tldraw snapshot JSON) to
  disk; returns \`{ checkpointId, path, shapeCount }\`. Call this BEFORE a big/risky
  change so you can return to it.
- \`list_checkpoints\` → newest-first \`{ checkpointId, name, createdAt, shapeCount, path }\`.
- \`load_checkpoint { checkpointId }\` → **replaces** the current canvas with that
  checkpoint (switches to that branch). Save the current state first if you might
  want it back. Returns \`{ ok:false, error }\` on an incompatible snapshot instead
  of crashing the canvas.

Use checkpoints for "存个版本 / 回到之前那版 / 试一个分支" type requests. Use
\`save_snapshot\` (PNG) only when the user just wants a flat image to share.

## Notes

- Arrows with a text label = "change the thing this arrow points at, per the note".
  Circles / boxes scope a region. Bare short notes (改一下 / 不好看) are too vague —
  ask one crisp clarifying question rather than guessing.
- Keep every prior version on the canvas; iterations go left → right.
- generate_image is the in-app path that actually displays + saves the result; use
  it rather than any built-in image tool.
`

export const CATIMATION_CANVAS_SKILL: FirstPartySkill = {
  name: 'catimation-canvas',
  content: CATIMATION_CANVAS_SKILL_CONTENT,
}

const CATIMATION_UNDERSTAND_SKILL_CONTENT = `---
name: catimation-understand
description: >-
  Understand video / documents / and research the web with qwen3.7-plus-dashscope
  inside CATIMATION. Trigger to 理解/分析视频, 看懂/读 文档/PDF, or 上网查/搜一下/扒资料/最新消息.
  Also the model understand/review stage of the multimedia inspect→verify loop that
  fires for ANY video/audio task (not just 审片): judge content here with
  understand_video, then hand technical QC + fixes back to the ffmpeg-win skill.
  视频理解以 qwen(understand_video)为主、apiyi 为辅;apiyi 的 Gemini(gemini-3.5-flash,
  禁传 2.5)主要做音频理解(qwen 音频不好)和视频的深度理解。
---

# CATIMATION Understand — video / document / web via qwen

These tools run on qwen through the same new-api gateway and Miau token used for
image/video generation, and return Chinese text answers. **Model defaults to
\`qwen3.7-plus-dashscope\`** (cheaper); pass \`model="max"\` on any tool for the
stronger \`qwen3.7-max-dashscope\`. You rarely need to: if plus fails, the renderer
automatically retries once on max as a fallback. Only ask for \`max\` when plus
struggles on a hard clip or the user explicitly wants the strongest model.

## When to use

- "理解 / 分析这个视频"、"这段视频在干什么" → \`understand_video\`
- "理解 / 分析画布上(选中)的这段视频" → \`understand_canvas_video\`
- "读一下这份文档 / PDF 讲了什么" → \`understand_document\`
- "上网查 / 搜一下 / 最新消息 / 扒点资料" → \`web_research\`
- "审查/审片/检查内容"、"剧情/字幕/连续性对不对",或任何**理解/处理 视频音频 前后**的核对 → \`understand_video\`(你是多媒体 inspect→verify loop 的内容阶段,见下)

## 多媒体 inspect→verify loop — 你是「模型内容理解/审查」这一阶段(不要单干)

**不止「发布前审片」**:只要任务要**理解或处理 视频 / 音频 / 多媒体文件**,就走一个
**跨两个技能的 inspect → process → verify 大循环**(由 **ffmpeg-win** 技能主导编排),
而且 **agent 自主触发、别等人催**:

\`\`\`
ffprobe 粗检(ffmpeg-win) → 九宫格视觉(ffmpeg-win) → 模型内容理解/审查(你 · understand_video)
   → 不达标/要改 → ffmpeg 修复 + 回到粗检复检(ffmpeg-win) → 发布前 checkpoint(ffmpeg-win,仅交付时)
\`\`\`

何时触发(不只成片):**理解/分析**一段视频音频前,先让 ffmpeg-win probe 摸清真实
时长/码流再下判断;**处理**(转码/剪辑/拼接/提取音频/加 BGM)前 probe 输入、处理后回来
复核输出;**刚生成**的视频先 grid+理解再说「做好了」;**发布/交付前**才走完整闭环到 checkpoint。

你负责的是**内容那一半**:用 \`understand_video\` 看这条片子的 **剧情 / 字幕 / 动作 /
连续性 / 有无穿帮错字**,对照需求给出「过 / 不过 + 具体问题」。

- 用户说「审查这部片子」而你被叫起来时:先用 \`understand_video\` 做内容审查并报告
  发现,**然后把技术问题(分辨率/响度/编码/odd 尺寸/转码/拼接修复)和发布前
  checkpoint 交回 ffmpeg-win 技能**——那些是像素/码流层面,不是你的活。
- 不要假装能判分辨率/响度/编码是否达标;也不要替 ffmpeg-win 跑修复。各司其职、
  互相衔接,才是一个完整的审片闭环。

## Tools

### understand_video { video_url | video_path, question, fps? }
Pass EITHER a public http(s) \`video_url\` OR a local \`video_path\`. qwen only
accepts publicly reachable URLs, so a local path (or a \`data:\` URL) is
**auto-uploaded to the history COS bucket** (\`image-history/media-relay/*\`,
≤200MB) and the resulting public URL is used — you do NOT need to upload
manually. \`fps\` is an optional sampling hint (reserved). Returns a description
of 画面/动作/字幕/剧情.

### understand_canvas_video { question, model?, annotate? }
Understand the video **selected on the canvas** (or the only video if none is
selected) — NO url/path needed: the canvas exposes the clip's source itself, and
a local source is auto-uploaded to COS just like \`understand_video\`. This works
even for a clip you **dragged in from the desktop** (its bytes live in the
canvas store with no recorded path — it's materialized to a real file first). By default
it also **writes the result back onto the canvas as a text note** next to the
video; pass \`annotate=false\` to only return the text. Requires the Canvas tab
open. Use this for "理解画布上选中的这段视频" instead of asking the user for a URL.

### understand_document { file_url | file_path, question }
Pass EITHER a public \`file_url\` OR a local \`file_path\` (auto-uploaded to COS
just like video, ≤200MB). Native document understanding is only PARTIAL
upstream — for best results render the page(s) to image(s) and pass an image,
or extract the text and just ask normally.

### web_research { query }
Natural-language query; the tool sets \`enable_search\` so the answer incorporates
live web results. Prefer this over guessing from stale memory; cite what you used.

## apiyi-mcp(Gemini)为辅:音频理解 + 视频深度理解(常规视频理解仍 qwen 为主)

常规「看懂这段视频」**仍以上面的 qwen \`understand_video\` 为主**(便宜、够用)。但有两类
情况改用 **apiyi-mcp 的 Gemini**(\`generate_content\`,直接吃媒体文件):

- **音频理解**:qwen 对音频要么不收(返回 \`incorrect modal 'audio'\`)要么质量差 → 走 apiyi。
- **视频的深度理解**:需要更细的剧情 / 细节 / 多模态深读,或 qwen 的结论不够 → 用 apiyi 复核 / 补强。

用法:
1. 确认 **\`apiyi\` MCP 已启用**(应用「MCP 服务器」页;\`APIYI_API_KEY\` 已由应用自动复用
   「API 设置」里的 api易 key,无需手填)。
2. 调 apiyi 的 **\`generate_content\`**,带音频 / 视频文件 + 你的问题。**\`model\` 固定用
   \`gemini-3.5-flash\`(为主);绝不要传 \`gemini-2.x\`(\`gemini-2.5-*\` 旧 id)——已弃用、
   明显掉点。** 要最深推理时才手动切 \`gemini-3.1-pro-preview-thinking\`,默认不切。

**音频兜底(仅当 apiyi MCP 不可用 / 未配 key 时)**:用 **ffmpeg-win** 把音频转成带占位画面的
MP4(\`ffmpeg -i in.mp3 -f lavfi -i color=c=black:s=640x360 -shortest -c:v libx264 out.mp4\`),
再用 qwen \`understand_video\` 传该 MP4 \`video_path\`——并说明这是次选兜底,效果不如 apiyi 的 Gemini。

## Path B — delegate to a qwen subagent (only when explicitly asked)

For heavy/parallel/independent understanding jobs (e.g. "分头读这三份文档并汇总",
"开个子代理去查资料"), and ONLY when the user explicitly asks for delegation or
parallel work, spawn a subagent **pinned to the qwen provider**:
\`modelProvider="qwen"\`, \`model="qwen3.7-max-dashscope"\`. The subagent does the
understanding/research and reports a distilled result; you synthesize.

Discipline: do NOT spawn subagents just because a task could be split — user
intent controls it. If the Miau token is not configured, the qwen provider is
unavailable; fall back to calling the three tools directly and tell the user.

## Boundaries

- Media reaches qwen as a public URL; local paths / \`data:\` URLs are
  auto-uploaded to the history COS bucket first (≤200MB; larger → compress).
- Documents: partial support; degrade to page-image or extracted-text + ask.
- On a clean result, do NOT retry; just answer the user.
`

export const CATIMATION_UNDERSTAND_SKILL: FirstPartySkill = {
  name: 'catimation-understand',
  content: CATIMATION_UNDERSTAND_SKILL_CONTENT,
}

/**
 * First-party skills no longer shipped by default. If an older app version
 * installed an app-managed copy, remove it on startup so Codex stops discovering
 * it. User-edited copies are preserved.
 */
const RETIRED_FIRST_PARTY_SKILL_NAMES = ['catimation-subagents']

const CATIMATION_FFMPEG_WIN_SKILL_CONTENT = `---
name: ffmpeg-win
description: Process video/audio with FFmpeg 8.1, preferring the bundled local ffmpeg/ffprobe CLI (on PATH, zero Docker, zero install) with the ffmpeg-win Docker MCP tool as a parallel fallback. Use for transcoding, resizing, trimming, speed change, compression, audio extraction, concat, cropping, fades, overlays, thumbnails, GIFs, inspection, and the technical half of the inspect→process→verify loop that fires for ANY video/audio/multimedia task — autonomously probe the input BEFORE processing and verify the output AFTER, not just at 发布前审片 (ffprobe 粗检 + 九宫格视觉 + loudness + 修复 + release checkpoint; hands off to catimation-understand for model content review). Triggers on "用 ffmpeg", "处理/理解视频", "转码/压缩/裁剪/拼接视频", "提取音频", "竖屏适配", "加 BGM", "拿到一个视频/音频文件", "审片/质检/检查成片质量", "能不能发/达标了吗", "ffmpeg-win", or any multimedia handling / CATIMATION 出片 post-processing. References cover filters, codecs, audio, streaming/hwaccel, platform export, and the CATIMATION workflow.
---

# FFmpeg (local CLI preferred · ffmpeg-win Docker MCP fallback)

This skill drives FFmpeg through **two interchangeable backends**. Every recipe
below is written as a **Backend A command** (\`ffmpeg …\` with native Windows
paths) — decide the backend once (Step 0), then run that command on Backend A,
or map it to the Backend B tool call (it's a mechanical transform, see below).

## Step 0 — Pick the backend (do this first)

Probe the environment once via the shell:

\`\`\`
ffmpeg -version
\`\`\`

- **It prints a version → Backend A (LOCAL CLI). Prefer this.** This CATIMATION
  desktop app bundles a full gyan.dev **FFmpeg 8.1** (\`ffmpeg.exe\` + \`ffprobe.exe\`)
  and injects it onto the agent's PATH, so Backend A normally just works — **no
  Docker, no install**. You get native Windows paths, a real \`ffprobe\`, and no
  container overhead. Use it well: this is the default.
- **No shell available, or \`ffmpeg\` not found → Backend B (DOCKER MCP).** Use the
  **\`ffmpeg-win\`** MCP tool (runs the \`zuozuoliang999/ffmpeg:8.1-cli\` image, needs
  Docker Desktop running). It auto-converts Windows paths and needs no local
  binary. This is the **parallel fallback** for environments without a local
  ffmpeg.

Both backends are FFmpeg 8.1 with the same codecs/filters, so every recipe is
identical — only the *call shape* differs.

## The two call shapes

**Backend A — local CLI (preferred).** Run the recipe's \`ffmpeg\` / \`ffprobe\`
command directly with normal Windows paths. The shell is available:

\`\`\`
ffmpeg -y -i "D:/in/input.mov" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "D:/out/output.mp4"
\`\`\`

**Backend B — ffmpeg-win MCP tool (fallback).** Take the SAME command, **drop the
leading \`ffmpeg\`**, split the rest into the \`args\` array (one token per element,
filter strings whole), and wrap it with a drive-root \`basedir\`:

\`\`\`json
{ "name": "ffmpeg-win", "arguments": { "basedir": "D:/", "args": ["-y","-i","D:/in/input.mov","-c:v","libx264","-preset","medium","-crf","23","-c:a","aac","-b:a","128k","D:/out/output.mp4"] } }
\`\`\`

Every recipe section below gives the **Backend A command** once. For **Backend B**
apply that one transform (drop \`ffmpeg\`, tokenize into \`args\`, add \`basedir\`).

### Universal rules (both backends)

1. **Always pass \`-y\` first** — there is no TTY, so an overwrite prompt hangs.
2. **One token per arg** (matters for Backend B). A filter string is ONE token:
   \`-vf scale=1920:1080\` → \`["-vf","scale=1920:1080"]\`; never split
   \`scale=1920:1080\`.
3. **Keep filter strings whole.** On Backend A quote paths that contain spaces.

### Backend A (local CLI) specifics

- Use native Windows paths directly (\`D:/folder/file.mp4\`) — **no \`basedir\`, no
  \`/work\` mounting**.
- The shell IS available, but for batches prefer enumerating the files and
  running one \`ffmpeg\` call per file (portable, and matches Backend B).
- **\`ffprobe\` IS available** — use it for inspection (see [Inspect](#inspect)).
- Hardware encoders (\`h264_nvenc\`/\`hevc_nvenc\`/\`*_qsv\`/\`*_amf\`) work when the host
  GPU/driver supports them — the bundled build enables nvenc/qsv/amf/vaapi/d3d11/
  d3d12; fall back to \`libx264\` if a HW encoder errors.

### Backend B (Docker MCP tool) specifics

- \`basedir\` **MUST be a drive root** (\`D:/\`, \`E:/\`, \`C:/\`); subdirs auto-correct
  to the root. The whole drive mounts at \`/work\`; full \`D:/...\` paths auto-convert.
- **No shell**: no \`for\` loops, no \`|\` pipes, no \`>\` redirects, no \`&&\`, no
  \`*.mp4\` globs. Batch = call the tool once per file.
- **5-minute timeout** — prefer \`-preset fast\`, trim first, or split big jobs.
- **No standalone \`ffprobe\`** here — inspect with \`ffmpeg -i\` instead. For images
  use \`imagemagick-win\`; to check a file exists use \`file-exists-win\`.
- **concat list files** can't be made with \`echo\` — write the list with your
  file-write tool first (it lands on the mounted drive), then point \`-f concat\`
  at it. Hardware encoders are usually unavailable inside the Linux container;
  prefer \`libx264\`/\`libvpx-vp9\`.

## Transcode

\`\`\`
ffmpeg -y -i "D:/in/input.mov" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "D:/out/output.mp4"
\`\`\`

WebM (VP9 + Opus):

\`\`\`
ffmpeg -y -i "D:/in/input.mp4" -c:v libvpx-vp9 -crf 30 -b:v 0 -c:a libopus -b:a 128k "D:/out/output.webm"
\`\`\`

## Resize

Exact size:
\`\`\`
ffmpeg -y -i "D:/in.mp4" -vf scale=1920:1080 "D:/out.mp4"
\`\`\`
Keep aspect ratio (letterbox):
\`\`\`
ffmpeg -y -i "D:/in.mp4" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" "D:/out.mp4"
\`\`\`
Crop to fill (no bars):
\`\`\`
ffmpeg -y -i "D:/in.mp4" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" "D:/out.mp4"
\`\`\`
Scale to width, auto even height: \`-vf scale=1280:-2\`. Half size: \`-vf scale=iw/2:ih/2\`.

## Trim and Cut

Re-encode (accurate — recommended):
\`\`\`
ffmpeg -y -i "D:/in.mp4" -ss 00:00:30 -t 00:00:15 -c:v libx264 -c:a aac "D:/clip.mp4"
\`\`\`
Start→end:
\`\`\`
ffmpeg -y -i "D:/in.mp4" -ss 00:00:30 -to 00:00:45 -c:v libx264 -c:a aac "D:/clip.mp4"
\`\`\`
Fast seek for big files (put \`-ss\` before \`-i\`), stream copy:
\`\`\`
ffmpeg -y -ss 00:10:00 -i "D:/big.mp4" -t 00:05:00 -c copy "D:/clip.mp4"
\`\`\`
**Note:** \`-c copy\` is fast but may drop frames at non-keyframe cut points. Re-encode when accuracy matters.

## Speed Adjustment

2x (video + audio):
\`\`\`
ffmpeg -y -i "D:/in.mp4" -filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]" -map "[v]" -map "[a]" "D:/fast.mp4"
\`\`\`
0.5x slow motion: \`setpts=2.0*PTS\` + \`atempo=0.5\`. Video only: \`-filter:v setpts=0.5*PTS -an\`.

Calculate: to fit X sec into Y sec → speed = X/Y; \`setpts\` multiplier = 1/speed; \`atempo\` = speed (chain \`atempo\` for >2x or <0.5x, e.g. 4x = \`atempo=2.0,atempo=2.0\`).

## Compress

\`\`\`
ffmpeg -y -i "D:/in.mp4" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k "D:/out.mp4"
\`\`\`
Target bitrate (~10MB/60s ≈ 1300k): \`-b:v 1300k\`. Smaller web preview: \`-crf 28 -preset fast\`. Platform targets → [references/platform-export.md](references/platform-export.md).

## Extract / Convert Audio

To MP3:
\`\`\`
ffmpeg -y -i "D:/in.mp4" -vn -acodec libmp3lame -q:a 2 "D:/out.mp3"
\`\`\`
To AAC: \`-vn -acodec aac -b:a 192k "D:/out.m4a"\`. To WAV: \`-vn "D:/out.wav"\`. Volume: \`-filter:a volume=1.5\`. More → [references/audio-processing.md](references/audio-processing.md).

## Crop

\`crop=w:h:x:y\`:
\`\`\`
ffmpeg -y -i "D:/in.mp4" -vf crop=640:480:100:50 "D:/out.mp4"
\`\`\`
Center crop to 16:9: \`crop=ih*16/9:ih\`.

## Concatenate

1. Write a list file with your file-write tool. On **Backend A** use native
   Windows paths; on **Backend B** the same \`D:/...\` paths auto-map to \`/work/...\`
   (you may also write \`/work/in/clipN.mp4\`). Example \`D:/in/list.txt\`:
   \`\`\`
   file 'D:/in/clip1.mp4'
   file 'D:/in/clip2.mp4'
   file 'D:/in/clip3.mp4'
   \`\`\`
2. Same codec/resolution (fast):
   \`\`\`
   ffmpeg -y -f concat -safe 0 -i "D:/in/list.txt" -c copy "D:/out.mp4"
   \`\`\`
   Different sources → re-encode: replace \`-c copy\` with \`-c:v libx264 -c:a aac\`.

## Fade

Video fade in (first 1s) + fade out (last 1s — set \`st=\` to \`duration-1\`):
\`\`\`
ffmpeg -y -i "D:/in.mp4" -vf "fade=t=in:st=0:d=1,fade=t=out:st=9:d=1" -c:a copy "D:/out.mp4"
\`\`\`
Audio fade:
\`\`\`
ffmpeg -y -i "D:/in.mp4" -af "afade=t=in:st=0:d=1,afade=t=out:st=9:d=1" -c:v copy "D:/out.mp4"
\`\`\`

## Overlay / Composition

Watermark bottom-right:
\`\`\`
ffmpeg -y -i "D:/video.mp4" -i "D:/wm.png" -filter_complex "overlay=W-w-10:H-h-10" "D:/out.mp4"
\`\`\`
Text overlay: \`-vf "drawtext=text='Hello':fontsize=24:fontcolor=white:x=10:y=10"\`.
Picture-in-picture: \`-filter_complex "[1:v]scale=320:-1[pip];[0:v][pip]overlay=W-w-10:H-h-10"\`.

## Thumbnails / GIF

Single frame at timestamp:
\`\`\`
ffmpeg -y -i "D:/video.mp4" -ss 00:00:10 -vframes 1 -q:v 2 "D:/thumb.jpg"
\`\`\`
GIF (palette, best quality/size):
\`\`\`
ffmpeg -y -i "D:/in.mp4" -vf "fps=10,scale=480:-1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "D:/out.gif"
\`\`\`

## Inspect

**Backend A (local) — use the real \`ffprobe\`** and parse its JSON from stdout:
\`\`\`
ffprobe -v error -show_entries format=duration:stream=width,height,codec_name,r_frame_rate -of json "D:/video.mp4"
\`\`\`

**Backend B (Docker MCP) — no \`ffprobe\`.** Run \`ffmpeg -i\` with no output file
(\`{ "args": ["-i","D:/video.mp4"], "basedir": "D:/" }\`); details print to the
result's \`error\` (FFmpeg writes info to stderr) — read duration / resolution /
codecs from there. To confirm a path before processing, use a normal file check
(Backend A) or **\`file-exists-win\`** (Backend B) with the full Windows path.

## Batch Processing

Enumerate the files yourself and issue **one ffmpeg call per file** — \`ffmpeg ...\`
(Backend A) or one \`ffmpeg-win\` tool call (Backend B). On Backend B verify each
input first with \`file-exists-win\` if unsure.

## Reading the Result

**Backend A:** check the process exit code (0 = success); FFmpeg logs progress and
file info to **stderr**, so non-empty stderr on success is normal.

**Backend B:** the tool returns JSON — \`success\` (exit 0), \`output\` (stdout),
\`error\` (stderr — progress AND info), and \`command\` (the docker line run).
\`success: true\` with text in \`error\` is normal — FFmpeg logs to stderr.

## Multimedia discipline (inspect → process → verify) — one staged loop across TWO linked skills

**This loop is NOT only for 发布前审片.** It is the default discipline for **ANY
task that understands or processes a video / audio / multimedia file**, and you
**trigger it autonomously — don't wait to be asked**:
- **About to understand / analyze** a clip → Stage 0 probe it FIRST (know its real
  duration / streams / codec / resolution) before you reason about or describe it.
- **About to process** it (转码 / 剪辑 / 拼接 / 压缩 / 提取音频 / 加 BGM / 竖屏适配 /
  变速 …) → probe the **input** first (Stage 0) so you choose correct params, THEN
  **verify the output** afterward (Stage 0–1, plus Stage 2 if it's narrative). Never
  hand back a file you produced without re-probing/eyeballing it.
- **Just generated** a video → grid it and understand it before claiming it's done.
- **发布/交付前审片** → run the whole loop through Stage 4 + human sign-off.

It is **NOT a single pass**, and it is **NOT all done here**. It is a **loop you
climb stage by stage**, spanning two skills that hand off to each other:

- **\`ffmpeg-win\` (this skill)** — the *technical* eye + the *fixer*: probe streams,
  build a visual contact sheet, measure loudness, and apply every repair
  (transcode / crop / loudnorm / concat / scale).
- **\`catimation-understand\`** — the *model content* eye: calls \`understand_video\`
  to judge 剧情 / 字幕 / 动作 / 连续性 / 穿帮 against the brief. ffmpeg cannot judge
  story or continuity — only pixels and streams — so that half lives there.

Run only the stages a task needs, and **escalate one stage at a time** — a plain
transcode/understand needs just a Stage 0 probe-first + a Stage 0–1 verify-after; a
quick "能不能发" needs Stage 0–1; a narrative or publish-bound deliverable runs the
whole loop. The point is: **probe before you act, verify after you act — every time
multimedia is involved**, not only at publish.

\`\`\`
Stage0 ffprobe 粗检 ──▶ Stage1 九宫格视觉 ──▶ Stage2 understand_video 模型内容审查
        │ (catimation-understand)                                  │
        └────────────  Stage3 不达标 → ffmpeg 修复 → 回到 Stage0 复检  ◀┘
                                    │ pass
                                    ▼
                       Stage4 release checkpoint + 人工签收
\`\`\`

**Stage 0 — 粗检 (ffprobe, the cheap gate).** Probe the file and judge it against
the brief:
\`\`\`
ffprobe -v error -show_entries format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate -of json "D:/out/final.mp4"
\`\`\`
Flag (and fix in Stage 3) before going further:
- **No audio stream** when the brief wanted sound (no \`"codec_type":"audio"\`).
- **Odd width/height** (not divisible by 2) → re-encode with
  \`scale=trunc(iw/2)*2:trunc(ih/2)*2\`.
- **Wrong aspect / resolution** for the target platform (e.g. not 9:16 for a Reel).
- **A/V duration mismatch** (video vs audio stream durations differ a lot).
- **Suspiciously low bitrate** for the resolution (blocky output).
On Backend B (no ffprobe) use \`ffmpeg -i\` and read the stderr report instead.

**Stage 1 — 视觉细检 (3×3 contact sheet).** You cannot "watch" an MP4 — build a
九宫格 of evenly-spaced frames and inspect that ONE montage (e.g. with the app's
\`view_image\`) to catch melting/teleporting subjects, extra limbs, artifacts, and
prompt drift:
\`\`\`
ffmpeg -y -i "D:/out/final.mp4" -vf "fps=9/<DURATION>,scale=320:-1,tile=3x3:padding=6:color=black" -frames:v 1 "D:/out/final_grid.png"
\`\`\`
Set \`<DURATION>\` to the real clip length (for a 5s clip, \`fps=9/5\`).

**Stage 2 — 模型内容审查 (hand off to the OTHER skill).** The contact sheet shows
*pixels*; it cannot tell you whether the *content* is right. Hand off to the
**\`catimation-understand\`** skill: in-app, call \`understand_video\` on the clip with
a review question — e.g. *"这段视频:剧情/字幕/动作是否符合需求?有无穿帮、错字、
连续性断裂?"*. (Outside the app, where \`understand_video\` is unavailable, use your
own video-understanding / vision tool for this stage.) This is the **content half
of the same loop** — do not skip it for anything narrative.

**Stage 3 — 修复并复检 (the loop back).** If any stage flags a problem, **fix it
here** with the recipes above (transcode / crop / \`loudnorm\` / concat / scale),
then **re-enter the loop at Stage 0** — re-probe, re-grid, re-understand. Iterate
at most **2–3 times**; each fix+recheck costs time. Loudness fix (when there's
audio): measure EBU R128
\`\`\`
ffmpeg -i "D:/out/final.mp4" -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=summary -f null -
\`\`\`
target ≈ **-14 LUFS** for web/social; if off, bake in normalization by re-encoding
with the same \`loudnorm\` as an audio filter.

**Stage 4 — 发布前 release checkpoint (only when the loop passes).** For a
publish-bound deliverable, emit a poster frame and leave it beside the contact
sheet for a human:
\`\`\`
ffmpeg -y -ss <BEST_T> -i "D:/out/final.mp4" -frames:v 1 -q:v 2 "D:/out/final_poster.jpg"
\`\`\`
Then tell the user it passed QC and point them at \`final_grid.png\` /
\`final_poster.jpg\`. **Do not auto-publish** — the loop plus human sign-off comes
first.

### Preflight guardrails (sanity-check BEFORE the encode)

Validate risky parameters before you render, so you don't produce garbage:
- **Overlay / watermark / chroma**: opacity in \`[0,1]\`; the overlaid layer fits
  inside the frame.
- **concat**: all inputs share codec, resolution, fps, and pixel format —
  re-encode mismatched inputs to a common spec first (a plain \`-f concat\` of
  incompatible clips corrupts output).
- **Audio mix**: summed volumes don't clip; use \`amix\`/\`volume\` deliberately.
- **Speed change**: alter BOTH \`setpts\` (video) and \`atempo\` (audio) together, or
  audio desyncs.
- **Animated text / grid / split-screen**: text fits on-screen and within the clip
  duration; tile/layout counts match the number of inputs.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Hangs until timeout | Missing \`-y\`, overwrite prompt | Always pass \`-y\` first |
| "height not divisible by 2" | Odd dimensions | \`-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"\` |
| "No such file or directory" | basedir not drive root, or wrong path | basedir = \`D:/\`; use full \`D:/...\` path; check with \`file-exists-win\` |
| Won't play in browser | Missing web flags | \`-movflags faststart -pix_fmt yuv420p -c:v libx264\` |
| Audio desync after speed | Only one filter changed | Use \`filter_complex\` with both \`setpts\` + \`atempo\` |
| Timeout at 5 min | Slow/large encode | \`-preset fast\`, trim first, or split job |
| Filter split into pieces | Tokens wrongly separated | Keep each filter string as ONE array element |

## Quality Guidelines

| Use case | CRF | Preset |
|----------|-----|--------|
| Master/archive | 18 | slow |
| Production | 20–22 | medium |
| Web/preview | 23–25 | fast |
| Draft | 28+ | veryfast |

Preset (faster = bigger files, quicker): \`ultrafast > superfast > veryfast > faster > fast > medium > slow > slower > veryslow\`.

## References

- [references/catimation-workflow.md](references/catimation-workflow.md) — **CATIMATION 出片速查**:竖屏 9:16 适配、拼接 Seedance 片段、加 BGM(人声闪避)、封面/压缩/GIF
- [references/reference.md](references/reference.md) — filters, codecs, CRF, containers, options
- [references/audio-processing.md](references/audio-processing.md) — normalization, noise reduction, mixing
- [references/streaming-and-hwaccel.md](references/streaming-and-hwaccel.md) — HLS/DASH + NVENC/VideoToolbox/QSV
- [references/platform-export.md](references/platform-export.md) — YouTube/X/LinkedIn/IG/TikTok/web export

> All recipes and reference snippets are plain \`ffmpeg ...\` CLI in **Backend A**
> form. **Backend A (local):** run them as-is with native Windows paths.
> **Backend B (Docker MCP):** drop the leading \`ffmpeg\`, split the rest into the
> \`args\` array (one token per element, filter strings whole), keep \`-y\`, set
> \`basedir\` to the drive root, and use full Windows paths. Hardware encoders
> (NVENC/QSV/AMF) work on **Backend A** when the host GPU/driver supports them;
> inside the **Backend B** Linux container they're usually unavailable — there
> prefer \`libx264\`/\`libvpx-vp9\`.

---
*Knowledge base adapted from [jakenuts/ffmpeg-toolkit](https://github.com/jakenuts/agent-skills). Rewritten to drive the bundled local FFmpeg 8.1 CLI (preferred) and the ffmpeg-win MCP tool (Dockerized FFmpeg, Windows-path aware).*
`

export const CATIMATION_FFMPEG_WIN_SKILL: FirstPartySkill = {
  name: 'ffmpeg-win',
  content: CATIMATION_FFMPEG_WIN_SKILL_CONTENT,
}

/** All skills this app ships into the Codex USER scope on startup. */
export const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  CATIMATION_IMAGE_SKILL,
  CATIMATION_VIDEO_SKILL,
  CATIMATION_PORTRAIT_LIBRARY_SKILL,
  CATIMATION_BRAINSTORM_SKILL,
  CATIMATION_CANVAS_SKILL,
  CATIMATION_UNDERSTAND_SKILL,
  CATIMATION_FFMPEG_WIN_SKILL,
]
