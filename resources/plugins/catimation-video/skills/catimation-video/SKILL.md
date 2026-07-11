---
name: catimation-video
description: >-
  FIRST-CHOICE video generator and the ONLY top-level video orchestrator in the
  CATIMATION desktop app. Trigger whenever the user asks to generate / create /
  render a video or animation, animate a still, or says 生成视频 / 图生视频 /
  让它动起来 / 视频编辑 / 视频延长. Covers text-to-video, still-to-video,
  omni-reference (全能参考, default), editing and extension via the in-app
  generate_video tool (Seedance 2.0), and grades every request into
  快速/标准/专业/制片 four tiers before loading any other skill.
---

<!-- skill-budget: pro -->

# Generate videos in CATIMATION(唯一视频入口 · 分级调度)

When the user wants a video, call the **`generate_video`** tool from the
`catimation` MCP server. It is a SINGLE blocking call: it submits the render and
returns only when the video is DONE (or FAILED) — no polling, no sleeping. The
user watches a live progress bubble; the finished MP4 plays inline in the chat,
is saved to a local file, and lands in the app history page.

**本 skill 是视频生成的唯一顶层编排者。** 其它 skill(导演/分镜/工艺/QA)都由这里
按任务分级选择性加载;任何下游 skill 不得反过来重跑路由或重新编排本流程。

## STEP 0 — 任务分级(先定级,再加载,不许「只要相关就加载」)

默认进入**快速**模式;只有命中升级条件才升级。定级后在心里记住执行状态
(`task_mode / direction_confirmed / spec_confirmed / prompt_engineered /
generated / visual_qa_done / content_qa_done`),已完成的步骤**不再重复执行**:
规格确认过就不再问、提示词写好就不再重写、QA 做过就不再重抽。

| 模式 | 典型请求 | 加载预算(含本 skill) | 默认动作 |
|---|---|---|---|
| **快速** | 「让这张图动起来」「生成5秒海浪」单镜简单请求 | ≤2 个 skill:本入口 + `sd2-pe` | 合理默认,直接生成,快速 QA |
| **标准** | 单人物表演、简单电影感、带参考图的单镜 | ≤5 个 skill:+2–3 个对症技法 | 按症状表挑技法,视觉 QA |
| **专业** | 武打/多人/参考复刻/复杂运镜/跨镜一致性 | 5–9 个 skill:+ `director-orchestrator` | 13 维按需展开,视觉+内容 QA |
| **制片** | 多镜短片、宣传片、完整成片交付 | 按阶段加载,禁止一次全量 | 移交 `film-studio` 门控流水线 |

**升级条件(仅此四类,别自行放大):** ① 明确的人物演技/复杂动作/武打;
② 参考图·视频·电影的风格复刻;③ 跨镜/系列的角色·风格一致性;④ 多镜、成片、
正式交付,或用户明确要求专业制作。超预算加载必须能说出具体风险,
「可能有帮助」不是理由。

**方向开放时先共创,别自己猜。** 用户说「更电影感/更高级/给我选项/共创」或方向
不明的高成本任务 → 先载入 catimation-brainstorm 用 `ask_user` 弹一张可点击选项
卡(一次一个聚焦问题、3–6 个具体方向、标注推荐项),选定即 `direction_confirmed`,
后续不再反复追问。明确的简单请求跳过弹卡,直接快速模式。

## 模式与素材规则(所有等级通用)

**Default mode = 全能参考 (omni-reference)** — use it unless told otherwise.
Caps: `referenceImages` ≤9 张;`referenceVideos` ≤3 段、合计 ≤15s;
`referenceAudios` ≤3 段、合计 ≤15s。Only switch to strict `firstFrame`/`lastFrame`
when the user explicitly asks. **Always name the mode you used**(如「我用**全能
参考**模式生成」)。

All modes share ONE tool (`generate_video`) — pick by inputs + prompt:

- **文生视频**: `prompt` only. **图生视频**: still into `referenceImages`(或用户
  指明才用 `firstFrame`)。
- **视频编辑**: source clip into `referenceVideos`(+新元素图入 `referenceImages`),
  增加元素=「特征+时机+位置」;删除=点名要删的、强调保留的;修改=直接描述换后的样子。
- **视频延长**: 1–3 段源片入 `referenceVideos`,描述连接/向前向后延长。

**素材引用铁律**:prompt 里用序号 `图片1 / 视频1 / 音频1` 指代,严禁裸写 assetId。
**音频参考只收 mp3 / wav**;视频容器(.mov/.mp4,哪怕黑屏占位)会被拒收——先用
`ffmpeg-win` 抽音轨(`ffmpeg -y -i in.mov -vn -acodec libmp3lame -q:a 2 out.mp3`)。
黑屏 MP4 只用于 understand_video,绝不能当音频参考上传。
**真人脸**:Seedance 不收真人脸参考,用人像库虚拟形象 `asset://assetId` 或
Seedance 自产片段二创。**别把未处理的 Seedance 视频整段回喂**(二次编码打折)——
优先用 `ffmpeg-win` 抽尾帧/关键帧成静图(下一镜 `firstFrame` 最稳)或抽音轨续节奏;
整段回喂只作规避真人脸审核的兜底。

