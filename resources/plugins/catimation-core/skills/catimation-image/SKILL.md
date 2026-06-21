---
name: catimation-image
description: >-
  FIRST-CHOICE image generator in the CATIMATION desktop app — use IN PREFERENCE
  TO the built-in imagegen / image_gen tool (which is unavailable on Windows and
  does not persist results). Trigger whenever the user asks to generate / draw /
  render / edit / restyle an image, picture, illustration, poster, or icon, or
  says 生成图片 / 画一张 / 配图 / 出图 / 来张图 / 改图. Runs the in-app generate_image tool.
---

# Generate images in CATIMATION (first-choice, replaces built-in image_gen)

When the user wants one image, call the **`generate_image`** tool. When the user
wants MORE THAN ONE image, call **`generate_images`** instead. Both tools are
provided by the `catimation` MCP server and replace the built-in imagegen /
image_gen skill: they render inside the chat AND persist results to local files
(paths returned), the app's history page, and the ATTACHMENTS file panel.

## When to Use

- 用户要生成 / 画 / 渲染 / 编辑 / 重绘图片、插画、海报、图标、配图(生成图片 / 画一张 / 出图 / 改图)。
- 你自己回答时需要一张配图。
- 用户给了图想以图改图 / 换风格 → 走本 skill 并带上 `referenceImages`。
- 优先于内置 imagegen / image_gen(后者 Windows 不可用且不落盘)。

## Steps

0. **Before writing the prompt, load `director-orchestrator`** (the
   导演总调度 router). It runs a STEP 0 self-reflection on which `director-*` /
   `storyboard-*` craft skills apply, then writes the prompt as structured text
   on the 13-dimension framework (physical params over emotion adjectives,
   positive prompts by default). Do this even when YOU generate an illustration
   for your own answer. For open-ended asks, go through `catimation-brainstorm`
   first. Skip only for a trivially clear one-off.
1. Turn the request into one clear, descriptive prompt. Cover subject, style,
   composition, lighting, and mood. Keep it concise.
2. If the user asks for exactly ONE image, call `generate_image` with:
   - `prompt` (required): the description from step 1.
   - `model` (optional): rendering channel. **Omit it** for the default
     `gpt-image-2-vip` (stable). Only set it when the user explicitly names a
     channel (see "Choosing a model" below):
     - `custom-imagemodel-gt` — 腾讯 image2 (same ratio/resolution/quality spec).
       **需把 API 站点切到 Miau API**(见下方「站点要求」)。
     - `wan2.7-image-pro` — 阿里万相 2.7 pro (超清文生图 / 图像编辑 / 组图).
       **需把 API 站点切到 Miau API**(见下方「站点要求」)。
   - `ratio` (optional): aspect ratio, e.g. `1:1`, `16:9`, `9:16`, `4:3`, `3:2`.
     Omit or `auto` lets the model decide.
   - `resolution` (optional): clarity tier — prefer `2K` by default. Use `1K`
     only when the user asks for fast/cheap/draft; use `4K` only when the user
     explicitly asks for print/ultra-detail/4K.
   - `quality` (optional): `auto` (default), `low`, `medium`, or `high`. Use
     `high` for images with text or fine detail.
   - `count` (optional, **wan2.7 only**): number of images from THIS one prompt
     (1–12, default 1). Set `model: 'wan2.7-image-pro'` + `count > 1` to get a
     front-to-back **consistent 组图 series** (same character/subject across
     frames, e.g. 同一只猫的四季). Other channels ignore `count` (always 1). For
     several *unrelated* images, use `generate_images` (one prompt each) instead.
   - `referenceImages` (optional but **important**): array of local file paths
     or data/http URLs for image-to-image / editing. **If the user gave you any
     image material, you MUST reuse it here** (see "Reference images" below).
3. If the user asks for TWO OR MORE images, call `generate_images` ONCE with:
   - `prompts` (required): one prompt per requested image. If the user asks for
     N images, provide exactly N prompts.
   - shared `model` (optional, same choices as above), `ratio`, `resolution`,
     `quality`, and `referenceImages` when appropriate.
   - Do not spawn subagents and do not call `generate_image` one-by-one.
     `generate_images` performs the parallel fan-out internally and returns one
     combined result.
