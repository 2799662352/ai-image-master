---
name: catimation-understand
description: >-
  Understand video / documents / and research the web with qwen3.7-plus-dashscope
  inside CATIMATION. Trigger to 理解/分析视频, 看懂/读 文档/PDF, or 上网查/搜一下/扒资料/最新消息.
  Also the model understand/review stage of the multimedia inspect→verify loop
  (不只审片): judge content here with understand_video, then hand technical QC +
  fixes back to the ffmpeg-win skill. 视频理解以 qwen(understand_video)为主、apiyi 为辅;
  apiyi 的 Gemini(gemini-3.5-flash,禁传 2.5)主要做音频理解(qwen 音频不好)和视频的深度理解。
---

# CATIMATION Understand — video / document / web via qwen

<!-- skill-budget: fast -->

These tools run on qwen through the same new-api gateway and Miau token used for
image/video generation, and return Chinese text answers. **Model defaults to
`qwen3.7-plus-dashscope`** (cheaper); pass `model="max"` on any tool for the
stronger `qwen3.7-max-dashscope`. You rarely need to: if plus fails, the renderer
automatically retries once on max as a fallback. Only ask for `max` when plus
struggles on a hard clip or the user explicitly wants the strongest model.

## When to use

- "理解 / 分析这个视频"、"这段视频在干什么" → `understand_video`
- "理解 / 分析画布上(选中)的这段视频" → `understand_canvas_video`
- "读一下这份文档 / PDF 讲了什么" → `understand_document`
- "上网查 / 搜一下 / 最新消息 / 扒点资料" → `web_research`
- "审查/审片/检查内容"、"剧情/字幕/连续性对不对",或任何**理解/处理 视频音频 前后**的核对 → `understand_video`(你是多媒体 inspect→verify loop 的内容阶段,见下)

## 多媒体 inspect→verify loop — 你是「模型内容理解/审查」这一阶段(不要单干)

**不止「发布前审片」**:只要任务要**理解或处理 视频 / 音频 / 多媒体文件**,就走一个
**跨两个技能的 inspect → process → verify 大循环**(由 **ffmpeg-win** 技能主导编排),
而且 **agent 自主触发、别等人催**:

```
ffprobe 粗检(ffmpeg-win) → 九宫格视觉(ffmpeg-win) → 模型内容理解/审查(你 · understand_video)
   → 不达标/要改 → ffmpeg 修复 + 回到粗检复检(ffmpeg-win) → 发布前 checkpoint(ffmpeg-win,仅交付时)
```

何时触发(不只成片):**理解/分析**一段视频音频前,先让 ffmpeg-win probe 摸清真实
时长/码流再下判断;**处理**(转码/剪辑/拼接/提取音频/加 BGM)前 probe 输入、处理后回来
复核输出;**刚生成**的视频先 grid+理解再说「做好了」;**发布/交付前**才走完整闭环到 checkpoint。

你负责的是**内容那一半**:用 `understand_video` 看这条片子的 **剧情 / 字幕 / 动作 /
连续性 / 有无穿帮错字**,对照需求给出「过 / 不过 + 具体问题」。

- 用户说「审查这部片子」而你被叫起来时:先用 `understand_video` 做内容审查并报告
  发现,**然后把技术问题(分辨率/响度/编码/odd 尺寸/转码/拼接修复)和发布前
  checkpoint 交回 ffmpeg-win 技能**——那些是像素/码流层面,不是你的活。
- 不要假装能判分辨率/响度/编码是否达标;也不要替 ffmpeg-win 跑修复。各司其职、
  互相衔接,才是一个完整的审片闭环。

## Tools

### understand_video { video_url | video_path, question, fps? }
Pass EITHER a public http(s) `video_url` OR a local `video_path`. qwen only
accepts publicly reachable URLs, so a local path (or a `data:` URL) is
**auto-uploaded to the history COS bucket** (`image-history/media-relay/*`,
≤200MB) and the resulting public URL is used — you do NOT need to upload
manually. `fps` is an optional sampling hint (reserved). Returns a description
of 画面/动作/字幕/剧情.

