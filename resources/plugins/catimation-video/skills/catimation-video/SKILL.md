---
name: catimation-video
description: >-
  FIRST-CHOICE video generator and the ONLY top-level video orchestrator in
  CATIMATION. Trigger whenever the user asks to generate / render a video or
  animation, animate a still, or says 生成视频 / 图生视频 / 让它动起来 / 视频编辑 /
  视频延长 / 视频工作台 / 批量出片 / 多镜. Covers text/still-to-video, omni-reference
  (全能参考, default), editing and extension on both output surfaces
  (generate_video one-shot + video_workbench_* batch), and grades every request
  快速/标准/专业/制片 before loading other skills.
---

<!-- skill-budget: pro -->

# Generate videos in CATIMATION(唯一视频入口 · 分级调度)

When the user wants a video, pick the output surface first: **`generate_video`**
(single shot, delivered straight into the chat) or the **`video_workbench_*`**
tools(「生成视频」工作台页:多卡批量、逐卡改参数、用户看着卡片渲染)。两者都在
`catimation` MCP server 上,共用本 skill 的分级与提示词纪律。走 `generate_video` 时:
It submits the render and blocks for roughly 75s to catch
fast completions and early failures. It may return DONE/FAILED, or
`STILL RUNNING + taskId`; only in the latter case continue with `check_video_task`
long-polls until terminal. Never sleep and never resubmit the same render. The user
watches a live progress bubble; the finished MP4 plays inline in the chat, is saved
to a local file, and lands in the app history page.

**本 skill 是视频生成的唯一顶层编排者。** 其它 skill(导演/分镜/工艺/QA)都由这里
按任务分级选择性加载;任何下游 skill 不得反过来重跑路由或重新编排本流程。

## STEP 0 — 任务分级(先定级,再加载;技法勿滥载)

默认进入**快速**模式;只有命中升级条件才升级。定级后在心里记住执行状态
(`task_level / direction_confirmed / spec_confirmed / prompt_engineered /
qa_completed / generation_attempts`),已完成的步骤**不再重复执行**:
规格确认过就不再问、提示词写好就不再重写、QA 做过就不再重抽。

**提示词底座自动触发(例外):** 凡属视频相关任务——出片、写/改/优化视频提示词、
Seedance 语法/全能参考问答——**自动加载 `sd2-pe`**,不需用户点名。路径 A
仅限简单、单镜的轻量连续任务，可由 `sd2-pe` 独立完成；复杂、多镜、混合媒介或
需要展开导演/作品参考任一命中即进入路径 B，并加载结构叶子
seedance-cinematic-format。路径 B 条件优先于生成/编辑/延长/组合等任务类型。
下文「对症加载 /
别自行放大」同样适用于该结构叶子。

| 模式 | 典型请求 | 加载预算(含本 skill) | 默认动作 |
|---|---|---|---|
| **快速** | 「让这张图动起来」「生成5秒海浪」单镜简单请求 | ≤2 顶层:本入口 + `sd2-pe` | 路径 A,合理默认,直接生成,快速 QA |
| **标准** | 单人物表演、简单电影感、带参考图的单镜 | ≤3 顶层:入口 + `sd2-pe` + 1 个对症技法 | 按一个主要风险挑技法,视觉 QA |
| **专业** | 武打/多人/参考复刻/复杂运镜/跨镜一致性 | ≤5 顶层:入口 + `sd2-pe` + `director-orchestrator` + 最多 2 个对症技法 | 13 维按需展开,视觉+内容 QA |
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

All modes work on **both** surfaces(`generate_video` 与 `video_workbench_*`)
— pick by inputs + prompt:

- **文生视频**: `prompt` only. **图生视频**: still into `referenceImages`(或用户
  指明才用 `firstFrame`)。
- **视频编辑**: source clip into `referenceVideos`(+新元素图入 `referenceImages`),
  增加元素=「特征+时机+位置」;删除=点名要删的、强调保留的;修改=直接描述换后的样子。