## 角色片 / 多镜(标准及以上):先备齐资产,再开生成

只要有**反复出现的角色**或**不止一个镜头**,先锁资产再生成(绑定语法与路径 A/B
判定以 `sd2-pe` 为准):

1. **人物卡先锁人**:每个出镜角色一张大头照 + 一张全身照存入人像库作唯一身份锚
   (三视图/四视图仅可选补充,慎用——易 ID 漂移)。缺图用 `generate_image` 补定妆照,
   `add_to_portrait_library` 存成 `asset://assetId`,prompt 里绑
   `<主体1> 面部参考 图片1、妆造参考 图片2`。
2. **多镜先排故事板**:拆成 镜头1/镜头2/…,每镜按 运镜→主体动作/表情→位置/空间→音频
   写清,给用户过一遍。一镜一运镜、用镜头序号、不写绝对秒数。
3. **资产齐备 GATE(硬门)**:逐镜清点人物卡/场景图/道具/氛围参考/参考视频/音频,
   任一该有未备的先补齐再生成。推荐每镜 4–5 个素材。缺口处理三选一:
   ① 项目/人像库里找现成(`list_portrait_library`);② 非身份关键的自己
   `generate_image` 补;③ 身份/IP/品牌关键的用 `ask_user` 请用户提供。
4. **生成用上全部可用资产**:图/视频/音频逐一传入并在 prompt 里绑定,
   有素材却只发纯文字 = 错。
5. **一次生成一个专属素材夹**(如 `<workspace>/assets/jobs/S01_<slug>/`),
   复用、检查、定位问题都只看一个夹。

> 轻量例外:单图「让它动起来」这类一次性请求(快速模式)不必强排人物卡/故事板。

## 写 prompt:`sd2-pe` 是底座,技法按症状加载

**生成前必须把提示词用 skill 写到位,不许凭记忆硬写**(快速模式也要——`sd2-pe`
路径 A 本身就是给简单镜的最短句式):

1. **`sd2-pe`(必经底座)**:八大要素 + 路径 A/B 判定 + 多模态绑定;最后保留
   12 字段格式化骨架。真人、2D 动画、3D 动画作为可组合的媒介 profile；
   “电影/电影感”作为检索创作技法的意图词，不是互斥类别。每次视频任务字段
   只能增加不能减少;结构化文本 never JSON;物理/可复现参数(焦段 mm、光圈、
   色温 K)优先于情绪形容词。
2. **写运镜/景别前先调 `search_cinematography_kb` 工具**(本地运镜与结构化描述库)
   拿真实术语再落笔;工具不可用再退回联网检索。
3. **标准模式:按症状表挑 2–3 个技法 skill**(浏览 `~/.agents/skills/`,plain-text
   名称按需加载,不是全量):

   | 症状 / 任务信号 | 对症技法(按需挑,非必载) |
   |---|---|
   | 太假/塑料/空洞/站桩/NPC | storyboard-live-character-realism · storyboard-character-acting · storyboard-character-motivation |
   | 像壁纸/没纵深/没电影感 | storyboard-foreground-occlusion · storyboard-pseudo-perspective · director-cinematic-composition |
   | 动作怪/武打飘/打击感差 | storyboard-physics · storyboard-kinematic-reverse-engineering |
   | 光平/糖水/塑料高光 | storyboard-light-reconstruction · director-lighting-continuity |
   | 风格不像/调色跑偏 | storyboard-color-grading-control · storyboard-style-extraction-logic · director-style-consistency |
   | 多角色混脸 | storyboard-multi-character-control · director-character-consistency |
   | 提示词太长/权重稀释 | storyboard-video-prompt-optimization |
   | 提到真实电影/导演/品牌/时代,或「像·复刻·高级」 | codex-research-grounded-prompting(先查证再落笔) |
   | 日式动画质感/作画 | animation-craft · director-anime-quality-boost |

4. **专业模式:载入 `director-orchestrator`** 做复杂镜头设计(13 维按需展开、
   多技法协同);它只做镜头设计与提示词结构,不重跑本入口的分级与路由。
5. **制片模式:移交 `film-studio`**,由其 G0–G8 门控按阶段编排(剧本/分镜/资产/
   出图/出片/后期),本 skill 只负责其中每一镜的 `generate_video` 执行。

## Steps

1. Turn the request into one clear video prompt(subject, action, camera 运镜/景别,
   scene, lighting, mood;dialogue 与 `--style` 可后置)。
2. **规格确认(spec_confirmed)**:用户没说规格时,发一张 `ask_user` 卡确认
   分辨率(`480p` 草稿 / **`720p` 默认** / `1080p`)、时长(4–15s,默认 5)、
   比例(`16:9` / `9:16`),推荐默认项。**不要静默升 1080p**;用户已给规格或本会话
   已确认过就跳过。