### understand_canvas_video { question, model?, annotate? }
Understand the video **selected on the canvas** (or the only video if none is
selected) — NO url/path needed: the canvas exposes the clip's source itself, and
a local source is auto-uploaded to COS just like `understand_video`. This works
even for a clip you **dragged in from the desktop** (its bytes live in the
canvas store with no recorded path — it's materialized to a real file first). By default
it also **writes the result back onto the canvas as a text note** next to the
video; pass `annotate=false` to only return the text. Requires the Canvas tab
open. Use this for "理解画布上选中的这段视频" instead of asking the user for a URL.

### understand_document { file_url | file_path, question }
Pass EITHER a public `file_url` OR a local `file_path` (auto-uploaded to COS
just like video, ≤200MB). Native document understanding is only PARTIAL
upstream — for best results render the page(s) to image(s) and pass an image,
or extract the text and just ask normally.

### web_research { query }
Natural-language query; the tool sets `enable_search` so the answer incorporates
live web results. Prefer this over guessing from stale memory; cite what you used.

## apiyi-mcp(Gemini)为辅:音频理解 + 视频深度理解(常规视频理解仍 qwen 为主)

常规「看懂这段视频」**仍以上面的 qwen `understand_video` 为主**(便宜、够用)。但有两类
情况改用 **apiyi-mcp 的 Gemini**(`generate_content`,直接吃媒体文件):

- **音频理解**:qwen 对音频要么不收(返回 `incorrect modal 'audio'`)要么质量差 → 走 apiyi。
- **视频的深度理解**:需要更细的剧情 / 细节 / 多模态深读,或 qwen 的结论不够 → 用 apiyi 复核 / 补强。

用法:
1. 确认 **`apiyi` MCP 已启用**(应用「MCP 服务器」页;`APIYI_API_KEY` 已由应用自动复用
   「API 设置」里的 api易 key,无需手填)。
2. 调 apiyi 的 **`generate_content`**,带音频 / 视频文件 + 你的问题。**`model` 固定用
   `gemini-3.5-flash`(为主);绝不要传 `gemini-2.x`(`gemini-2.5-*` 旧 id)——已弃用、
   明显掉点。** 要最深推理时才手动切 `gemini-3.1-pro-preview-thinking`,默认不切。

**音频兜底(仅当 apiyi MCP 不可用 / 未配 key 时)**:用 **ffmpeg-win** 把音频转成带占位画面的
MP4(`ffmpeg -i in.mp3 -f lavfi -i color=c=black:s=640x360 -shortest -c:v libx264 out.mp4`),
再用 qwen `understand_video` 传该 MP4 `video_path`——并说明这是次选兜底,效果不如 apiyi 的 Gemini。

## Path B — delegate to a qwen subagent

For heavy/parallel/independent understanding jobs (e.g. "分头读这三份文档并汇总",
"开个子代理去查资料"), spawn a subagent **pinned to the qwen provider**:
`modelProvider="qwen"`, `model="qwen3.7-max-dashscope"`. The subagent does the
understanding/research and reports a distilled result; you synthesize.

**先想清楚要不要子代理。** 上面那三个工具本来就返回文本、可以在同一轮里并发发多个
调用 —— 只要一个结论,那条路更便宜(没有子代理的启动成本)。子代理留给「看完还要
接着干活」:需要独立的工具权限和推理预算,而不只是一个答案。判据、并发上限与旁挂
落盘规范见 catimation-subagents。

派活时**交接要写全**:子代理看不到你的对话历史,必须带上绝对路径、判据、产物写到
哪、以什么格式回话。少一样它就得靠猜。

If the Miau token is not configured, the qwen provider is unavailable; fall back
to calling the three tools directly and tell the user.

## Boundaries

- Media reaches qwen as a public URL; local paths / `data:` URLs are
  auto-uploaded to the history COS bucket first (≤200MB; larger → compress).
- Documents: partial support; degrade to page-image or extracted-text + ask.
- On a clean result, do NOT retry; just answer the user.
