---
name: catimation-understand
description: >-
  Understand video / audio / documents / and research the web with the omni-modal
  qwen3.8-omni-flash inside CATIMATION. Trigger to 理解/分析视频, 听/转写 音频/录音/音乐,
  看懂/读 文档/PDF, or 上网查/搜一下/扒资料/最新消息. Also the model understand/review
  stage of the multimedia inspect→verify loop (不只审片): judge content here with
  understand_video / understand_audio, then hand technical QC + fixes back to the
  ffmpeg-win skill. 视频/音频/图文理解以 qwen(omni)为主;apiyi 的 Gemini
  (gemini-3.5-flash,禁传 2.5)只作深度复核的备选。
---

# CATIMATION Understand — video / audio / document / web via qwen

<!-- skill-budget: fast -->

These tools run on qwen through the Miau gateway (platform balance or Miau key —
the same billing as image / video generation) and return Chinese text answers.
**Model defaults to the omni-modal `qwen3.8-omni-flash`** (cheapest tier, and the
ONLY tier that can hear audio). The 3.7 generation stays available in parallel:
`model="plus"` → `qwen3.7-plus-dashscope`, `model="max"` → `qwen3.7-max-dashscope`
(text + image + video, no audio); `model="flagship"` → `qwen3.8-max` (strongest
reasoning, 1M context, no audio). You rarely need any of them: if omni fails, the
renderer automatically retries once on 3.7 max as a fallback (audio excepted). Only
pick a bigger tier on a hard document / cross-modal reasoning job or when the user
explicitly asks for it.

## If YOU are qwen3.8-omni-flash (main agent): attachments arrive natively

When the user picked Qwen 3.8 Omni Flash as the chat model, audio / video files
attached to the message are delivered **inside the message itself** (the app relays
them and sends real `input_audio` / `input_video` parts) — you already see the frames
and hear the soundtrack. Answer from what you perceive; do not call `understand_video`
/ `understand_audio` on the same file unless the user asks for a second opinion or a
different tier. Two exceptions still need the tools: files upstream cannot decode
natively (audio in m4a / ogg / opus / flac — convert with ffmpeg-win to mp3 / wav
first, or hand the path to `understand_audio`), and anything that arrived only as a
`name: path` mention because the relay failed.

## When to use

- "理解 / 分析这个视频"、"这段视频在干什么" → `understand_video`
- "理解 / 分析画布上(选中)的这段视频" → `understand_canvas_video`
- "听一下 / 转写 / 这段录音说了什么 / 这首歌什么风格" → `understand_audio`
- "读一下这份文档 / PDF 讲了什么"、"看看这几张图" → `understand_document`
- "上网查 / 搜一下 / 最新消息 / 扒点资料" → `web_research`
- "审查/审片/检查内容"、"剧情/字幕/连续性对不对",或任何**理解/处理 视频音频 前后**的核对 → `understand_video`(你是多媒体 inspect→verify loop 的内容阶段,见下)

## 多媒体 inspect→verify loop — 你是「模型内容理解/审查」这一阶段(不要单干)

**不止「发布前审片」**:只要任务要**理解或处理 视频 / 音频 / 多媒体文件**,就走一个
**跨两个技能的 inspect → process → verify 大循环**(由 **ffmpeg-win** 技能主导编排),
而且 **agent 自主触发、别等人催**:

```
ffprobe 粗检(ffmpeg-win) → 九宫格视觉(ffmpeg-win) → 模型内容理解/审查(你 · understand_video / understand_audio)
   → 不达标/要改 → ffmpeg 修复 + 回到粗检复检(ffmpeg-win) → 发布前 checkpoint(ffmpeg-win,仅交付时)
```

何时触发(不只成片):**理解/分析**一段视频音频前,先让 ffmpeg-win probe 摸清真实
时长/码流再下判断;**处理**(转码/剪辑/拼接/提取音频/加 BGM)前 probe 输入、处理后回来
复核输出;**刚生成**的视频先 grid+理解再说「做好了」;**发布/交付前**才走完整闭环到 checkpoint。

你负责的是**内容那一半**:用 `understand_video` 看这条片子的 **剧情 / 字幕 / 动作 /
连续性 / 有无穿帮错字**,用 `understand_audio` 听 **对白 / 配乐 / 音效是否对**,对照需求
给出「过 / 不过 + 具体问题」。

- 用户说「审查这部片子」而你被叫起来时:先做内容审查并报告发现,**然后把技术问题
  (分辩率/响度/编码/odd 尺寸/转码/拼接修复)和发布前 checkpoint 交回 ffmpeg-win 技能**
  ——那些是像素/码流层面,不是你的活。
- 不要假装能判分辨率/响度/编码是否达标;也不要替 ffmpeg-win 跑修复。各司其职、
  互相衔接,才是一个完整的审片闭环。