3. Call `generate_video`:`prompt`(必填)、`model`(`2.0` 默认,用户明确要
   快/便宜才 `2.0-fast`)、`resolution` / `ratio` / `duration`、
   `referenceImages`(**用户给过的图必须传**;支持 `asset://assetId`)、
   `referenceVideos` / `referenceAudios`(每段 ≤50MB、4–15s)、或显式要求时的
   `firstFrame` / `lastFrame`。
4. Wait for the tool to return — it blocks until done. Do NOT resubmit or
   "check progress" in between.
5. Read the result banner:
   - `✅ DONE` + `📁 SAVED FILE: <path>` → task COMPLETE. Confirm briefly,
     **name the mode**, cite the saved path. Do NOT re-check or re-generate.
   - `✅ DONE` with background save pending → generation complete; mention briefly.
   - `⏳ STILL RUNNING`(rare, >10 min)→ call `check_video_task` with the taskId
     repeatedly (long-polls ~25s) until DONE/FAILED. Never resubmit.
   - `❌ FAILED` → report the upstream error; retry ONCE only if it suggests a
     content/parameter fix.

## QA:按风险分级,不是每条视频全套跑

| QA 级别 | 触发条件 | 动作 |
|---|---|---|
| **快速 QA**(快速模式默认) | 普通单镜、无人脸特写、无复杂动作 | 确认 DONE banner + 时长/文件正常即可;不自动抽帧、不自动上传理解模型 |
| **视觉 QA** | 人脸/手部是重点、多人物、武打/复杂动作、用户要求查画质、疑似穿帮 | 九宫格 contact sheet + `view_image`(见下) |
| **内容 QA** | 多镜剧情、台词/字幕/口型、连续性检查、视频编辑核对、用户明确要求审片 | `catimation-understand` 的 understand_video 看整段 |
| **发布 QA**(制片交付) | 正式交付/成片 | ffprobe 编码/分辨率/帧率/响度 + 九宫格 + 内容审查 + 平台规格(走 `ffmpeg-win` 的 inspect→process→verify 循环) |

**九宫格做法**(视觉 QA):用 `ffmpeg-win` 抽 9 帧拼图,
`ffmpeg -i "<clip>.mp4" -vf "fps=9/<DURATION>,scale=320:-1,tile=3x3:padding=6:color=black" -frames:v 1 -y "<clip>_grid.png"`,
然后 `view_image` 那张 `_grid.png`。画布上的视频用 `get_canvas_video` 拿
`videoPath`,别搜盘。判定标尺(源自 VisionReward/WorldReasonBench 核心项):
视觉美观 s_a、时间一致性 s_c(主体稳定/运动平滑/不闪烁)、物理合理 s_r、
prompt 对齐,逐项判通过/不通过;**单帧崩坏一票否决**(最差帧原则),首帧从严。
需要总分时 `S(v) = 0.4·s_r + 0.3·s_c + 0.3·s_a`。

触发了视觉+内容两级时,两面是同一次自检,别二选一。任一不达标 → 带**针对性**
改进点重生成(补哪个技法的哪个字段,不是泛泛「优化一下」),
**iterate at MOST 2–3 times** — each render costs money and ~1–3 min。
**Never** inject the full MP4 or raw bytes into the chat;用户已在聊天里看着它播。
做过的 QA 记入 `visual_qa_done` / `content_qa_done`,下游不重复抽帧。

> 宫格图/故事板 = 素材,不只是检查工具:可回喂 `referenceImages` 传主体/风格,
> 或抽关键帧/尾帧作下一镜 `firstFrame`(跨镜续接优先抽帧,不整段回喂)。

## Organize finished clips into the user's workspace (when in a project)

**COPY, don't move** the finalized MP4(和它的 `_grid.png`)into a tidy assets
subfolder with zero-padded shot ordinals — e.g.
`<workspace>/assets/video/S01_station_wide.mp4`、
`<workspace>/assets/contact-sheets/S01_station_wide_grid.png` — so clips
assemble in order for a later ffmpeg concat. Skip for one-off casual clips.

## Portrait library(人像库)— push materials in, then reference

The `catimation` MCP server exposes portrait-library tools
(`add_to_portrait_library` / `list_portrait_library` / `edit_portrait_library` /
`download_portrait_asset`,详见 catimation-portrait-library skill),围绕视频
生成主动使用:传给 `generate_video` 的输入图会自动入库并 dedupe 成同一
`asset://assetId`;用户给的要记住/复用的素材先 `add_to_portrait_library` 再引用;
「还是上次那个人」用 `list_portrait_library` 找回同一 asset 保持身份一致;用户在
人像库页给的 `asset://assetId` 直接传入。

## Notes

- One `generate_video` call = ONE video. 多条就多次调用、复用同一 asset://
  保持一致性;可并行,但**一次要发 20+ 个任务先向用户确认**(每条都花钱且渲染
  1–3 分钟)。
- Local input files are handled for you(images ≤30MB, video/audio ≤50MB & 4–15s);
  pass plain local paths, the tool deals with size limits.
- **Background saving never blocks you**: banner DONE = 视频已在播,本地保存可能
  还在后台(`persistencePending`),当作 COMPLETE 立即回复,不要等待或轮询保存。