4. The tool returns a short text result that begins with `✅ generate_image DONE`
   or `✅ generate_images DONE`,
   names the `📁 SAVED FOLDER`, lists the saved `FILES:`, and ends with a compact
   `{ ok, count, model, historyId, paths, dir }` JSON line (plus one
   `resource_link` per file). **A successful return means the task is complete —**
   the image is already shown to the user and saved to history + the file panel.
   You do **not** need to embed, re-describe, or base64 the pixels. Just confirm
   briefly in the user's language and cite the saved path(s) when relevant.
5. **Self-review the result, then improve if needed (autonomous QA loop).**
   A `✅ DONE` return means the image is ALREADY rendered in the chat. Before you
   hand off, open the generated image(s) with `view_image`(支持批量;超大批量看代表性子集)
   and过一遍**四项验收清单**:
   - **① 符合用户要求**:主体 / 数量 / 画幅比例 / 文字内容 / 明确指定的元素是否都对上;
     用户给了 `referenceImages` 时是否真的体现了参考(而非从零另画)。
   - **② 质量合理**:无多/缺手指与肢体、无崩脸、无乱码文字、无明显伪影/拼接错位;
     分辨率与清晰度匹配用途。
   - **③ 风格一致**:与用户指定风格一致;**系列/组图**内各帧画风、色调、角色外观前后一致;
     若项目有角色锚点 / 圣经(character_bible)或既定风格,新图须与之吻合(见
     `director-style-consistency` / `director-character-consistency`)。
   - **④ 过 skill / 插件门**:提示词是否经 `director-orchestrator` 的 13 维框架(物理参数优先);
     角色身份是否遵循单锚点纪律(默认大头照+全身照,三视图/四视图为可选补充);
     涉敏感/合规内容是否过 `storyboard-negative-control`;在制片流程中是否满足 `film-studio` 的资产门。
   - 若任一项不达标:简述哪里不对,**带改进后的提示词重生成**(保留可用部分时把上一版回传为
     `referenceImages` 做图生图),再复检。最多迭代 2–3 次即收敛——别在边角小瑕疵上死磕,
     每次重生成都花钱。
   - When it's good (or good enough), confirm briefly in the user's language and
     cite the saved path(s). Don't over-narrate each pass.
   - You still do NOT need `query_history` to find an image you just generated,
     and do NOT shell out (`dir`/`ls`/`where`/`find`/`Get-ChildItem`) to hunt for
     the file — the path is already in the return; `view_image` that path directly.

## Choosing a model (default vs. 腾讯 / 万相)

The `model` param is **optional**. By default (omit it) generation runs on the
stable `gpt-image-2-vip` channel — keep doing that for ordinary requests. Only
switch when the user *explicitly* asks for a specific channel:

- **`custom-imagemodel-gt` (腾讯 image2)** — pick when the user says 腾讯 /
  tencent / image2 / 腾讯模型. Same ratio × resolution(1K/2K/4K) × quality
  surface as the default, so all the other params behave identically.
- **`wan2.7-image-pro` (阿里万相 2.7 pro)** — pick when the user says 万相 /
  wanxiang / wan / 通义万相, OR when they want a **consistent multi-image 组图
  series** (e.g. "同一只猫的四季组图，前后一致"). For a 组图 series, call
  `generate_image` with `model: 'wan2.7-image-pro'` and `count` = how many frames
  (2–12) — it returns one front-to-back-consistent set from a single prompt
  (do NOT use `generate_images`, which makes unrelated images). Wan excels at
  超清文生图、图像编辑、组图; it also supports 4K (text-to-image only —
  editing/组图 cap at 2K).
- All three accept `referenceImages` for image-to-image / editing.

### ⚠️ 站点要求(重要 — 用 腾讯 image2 / 万相 2.7 前必读)

`custom-imagemodel-gt`(腾讯 image2)和 `wan2.7-image-pro`(阿里万相 2.7 pro)
**都只经 Miau API 代理提供**。调用这两个 `model` 之前,必须先在
**「API 设置 → ① 选择 API 站点」里把当前站点切到 `Miau API`**。原因:应用发请求时
会用「当前选中站点」的域名替换模型端点的域名,所以站点不对时,这两个渠道的请求会被
发到错误的域名(如 API易官方),那边没有这两个模型,直接失败 / 报错。

