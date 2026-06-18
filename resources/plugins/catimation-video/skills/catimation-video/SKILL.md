---
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

When the user wants a video, call the **`generate_video`** tool from the
`catimation` MCP server. It is a SINGLE blocking call: it submits the render
and returns only when the video is DONE (or FAILED) — you do not need to poll,
sleep, or check anything in between. The user watches a live progress bubble
the whole time, and the finished MP4 plays inline in the chat, is saved to a
local file, and lands in the app history page.

## Default mode = 全能参考 (omni-reference) — use it unless told otherwise

For almost EVERY video request, default to **全能参考 (omni-reference)** — and
prefer it heavily. Feed the user's material as references and let the model keep
subject/motion/voice consistent. Caps:

- `referenceImages`: up to **9** images.
- `referenceVideos`: up to **3** videos, COMBINED total duration **≤15s**.
- `referenceAudios`: up to **3** audios, COMBINED total duration **≤15s**.

Only switch to other modes when the user **specifically asks** for them or clearly
needs them — e.g. strict `firstFrame`/`lastFrame` (fixed first/last frame). Do
NOT reach for first/last-frame mode by default.

**Always name the mode you used.** In your reply, state it explicitly in the
user's language — e.g.「我用**全能参考**模式生成」「用**视频延长**模式串联了 3 段」
「按你要求用**首尾帧**模式」. When you default to omni-reference (the usual case),
say 全能参考 out loud so the user knows which path you took.

## All modes share ONE tool (`generate_video`) — pick by inputs + prompt

Seedance has no separate edit/extend endpoints; every mode is the same call with
different content + prompt wording. Use these when the user asks:

- **文生视频 (text-to-video)**: `prompt` only, no references. Pure imagination.
- **图生视频 (image-to-video)**: put the still in `referenceImages` (default) — or
  `firstFrame` (+`lastFrame`) only if the user wants that exact frame fixed.
- **全能参考 (omni-reference, DEFAULT)**: `referenceImages`/`referenceVideos`/
  `referenceAudios` — inherit subject, motion/运镜, voice/音色.
- **视频编辑 (video editing — 替换/增删/修改元素)**: pass the source clip in
  `referenceVideos` (+ any new element image in `referenceImages`) and write an
  edit prompt. Formulas: 增加元素=描述「元素特征+出现时机+位置」; 删除元素=点名要删的、
  强调要保留的; 修改元素=直接描述更换后的样子（如「将视频1礼盒中的香水替换成图片1中的面霜，运镜不变」）.
- **视频延长 (video extension / 多片段串联)**: pass **1–3** source clips in
  `referenceVideos` and describe how they连接/向前向后延长（如「向后延长视频1：…」或
  「视频1 + 过渡描述 + 接视频2 + 接视频3」）.

**Prompt material-reference rule (必须遵守)**: in the prompt, refer to inputs by
ordinal — `图片1 / 视频1 / 音频1` (the Nth item of that type in the request) — NEVER
by assetId. ✅「图片1中的美妆博主」 ❌「asset-2026… 是美妆博主」.

**Real human faces**: Seedance does NOT accept real human faces in reference
images/videos directly. Use a 人像库 virtual-avatar `asset://assetId`, or a clip
Seedance itself generated earlier (model-product 二创 is审核-safe). When reusing an
earlier generated video for edit/extend, pass its saved local path / asset:// —
remote upstream URLs expire in ~24h, so prefer the local copy.

## Co-direct the shot — brainstorm with the user + your local craft skills

Before you write the `prompt`, **load `director-orchestrator`** (the 导演总调度
router): it runs a mandatory STEP 0 self-reflection — 「涉及 13 维里哪几维?要用哪些本地
director-* / storyboard- skill?」 — loads the matching craft skills, and writes
the prompt as structured text (never JSON) with physical/camera-reproducible
params over emotion adjectives. Do this even when YOU generate a clip for your
own answer. Then take a beat to shape the shot **with** the user.
You have a LARGE library of local video / storytelling craft skills in your own
skills directory (usually `~/.agents/skills/`, e.g. `C:\Users\<you>\.agents\skills`)
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
  load the **`catimation-brainstorm`** skill — it drives a clickable
  `ask_user` card so the user just taps a choice instead of typing:
  1. Ask **one question at a time** via `ask_user`, with concrete options —
     「想要什么景别?(特写 / 中景 / 广角)」「什么情绪和风格?」「要不要某种运镜?(推 / 拉 / 环绕 / 手持)」
  2. Offer **as many concrete visual directions as you actually have** (3–6 is
     common, up to 8) inside ONE `ask_user` card — each with a one-line
     trade-off, and mark the one you'd recommend. Never list 方案 as plain text.
  3. Once the direction is set, load the matching local craft skill(s) and fold
     their technique into the prompt.