## Tools

### understand_video { video_url | video_path, question, fps?, model? }
Pass EITHER a public http(s) `video_url` OR a local `video_path`. qwen only
accepts publicly reachable URLs, so a local path (or a `data:` URL) is
**auto-uploaded to the history COS bucket** (`image-history/media-relay/*`,
≤2GB / 2h) and the resulting public URL is used — you do NOT need to upload
manually. `fps` is the frame-sampling rate (0.1–10, upstream default 2). Returns a
description of 画面/动作/字幕/剧情. The default omni model also attends to the
soundtrack (a black-screen clip's dialogue came back verbatim in testing), but for
a transcript or music analysis use `understand_audio` — every other tier
(`plus` / `max` / `flagship`) is frame-only, it never hears.

### understand_audio { audio_url | audio_path, question, format? }
Listen to an audio file: speech transcription, dialogue, music genre / mood /
instruments, sound effects, tone of voice. Pass a public `audio_url` OR a local
`audio_path` (auto-uploaded like video). Formats: mp3 / wav / m4a / aac / ogg /
flac / opus; `format` is inferred from the extension when omitted. For a video's
soundtrack extract it first with ffmpeg-win (`ffmpeg -i in.mp4 -vn -c:a libmp3lame
out.mp3`). Long recordings: split into ≤20-minute chunks and ask per chunk. Always
runs on omni (no other tier can hear); no fallback. Do NOT wrap audio into a
placeholder MP4 for `understand_video` — this tool is the audio path.

### understand_canvas_video { question, model?, annotate? }
Understand the video **selected on the canvas** (or the only video if none is
selected) — NO url/path needed: the canvas exposes the clip's source itself, and
a local source is auto-uploaded to COS just like `understand_video`. This works
even for a clip you **dragged in from the desktop** (its bytes live in the
canvas store with no recorded path — it's materialized to a real file first). By default
it also **writes the result back onto the canvas as a text note** next to the
video; pass `annotate=false` to only return the text. Requires the Canvas tab
open. Use this for "理解画布上选中的这段视频" instead of asking the user for a URL.

### understand_document { file_url | file_path, file_urls? | file_paths?, question, model? }
Pass EITHER a public `file_url` OR a local `file_path` (auto-uploaded to COS just
like video, ≤2GB). PDFs are parsed natively (text AND images inside the file;
150MB / 500 pages) — just pass the `.pdf`. To compare several images in ONE call
(同一角色跨镜头是否一致 / 多页文档 / 哪版更好) add `file_urls` / `file_paths`;
order is preserved and "第二张" in your question means the first extra entry.

### web_research { query, model? }
Natural-language query; the tool sets `enable_search` so the answer incorporates
live web results. Prefer this over guessing from stale memory; cite what you used.

## apiyi-mcp(Gemini)只作深度复核的备选

Video / audio / image understanding all run on qwen omni by default (cheap, and it
hears). Reach for **apiyi-mcp `generate_content`** with `gemini-3.5-flash` only when
the omni answer is not enough and you want an independent second read of a hard
clip. Confirm the `apiyi` MCP is enabled first; **never pass `gemini-2.x`** (retired,
markedly worse). Do not route audio to apiyi first any more — `understand_audio`
is the primary path.

## Path B — delegate to a qwen subagent

For heavy/parallel/independent understanding jobs (e.g. "分头读这三份文档并汇总",
"开个子代理去查资料"), spawn a subagent **pinned to the qwen provider**:
`modelProvider="qwen"`, `model="qwen3.8-omni-flash"` (or `"qwen3.8-max"` for hard
reasoning; the 3.7 aliases `qwen3.7-plus-dashscope` / `qwen3.7-max-dashscope` are
still registered too). The subagent does the understanding/research and reports a
distilled result; you synthesize.

**先想清楚要不要子代理。** 上面那些工具本来就返回文本、可以在同一轮里并发发多个
调用 —— 只要一个结论,那条路更便宜(没有子代理的启动成本)。子代理留给「看完还要
接着干活」:需要独立的工具权限和推理预算,而不只是一个答案。判据、并发上限与旁挂
落盘规范见 catimation-subagents。

派活时**交接要写全**:子代理看不到你的对话历史,必须带上绝对路径、判据、产物写到
哪、以什么格式回话。少一样它就得靠猜。

If neither the platform balance nor a Miau token is configured, the qwen provider
is unavailable; fall back to calling the tools directly and tell the user.

## Boundaries

- Media reaches qwen as a public URL; local paths / `data:` URLs are
  auto-uploaded to the history COS bucket first (≤2GB; larger → compress).
- Audio is omni-only: `understand_audio` ignores `model`; every other tier returns
  `incorrect modal 'audio'`.
- On a clean result, do NOT retry; just answer the user.