- **视频延长**: 1–3 段源片入 `referenceVideos`,描述连接/向前向后延长。

**素材引用铁律**:Skill 写作与 prompt 示例用 `@图片1 / @视频1 / @音频1` 指代，
严禁裸写 assetId；提交生成工具时自动归一为 `图片1 / 视频1 / 音频1`，`@` 不是
上游 API 参数。运行时兼容 `@Image1/@图片1/【@图片1】/<图片1>` 等外部写法。
**音频参考只收 mp3 / wav**;视频容器(.mov/.mp4,哪怕黑屏占位)会被拒收——先用
`ffmpeg-win` 抽音轨(`ffmpeg -y -i in.mov -vn -acodec libmp3lame -q:a 2 out.mp3`)。
黑屏 MP4 只用于 understand_video,绝不能当音频参考上传。
**真人脸**:Seedance 不收真人脸参考,用人像库虚拟形象 `asset://assetId` 或
Seedance 自产片段二创。**别把未处理的 Seedance 视频整段回喂**(二次编码打折)——
优先用 `ffmpeg-win` 抽尾帧/关键帧成静图(下一镜 `firstFrame` 最稳)或抽音轨续节奏;
整段回喂只作规避真人脸审核的兜底。

### 两条出片面怎么选

- **`generate_video`**:单镜、一次性、用户没点名工作台。成片直接进聊天并落历史页。
- **`video_workbench_*`**:多镜批量、用户已经在「生成视频」工作台、需要逐卡改参数或反复
  重跑。先 `video_workbench_add_tasks` 建卡(默认只填不跑,`autoStart:true` 才立即渲染);
  批次跑完会主动推「[视频工作台] 批次渲染完成」,**别轮询** `video_workbench_status`。
  跨多卡的整理/重排/换规格用 `video_workbench_export` → 改 JSON → `video_workbench_apply`。
- 两条面共用**同一套** STEP 0 分级、上面那组素材 caps 与素材引用铁律 —— 工作台不是例外。
  有参考图时同样先 `view_image` 看图再写 prompt。

## 角色片 / 多镜(标准及以上):先备齐资产,再开生成

只要有**反复出现的角色**或**不止一个镜头**,先锁资产再生成(绑定语法与镜头规划
以 `sd2-pe` 为准):

1. **人物卡先锁人**:每个复用角色先确定一套 `identity-hard` 主锚。可用大头照+
   全身照、三视图/四视图/多视图角色板，或用户确认的其它干净角色资产。用户已
   提供/指定就服从；有多套候选且拿不准时，用 `ask_user` 请用户选主锚；仅未指定的
   低风险任务默认大头照+全身照。缺图用 `generate_image` 补，随后
   `add_to_portrait_library` 存成 `asset://assetId` 并在 prompt 明确绑定职责。
2. **多镜先排故事板**:拆成 镜头1/镜头2/…,每镜按 运镜→主体动作/表情→位置/空间→音频
   写清,给用户过一遍。一镜一运镜、用镜头序号。可用图像模型生成 3×3/4×4
   故事板/多宫格/电影美术设定板作为氛围图；这不取代用户选定的身份锚，
   干净关键帧锁当前片段构图/画质。**只要这些板被加入视频参考，提示词必须先写
   “提示词主导 / 氛围板低约束”前缀**，整板只负责色彩/光线/材质/时代感/空间气质/
   视觉母题，不要求构图、动作或顺序一致。
3. **资产齐备 GATE(硬门)**:逐镜清点人物卡/场景图/道具/氛围参考/参考视频/音频,
   任一该有未备的先补齐再生成。推荐每镜 4–5 个核心素材。缺口处理三选一:
   ① 项目/人像库里找现成(`list_portrait_library`);② 非身份关键的自己
   `generate_image` 补;③ 身份/IP/品牌关键的用 `ask_user` 请用户提供。