Keep it lightweight and collaborative — you're co-directing, not running a survey.
When unsure, propose a sensible default out loud and let the user correct you.

## Steps

1. Turn the request into one clear video prompt. Cover subject, action, camera
   movement (运镜/景别), scene, lighting, and mood. Dialogue lines and
   `--style` parameters may be appended. **First co-direct the shot** (see the
   section above): consult your local craft skills and ask the user any quick
   clarifying question that would improve the result.
1.5. **Proactively confirm the output spec before rendering.** Unless the user
   already stated it, fire one `ask_user` card to let them pick the 规格 —
   typically resolution (`480p` draft / **`720p` default** / `1080p` HD),
   duration (4–15s, default 5), and aspect ratio (`16:9` / `9:16`). Recommend
   the defaults (满血 2.0 model + 720p) and let them tap to confirm or change.
   **Do NOT silently default to 1080p** — 720p is the default unless the user
   asks for HD. Keep it to one quick card; skip it only when the user already
   gave an explicit spec.
2. Call `generate_video` with:
   - `prompt` (required): the description from step 1.
   - `model` (optional): `2.0` (default — 满血/full-quality, best for almost
     every request: top quality, complex multi-shot motion, 1080p). Only switch to
     `2.0-fast` when the user explicitly asks for fast/cheap/draft.
   - `resolution` (optional): `480p` draft, `720p` default, `1080p` (model
     `2.0` only).
   - `ratio` (optional): `16:9` default; `9:16` for vertical/手机 video.
   - `duration` (optional): 4–15 seconds, default 5. Longer = more expensive.
   - `referenceImages` (全能参考, default & **important**): up to 9 images for
     character/subject consistency (人物一致性). **If the user attached or
     referenced any image, you MUST pass it here** (paths appear in the prompt
     under `[Attached files at these local paths: …]`). `asset://assetId` from
     the 人像库 page also works.
   - `referenceVideos` / `referenceAudios` (全能参考): up to 3 each (total ≤15s)
     for motion/style or lip-sync/voice. Each clip ≤50MB and 4–15s.
   - `firstFrame` / `lastFrame` (strict mode, **only on explicit request**):
     image to start/end the video from — local path, https URL, or
     `asset://assetId`.
3. Wait for the tool to return — it blocks until the render finishes. There is
   nothing useful to do in between; do NOT resubmit, do NOT call other tools to
   "check progress".
4. Read the result banner:
   - `✅ generate_video DONE` + `📁 SAVED FILE: <path>` → the task is COMPLETE.
     The video is already playing in the chat. Confirm briefly in the user's
     language, **name the mode you used** (e.g.「已用全能参考生成」), and cite the
     saved path. Do NOT re-check, do NOT search the filesystem, do NOT re-generate.
   - `✅ DONE` with "local file save … background/FAILED" → generation itself is
     complete; mention the save status briefly.
   - `⏳ STILL RUNNING` (rare, >10 min renders) → call `check_video_task` with
     the returned taskId repeatedly (each call long-polls ~25s) until DONE or
     FAILED. Never resubmit `generate_video` for the same request.
   - `❌ FAILED` → report the upstream error. You may retry ONCE with an
     adjusted prompt only if the error suggests a content/parameter problem.

## QA the clip with an ffmpeg 九宫格 contact sheet, then improve

You cannot meaningfully "watch" an MP4, and injecting the raw video bytes into the
chat is wasteful and unsafe — so to self-check a finished clip, build a **3×3
九宫格 contact sheet** of evenly-spaced frames with ffmpeg (use your ffmpeg MCP
tool, e.g. `ffmpeg-win`, or any ffmpeg available), then `view_image` that ONE
montage:

1. Extract 9 evenly-spaced frames tiled into a grid. Set `fps ≈ 9 / clip_duration`
   so the 9 tiles span the whole clip:

   ```
   ffmpeg -i "<clip>.mp4" -vf "fps=9/<DURATION>,scale=320:-1,tile=3x3:padding=6:color=black" -frames:v 1 -y "<clip>_grid.png"
   ```

   (For a 5s clip, `fps=9/5=1.8`; set `<DURATION>` to the real length. If the grid
   comes out with too few/many tiles, nudge the fps.)
2. `view_image` the `_grid.png` and judge: subject/character consistency across
   frames, motion sanity (no melting / teleporting / extra limbs), artifacts, and
   prompt adherence. The grid is one small PNG, so this is cheap and safe.
3. If the clip is clearly bad, regenerate with an adjusted prompt (or switch mode)
   and re-check. Iterate at MOST 2–3 times — each render costs money and ~1–3 min.
4. **Never** inject the full MP4 or its raw bytes into the chat — always inspect
   quality via the contact sheet, never the video itself. The user is already
   watching the clip play inline.

## Organize finished clips into the user's workspace (when in a project)

When working inside a user project/workspace, **COPY** the finalized MP4 (and its
`_grid.png` contact sheet) into a tidy assets subfolder with a descriptive,
ordered name — e.g. `<workspace>/assets/video/S01_station_wide.mp4` and
`<workspace>/assets/contact-sheets/S01_station_wide_grid.png`.

- **COPY, don't move**, from the saved path in the `DONE` banner so the chat /
  history copy stays intact.
- Use zero-padded shot ordinals (`S01_`, `S02_`…) so clips assemble in order — this
  is exactly what a later ffmpeg concat/拼接 step needs.
- Skip for a one-off casual clip unless the user asks.

## Portrait library (人像库) — push materials in, then reference

The `catimation` MCP server exposes portrait-library tools
(`add_to_portrait_library`, `list_portrait_library`, `edit_portrait_library`,
`download_portrait_asset` — see the `catimation-portrait-library` skill). Use
them **proactively** around video generation:

- Every input image you pass to `generate_video` is automatically imported into
  the library and referenced as `asset://assetId`; identical images dedupe
  upstream, keeping the SAME character consistent across multiple videos.
- When the user gives you OTHER material to save/reuse for the video (a video or
  audio reference, or "记住这个角色/场景"), call `add_to_portrait_library` first,
  then pass the returned `asset://assetId` into `referenceImages` /
  `referenceVideos` / `referenceAudios` (全能参考), or `firstFrame` if the user
  asked for strict first-frame mode.
- To reuse an earlier character/scene ("还是上次那个人/同一角色"), call
  `list_portrait_library` to find the matching `asset://assetId` and reference
  it — this is what keeps identity consistent.
- The user can also pick assets on the 人像库 page and give you an
  `asset://assetId` directly — pass it straight in without conversion.

## Notes

- One `generate_video` call produces ONE video. For several videos, call the
  tool once per video, reusing the same asset:// references for character
  consistency. You MAY run multiple in parallel — but **if you're about to launch
  20 or more video tasks at once, STOP and confirm with the user first**: each
  video costs money and renders ~1–3 min, so a large batch is a real time/cost
  commitment worth a quick "确认要并发生成 N 个视频吗?".
- Local input files are handled for you: small files are inlined, larger files
  are relayed through the app's upload pipeline automatically — pass plain
  local paths and let the tool deal with size limits (images ≤30MB,
  video/audio ≤50MB & 4–15s).
- To self-check quality, build an ffmpeg 九宫格 contact sheet and `view_image`
  that (see the QA section above) — never open the resulting MP4 with view_image
  or read its raw bytes; the user is already watching it play in the chat.
- **Background saving never blocks you.** Success is decided by the render: once
  the banner says DONE the video is already playing, even if the local file is
  still saving in the background (`persistencePending`). Treat the task as
  COMPLETE and reply right away — do NOT wait for, poll, or re-check the save.
