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

## Steps

1. Turn the request into one clear, descriptive prompt. Cover subject, style,
   composition, lighting, and mood. Keep it concise.
2. If the user asks for exactly ONE image, call \`generate_image\` with:
   - \`prompt\` (required): the description from step 1.
   - \`model\` (optional): rendering channel. **Omit it** for the default
     \`gpt-image-2-vip\` (stable). Only set it when the user explicitly names a
     channel (see "Choosing a model" below):
     - \`custom-imagemodel-gt\` — 腾讯 image2 (same ratio/resolution/quality spec).
       **需把 API 站点切到 Miau API**(见下方「站点要求」)。
     - \`wan2.7-image-pro\` — 阿里万相 2.7 pro (超清文生图 / 图像编辑 / 组图).
       **需把 API 站点切到 Miau API**(见下方「站点要求」)。
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
3. If the user asks for TWO OR MORE images, call \`generate_images\` ONCE with:
   - \`prompts\` (required): one prompt per requested image. If the user asks for
     N images, provide exactly N prompts.
   - shared \`model\` (optional, same choices as above), \`ratio\`, \`resolution\`,
     \`quality\`, and \`referenceImages\` when appropriate.
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
5. **Self-review the result, then improve if needed (autonomous QA loop).**
   A \`✅ DONE\` return means the image is ALREADY rendered in the chat. Before you
   hand off, do a quick autonomous quality pass:
   - Open the generated image(s) with \`view_image\` and look critically for
     defects — wrong/extra fingers or limbs, broken faces, garbled text, obvious
     artifacts — and above all whether it matches the prompt (subject, count,
     composition, style). Viewing returned images, **including in batches**, is
     supported; for a very large batch, review a representative subset rather than
     every frame in one turn.
   - If you spot a clear problem, briefly say what's off and **regenerate with an
     improved prompt**. To keep what worked and fix only the rest, pass the prior
     result back as \`referenceImages\` (image-to-image). Then re-review. Iterate
     at MOST 2–3 times and converge — don't loop on marginal nitpicks, and each
     regeneration costs money.
   - When it's good (or good enough), confirm briefly in the user's language and
     cite the saved path(s). Don't over-narrate each pass.
   - You still do NOT need \`query_history\` to find an image you just generated,
     and do NOT shell out (\`dir\`/\`ls\`/\`where\`/\`find\`/\`Get-ChildItem\`) to hunt for
     the file — the path is already in the return; \`view_image\` that path directly.

## Choosing a model (default vs. 腾讯 / 万相)

The \`model\` param is **optional**. By default (omit it) generation runs on the
stable \`gpt-image-2-vip\` channel — keep doing that for ordinary requests. Only
switch when the user *explicitly* asks for a specific channel:

- **\`custom-imagemodel-gt\` (腾讯 image2)** — pick when the user says 腾讯 /
  tencent / image2 / 腾讯模型. Same ratio × resolution(1K/2K/4K) × quality
  surface as the default, so all the other params behave identically.
- **\`wan2.7-image-pro\` (阿里万相 2.7 pro)** — pick when the user says 万相 /
  wanxiang / wan / 通义万相, OR when they want a **consistent multi-image 组图
  series**. Wan excels at 超清文生图、图像编辑、组图; it also supports 4K
  (text-to-image only — editing/组图 cap at 2K).
- All three accept \`referenceImages\` for image-to-image / editing.

### ⚠️ 站点要求(重要 — 用 腾讯 image2 / 万相 2.7 前必读)

\`custom-imagemodel-gt\`(腾讯 image2)和 \`wan2.7-image-pro\`(阿里万相 2.7 pro)
**都只经 Miau API 代理提供**。调用这两个 \`model\` 之前,必须先在
**「API 设置 → ① 选择 API 站点」里把当前站点切到 \`Miau API\`**。原因:应用发请求时
会用「当前选中站点」的域名替换模型端点的域名,站点不对时这两个渠道会被发到错误域名
(如 API易官方)而直接失败。默认 \`gpt-image-2-vip\` 不受此限制,任意站点都可用;
若用户要用 腾讯 image2 / 万相 而当前站点不是 Miau API,先提醒切站点再生成。

When the user does not name a channel, **do not guess** — just omit \`model\` and
use the default. Never invent a model name; only these three values are valid.

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

## Co-direct the shot — brainstorm with the user + your local craft skills

Before you write the \`prompt\`, take a beat to shape the shot **with** the user.
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
     **禁用三视图 / 多视图**——多视图易触发 ID 漂移与双胞胎(\`sd2-pe\` 人脸最佳实践)。
   - 缺图就先用 \`generate_image\` 出一张定妆照补齐,再 \`add_to_portrait_library\`
     存成 \`asset://assetId\`;**不要**拿现成多视图硬塞。
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

> **轻量例外:** 单图「让它动起来」「随手来一段」这类一次性简单请求,不必强排人物卡 /
> 故事板——把用户给的那张图当参考 / 首帧直接动起来,本身就已是「用上了全部可用资产」。
> 这套纪律是给**角色片 / 多镜 / 项目级**工作准备的(也正是 \`film-studio\` 编排器的
> G3 → G5 阶段)。

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

## QA the clip with an ffmpeg 九宫格 contact sheet, then improve

You cannot meaningfully "watch" an MP4, and injecting the raw video bytes into the
chat is wasteful and unsafe — so to self-check a finished clip, build a **3×3
九宫格 contact sheet** of evenly-spaced frames with ffmpeg (use your ffmpeg MCP
tool, e.g. \`ffmpeg-win\`, or any ffmpeg available), then \`view_image\` that ONE
montage:

1. Extract 9 evenly-spaced frames tiled into a grid. Set \`fps ≈ 9 / clip_duration\`
   so the 9 tiles span the whole clip:

       ffmpeg -i "<clip>.mp4" -vf "fps=9/<DURATION>,scale=320:-1,tile=3x3:padding=6:color=black" -frames:v 1 -y "<clip>_grid.png"

   (For a 5s clip, \`fps=9/5=1.8\`; set \`<DURATION>\` to the real length. If the grid
   has too few/many tiles, nudge the fps.)
2. \`view_image\` the \`_grid.png\` and judge: subject/character consistency across
   frames, motion sanity (no melting / teleporting / extra limbs), artifacts, and
   prompt adherence. The grid is one small PNG, so this is cheap and safe.
3. If the clip is clearly bad, regenerate with an adjusted prompt (or switch mode)
   and re-check. Iterate at MOST 2–3 times — each render costs money and ~1–3 min.
4. **Never** inject the full MP4 or its raw bytes into the chat — always inspect
   quality via the contact sheet, never the video itself.

## Organize finished clips into the user's workspace (when in a project)

When working inside a user project/workspace, **COPY** the finalized MP4 (and its
\`_grid.png\` contact sheet) into a tidy assets subfolder with a descriptive,
ordered name — e.g. \`<workspace>/assets/video/S01_station_wide.mp4\` and
\`<workspace>/assets/contact-sheets/S01_station_wide_grid.png\`.

- **COPY, don't move**, from the saved path in the \`DONE\` banner so the chat /
  history copy stays intact.
- Use zero-padded shot ordinals (\`S01_\`, \`S02_\`…) so clips assemble in order —
  exactly what a later ffmpeg concat/拼接 step needs.
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
  \`assetId\`. Returns \`{ assetId, assetUrl, name, duplicated }\` — pass
  \`assetUrl\` (\`asset://…\`) straight into \`generate_video\`.
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

## Proactive workflows

1. **User mentions video generation with material** → \`add_to_portrait_library\`
   each provided image/video/audio FIRST, then reference the returned
   \`asset://assetId\` in \`generate_video\`. (Images passed directly to
   \`generate_video\` are auto-imported; videos/audio and any "save for later"
   material are on you.)
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

## Notes

- \`ask_user\` BLOCKS until the user answers — that's intended; just await it.
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

/**
 * First-party skills no longer shipped by default. If an older app version
 * installed an app-managed copy, remove it on startup so Codex stops discovering
 * it. User-edited copies are preserved.
 */
const RETIRED_FIRST_PARTY_SKILL_NAMES = ['catimation-subagents']

/** All skills this app ships into the Codex USER scope on startup. */
export const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  CATIMATION_IMAGE_SKILL,
  CATIMATION_VIDEO_SKILL,
  CATIMATION_PORTRAIT_LIBRARY_SKILL,
  CATIMATION_BRAINSTORM_SKILL,
]