4. **生成用上全部可用资产**:图/视频/音频逐一传入并在 prompt 里绑定,
   有素材却只发纯文字 = 错；有故事板/多宫格却漏掉 mandatory 氛围职责前缀 = 错。
5. **一次生成一个专属素材夹**(如 `<workspace>/assets/jobs/S01_<slug>/`),
   复用、检查、定位问题都只看一个夹。

> 轻量例外:单图「让它动起来」这类一次性请求(快速模式)不必强排人物卡/故事板。

## 写 prompt:`sd2-pe` 是底座(相关即载),技法按症状加载

**生成前必须把提示词用 skill 写到位,不许凭记忆硬写**。快速模式可以走路径 A
并跳过结构叶子,但八大要素、12 项覆盖与五大必备内容块仍不得缺失。有视频相关
任务就先载入 `sd2-pe`,再写
prompt;不要等用户说「优化提示词」才加载:

1. **`sd2-pe`(必经底座) + seedance-cinematic-format(复杂任务条件加载)**:
   路径 A 仅处理简单单镜连续正文；复杂、多镜、混合媒介或展开导演/作品参考任一
   命中即走路径 B 并加载结构叶子，且 B 条件优先于任务类型。两条路径都覆盖八大
   要素、12 项内容和五大必备块，标题、分段与散文形式自由；并主动出 2–3 个已
   核实影视参考候选供用户挑选。真人、2D 动画、
   3D 动画作为可组合
   的媒介 profile；“电影/电影感”作为检索创作技法的意图词，不是互斥类别。
   结构化文本 never JSON;物理/可复现参数(焦段 mm、光圈、色温 K)优先于情绪
   形容词。
2. **写运镜/景别前先调 `search_cinematography_kb` 工具**(本地运镜与结构化描述库)
   拿真实术语再落笔;工具不可用再退回联网检索。
3. **标准模式:按最主要症状挑 1 个技法 skill**(浏览 `~/.agents/skills/`,plain-text
   名称按需加载,不是全量)。多风险协同时升级专业模式,而不是突破标准级预算:

   | 症状 / 任务信号 | 对症技法(按需挑,非必载) |
   |---|---|
   | 太假/塑料/空洞/站桩/NPC | storyboard-live-character-realism · storyboard-character-acting · storyboard-character-motivation |
   | 像壁纸/没纵深/没电影感 | storyboard-foreground-occlusion · storyboard-pseudo-perspective · director-cinematic-composition |
   | 动作怪/武打飘/打击感差 | storyboard-physics · storyboard-kinematic-reverse-engineering |
   | 光平/糖水/塑料高光 | storyboard-light-reconstruction · director-lighting-continuity |
   | 风格不像/调色跑偏 | storyboard-color-grading-control · storyboard-style-extraction-logic · director-style-consistency |
   | 多角色混脸 | storyboard-multi-character-control · director-character-consistency |
   | 九宫格/多宫格故事板、电影美术设定板、整板低约束参考或拆格执行 | storyboard-grid-to-seedance |
   | 提示词太长/权重稀释 | storyboard-video-prompt-optimization |
   | 提到真实电影/导演/品牌/时代,或「像·复刻·高级」 | codex-research-grounded-prompting(先查证再落笔) |
   | 日式动画质感/作画 | animation-craft · director-anime-quality-boost |

4. **专业模式:载入 `director-orchestrator`** 做复杂镜头设计(13 维按需展开、
   多技法协同),再按具体风险最多补 2 个技法;它只做镜头设计与提示词结构,
   不重跑本入口的分级与路由。
5. **制片模式:移交 `film-studio`**,由其 G0–G8 门控按阶段编排(剧本/分镜/资产/
   出图/出片/后期),本 skill 只负责其中每一镜的 `generate_video` 执行。

## Steps