- 默认渠道 `gpt-image-2-vip` **不受此限制**,在任何站点都能用——这也是为什么不指定
  `model` 时要保持默认。
- 如果用户明确要用 腾讯 image2 / 万相,而当前站点不是 Miau API:先提醒用户到
  「API 设置」把站点切到 **Miau API**(并填好对应 API Key)再生成,否则会失败。

When the user does not name a channel, **do not guess** — just omit `model` and
use the default. Never invent a model name; only these three values are valid.

## Reference images — reuse the user's material (important)

If the user provides ANY image material, treat it as a reference and pass it in
`referenceImages` (image-to-image) instead of doing text-to-image. Look for:

- Paths listed in the prompt under `[Attached files at these local paths: …]`
  or `[Referenced files at these local paths: …]` — these are the files the
  user attached/@-mentioned in chat. Pass the image ones as `referenceImages`.
- The user pointing at an image with language like "按这张图 / 参考这张 /
  基于这张 / 用这张做 / edit this / make a variation of this / 换成…风格".
- An image the user just generated in this thread that they now want changed.

Rules:
- Be proactive: when material is present and the request is plausibly about it,
  reuse it. Do **not** silently drop the reference and generate from scratch.
- **You can pass MULTIPLE reference images — you are not limited to one.**
  `referenceImages` is an array: include every relevant image the user gave
  (e.g. a character sheet + a background, several angles, a subject + a style
  reference). Pass all of them together so the model can combine/condition on
  the whole set, not just the first.
- Pass the local file path(s) directly (the tool reads the full-resolution bytes
  itself); you do not need to convert them.
- If you are unsure whether the user wants the reference followed, prefer reusing
  it and say briefly that you based it on their image(s).

## Multiple images at once — use generate_images (important)

When the user asks for more than one image (e.g. "生成 3 张…", "make 4 variations",
a set/series, or several distinct subjects), **call `generate_images` exactly
once**. Do not try to manually emit several `generate_image` calls; models often
serialize those calls even when asked to be parallel. `generate_images` is the
parallel-safe batch wrapper and fans out the renderer calls concurrently inside
CATIMATION.

- If the user asks for N images, pass exactly N prompts to `generate_images.prompts`.
- For variations, write N distinct but related prompts so the outputs are not clones.
- For many more than 8 images, ask the user to split into batches; the tool caps
  each batch to keep the UI and gateway stable.
- After `generate_images` returns, confirm once and cite the saved `paths`; don't
  re-announce each image separately.

## Organize finished assets into the user's workspace (when in a project)

When you're working inside a user project/workspace folder (e.g. a film /
storyboard project, or the user asked you to organize outputs), proactively
**COPY** each finalized image into a tidy assets subfolder of that working
directory and give it a descriptive, ordered name — e.g.
`<workspace>/assets/images/S01_hero_wide.png`.

- **COPY, don't move**, from the saved path in the tool result, so the chat /
  history / ATTACHMENTS copy stays intact.
- Group by purpose/shot and use zero-padded ordinals (`S01_`, `S02_`…) so files
  sort naturally.
- For a one-off casual generation outside any project, skip this unless asked —
  the file is already saved and in history.

## Common Mistakes

- 用户给了图却忘传 `referenceImages`,改成从零文生图。
- 调 `custom-imagemodel-gt` / `wan2.7-image-pro` 前不切到 Miau API 站点,直接调用导致失败。
- 多张图却逐个调 `generate_image`,而不是一次 `generate_images`。
- 凭空编造 `model` 名;只有三个合法值,用户没点名就省略 `model` 走默认。

## Notes

- This is the generate → save → read path. The file is on disk (see `paths`), in
  the history page, and in the ATTACHMENTS panel — no extra save step is needed.
  Only move/copy a file if the user wants it somewhere specific (see the organize
  section above when working in a project).
- For edits, image-to-image, or multi-image prompts, use `generate_image` for one
  output or `generate_images` for multiple outputs, always with `referenceImages`
  when references are present.
- If `generate_image` is genuinely unavailable in this session, you may fall back
  to whatever image tool you do have — but `generate_image` is the preferred,
  in-app path that actually displays and saves the result.