0. **有参考图就先看一眼(look before you write)**:手上有用户给的图 / 人像库
   asset / 故事板时,先 `view_image` **一张有代表性的**,再据你**看到的**东西
   (主体、景别、配色、服装、光线)写提示词。照文件名或用户一句话臆想出来的提示词
   会和画面打架,而模型跟的是画面。这与「不要批量打开自己刚生成的产物」不冲突:
   那些用户已经在聊天里看着了,这是你的**输入**,看一张是让提示词对得上它的前提。
   多图只看代表性的 1 张(最多 2 张),别整批灌进上下文。
1. Turn the request into one clear video prompt(subject, action, camera 运镜/景别,
   scene, lighting, mood;dialogue 与 `--style` 可后置)。
2. **规格确认(spec_confirmed)**:用户没说规格时,发一张 `ask_user` 卡确认
   分辨率(`480p` 草稿 / **`720p` 默认** / `1080p`)、时长(4–15s,默认 5)、
   比例(`16:9` / `9:16` / `4:3` / `3:4` / `1:1` / `21:9`),推荐默认项。
   **不要静默升 1080p**;1080p 仅满血 `2.0`;用户已给规格或本会话已确认过就跳过。
3. Call `generate_video`:`prompt`(必填)、`model`(`2.0` 默认,用户明确要
   快/便宜才 `2.0-fast`)、`resolution` / `ratio` / `duration`、
   `referenceImages`(**用户给过的图必须传**;支持 `asset://assetId`)、
   `referenceVideos` / `referenceAudios`(每段 ≤50MB、4–15s)、或显式要求时的
   `firstFrame` / `lastFrame`。
4. Wait for the tool to return — it blocks until done. Do NOT resubmit or
   "check progress" in between.
5. Read the result banner:
   - `✅ DONE` + `📁 SAVED FILE: <path>` → task COMPLETE. **第一步永远是交付**:
     先用一句话向用户确认(成片已在聊天里播放 + 保存路径,**name the mode**),
     **然后**才做任何 QA。Do NOT re-check or re-generate.
   - `✅ DONE` with background save pending → generation complete; mention briefly.
   - `⏳ STILL RUNNING` → 先向用户说一句「正在生成中」(如果还没说过),再 call
     `check_video_task` with the taskId repeatedly (long-polls ~25s) until
     DONE/FAILED. Never resubmit. 多轮轮询之间不要让用户干等无声。
   - `❌ FAILED` → report the upstream error; retry ONCE only if it suggests a
     content/parameter fix.

## QA:按风险分级,不是每条视频全套跑

**交付优先铁律**:任何级别的 QA 都发生在**向用户交付之后**——先一句话交付成片,
决定跑 QA 时再说一句「正在做视觉质检(抽帧九宫格)…」之类**出声**再动手。用户看
不到工具调用,先闷头抽帧/审片再回话,在用户眼里就是「卡死」(2026-07-14 实录教训)。
QA 发现问题需要重生成时,同样先告诉用户哪里不达标、准备怎么改。

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
改进点重生成(补哪个技法的哪个字段,不是泛泛「优化一下」)。自动修正
**最多 2 次**；`generation_attempts` 到 2 后仍不通过,先向用户说明成本/问题并请求
确认,不得继续付费重试。
**Never** inject the full MP4 or raw bytes into the chat;用户已在聊天里看着它播。
做过的级别记入 `qa_completed`(如 `["visual","content"]`),下游不重复抽帧。

> 宫格图/故事板/美术设定板 = 辅助素材,不只是检查工具:整板可回喂
> `referenceImages` 传色彩/光线/材质/时代感/空间气质/视觉母题,但不承担故事、
> 构图、动作、顺序、时长、身份或 `firstFrame`;有板即带提示词主导前缀。要精确
> 跟随某格就先拆格、去边框文字、重绘成干净关键帧。跨镜续接优先抽关键帧/尾帧作
> 下一镜 `firstFrame`,不整段回喂。

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
