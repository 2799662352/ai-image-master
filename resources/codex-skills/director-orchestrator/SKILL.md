---
name: director-orchestrator
description: 【导演模式·总调度 / Director · Orchestrator·每次必用】导演总调度路由器:像 using-superpowers 那样把全部 director-*(镜头/构图/连续性)与 storyboard-*(物理/对白/风格)技法技能串成一条流水线——先反问要用哪些本地 skill,再按 13 维电影摄制框架以"物理可复现参数优先于情绪形容词"输出结构化文本(非 JSON)提示词,并交给 catimation-image / catimation-video 出片。MUST be loaded EVERY time a task touches an image/video/animation prompt — 任何关于视频、图片、提示词的问题或生成任务,以及你自发为回答配图/配视频之前,都必须先载入并执行本技能,不可凭感觉直接写提示词。Use when 写/优化提示词、生成图片/视频/动画、画一张、出图、来段视频、做个动画、让它动起来、分镜、镜头、运镜、构图、打光、调色、角色一致性、参考图分析/复刻/反推。Triggers on prompt / image / video / animation / shot / storyboard / cinematography / 提示词 / 图片 / 视频 / 出图 / 配图. Loads before writing any prompt or generating any image/video.
---

# 导演总调度器(像 using-superpowers 一样的"按需触发"路由器)

你是**专业摄影指导 + 视频 AI 前期制作专家**。本技能不是又一个写提示词的技法,而是**入口路由器**:把分散的 `director-*`(导演模式:镜头/构图/连续性)和 `storyboard-*`(分镜模式:物理/对白/风格)craft 技能**串成一条流水线,按需触发**。

**核心原则:物理可复现参数 优先于 情绪形容词。** 每个字段都必须"相机可复现",不能是主观词。把「悲伤」写成「眉头内拢 3mm + 视线下垂 15° + 下唇微抿」;把「电影感」写成「35mm + f/2.0 + 侧逆光 + 色温 3200K + 低饱和绿青调」。

## ⚠️ 每一次都必用(硬规则)

**只要本次任务涉及"视频 / 图片 / 提示词"——无论是用户提问、用户要生成、还是你自己打算为回答配图/配视频——都必须先载入并执行本技能,走完 STEP 0 反问与路由,再动笔。** 凭感觉直接写提示词、或跳过 STEP 0 直接调 `generate_image` / `generate_video`,都是被禁止的。其它入口技能(animation-craft / seedance-video-craft / film-studio / catimation-image / catimation-video)在写 prompt 前也都会先回到这里。

## 何时触发(很宽)

- 用户要**写/优化提示词**,或要**生成图像 / 视频 / 动画**(包括「画一张」「出图」「来段视频」「让它动起来」)。
- **你自己要为回答配图 / 配视频**时(自发调用 `generate_image` / `generate_video` 之前),同样先过本技能。
- 用户给了**参考图**要你分析、复刻、反推。
- 任何时候你打算"凭感觉"直接写提示词 —— 停,先走 STEP 0。

> 像 using-superpowers:**只要有 1% 可能用得上某个 craft 技能,就去加载它。** 加载后发现不合适,丢掉即可。

## STEP -1 —— 先过路由闸门 `catimation-video-director-router`(强制,任何出图/出视频的第一步)

**在 STEP 0 之前**,只要本次要 `generate_image` / `generate_video`,先加载并执行 `catimation-video-director-router`:把用户的自然语言症状(太假 / 不像电影 / 动作怪 / 站桩 / 风格跑了)映射成技能、套上任务类型的**最低套餐**、产出一张**导演路由表**(命中症状 / 任务类型 / 必载 skill / 可选 skill / prompt 落地证据 / 生成后 QC)。**没有路由表就不许生成。** 路由器给出"必载 skill"清单后,回到本 STEP 0 逐个加载它们。

## STEP 0 —— 先反问(强制,不可跳过)

写任何提示词 / 调用任何生成工具**之前**,先对自己做这套反问(可在必要时用 `catimation-brainstorm` 的 `ask_user` 卡片摊给用户确认):

1. **「AI/Codex 有没有注意到这些?」** —— 这次任务涉及 13 维里的哪几维?(主体动作 / 景别焦段 / 机位角度 / 运镜 / 构图 / 景深对焦 / 光源照明 / 色温调色 / 环境时空 / 角色锚点 / 物理微表情 / 节奏时间线 / 风格质感)。**默认往多里勾,不是往少里挑**——一个正经镜头(有人、有场景、有动作/情绪)几乎必然同时涉及 主体 / 景别 / 构图 / 景深 / 光影 / 色温 / 角色 / 物理微表情 / 风格 这一大片,视频再加 运镜 / 节奏 / 连续性。**只把「明显和本镜无关」的那一两维划掉,剩下的全算「涉及」。** 只勾出 2–3 维 = 你没认真看画面。
2. **「要用到哪些本地 skill?」** —— 按 `references/skill-routing-map.md` 把涉及的维度映射到具体 `director-*` / `storyboard-*` 技能,**列出来再逐个加载**(读取其 SKILL.md / references)。**默认技能面要宽**:典型镜头一次用到 **6–12 个**技法技能是常态,不是 2–3 个;宁可多列多载,不要漏。(见下方「默认镜头技法包」。)
3. **「素材齐了吗?」** —— 有没有参考图 / 角色 / 上一条生成结果要复用?(图像走 `referenceImages`,视频走全能参考)
4. **「目标模型是谁?」** —— 可灵 / 即梦 / Seedance(视频)或 gpt-image / Midjourney / FLUX / SD(图像),决定字段写法与是否需要负向字段。

把第 1、2 条的结论**简短说给用户听**(例:「这镜头我会用 director-cinematic-composition + storyboard-visual + director-lighting-continuity,按 13 维写」),再开始写。这一步就是本调度器的灵魂。

> **写运镜 / 景别 / 结构化描述字段前,先查 `search_cinematography_kb`**(运镜与结构化描述知识库,见下方「术语来源」段)——拿库里的真实术语与结构范式再落笔,别只凭记忆。

## STEP 0.4 —— 默认镜头技法包:广触发,别只挑 2–3 个

**触发太窄是本调度器最大的失败。** 你手里有 50+ 个 `director-*` / `storyboard-*` 技法技能,一个正经镜头本来就该同时吃很多。默认按 using-superpowers 的 **1% 规则**:**能沾边就加载,只把明显无关的划掉**——而不是反过来「只挑最主要的两三个」。

**默认镜头技法包(有角色 + 场景的镜头 → 默认全载,逐项只在明显无关时才跳过):**

| 面向 | 默认加载(基线) | 视情况再加 |
|---|---|---|
| 角色 / 人像 | `director-character-consistency` + `director-anchor-extraction-quality`(从参考图/网格锁角色) | 多角色 `storyboard-multi-character-control` |
| 构图 / 纵深 | `director-cinematic-composition` + `storyboard-foreground-occlusion`(前景遮挡) | `storyboard-pseudo-perspective`、`storyboard-visual` |
| 光影 | `storyboard-light-reconstruction` | `director-lighting-continuity`(多镜) |
| 色调 | `storyboard-color-grading-control` | `director-visual-continuity`(多镜) |
| 物理 / 演技(写实 / 实拍人物) | `storyboard-physics` + `storyboard-live-character-realism` | `storyboard-character-acting`、`storyboard-character-motivation` |
| 风格 / 质感 | `director-style-consistency` | 动画 `director-anime-quality-boost`、`storyboard-style` |
| 环境 / 场景 | `director-scene-analysis-depth` | `storyboard-scene-breakdown` |
| 视频专属(生视频时) | `sd2-pe` + `storyboard-video-prompt-optimization` + `storyboard-kinematic-reverse-engineering`(运镜) | Seedance `seedance-video-craft`;多镜 `director-narrative-flow` + `director-shot-sequence-patterns` |

- **默认基线 ≈ 6–12 个技能**,视频镜头更多。低于这个数就该反问自己「是不是又挑窄了」。
- **只有当某项和本镜明显无关才跳过**——例如纯风景空镜没有人 → 跳过角色/演技那几项;静态单图 → 跳过运镜/节奏那几项。跳过要有明确理由,不是默认省略。
- 这就是**渐进式披露的正确含义**:披露 = 加载「所有能沾边的」(通常十来个),**不是**只加载 2–3 个,也不是一次性 63 个全塞。

### 不得降级为「轻量图生视频」的请求(必走完整导演链路)

最常见的翻车是把一个**该走完整导演链路**的镜头,当成「单图让它动起来」的轻量路径处理,只加载最低限度的生成链路。**以下任一命中,就禁止走轻量路径**,必须按上面的默认技法包展开:

- 有**人物表演 / 情绪 / 演技**(不是纯物体/风景动一下)。
- **武侠 / 动作 / 打斗 / 运动**类镜头。
- 用户点了**「电影感 / 有质感 / 活人感 / 高级」**等表达。
- **参考图 → 视频 / 图**(拿一张图去生成,而不是纯文生)。
- 有**反复出现的角色**或**不止一个镜头 / 事件**。

真正能走轻量的只有:**纯物体/风景的一次性「动一下」、随手来一段、明确说要草稿/快点**,且画面里没有需要表演的人。**拿不准时,按完整链路走**(多载几个技能的成本,远小于出一条塑料 NPC 片重做的成本)。

### 分层套餐 + 症状路由(见路由表)

先判断任务落在哪一层(`references/skill-routing-map.md` 的「任务类型 → 最低 skill 套餐」),**从上往下叠加**:①单图动起来 → ②人物图生视频 → ③电影感人物视频 → ④武打/武侠 → ⑤多镜连续片。**低层是高层的子集**,武打片要把 ①②③ 全含上。另外**别等用户点名 skill**——用户说的是症状(「太假 / 像 NPC / 没质感 / 藏龙卧虎」),按路由表「按症状路由」自动加载对应技能。

### 生成前先输出「导演路由表」(强制,评审的执行证据)

在调 `generate_image` / `generate_video` **之前**,先产出下面这张表(至少内部完成,武侠/电影感/人物片建议直接给用户看)。它是「流程约束」,不是靠自觉:

```text
本镜涉及维度:主体动作 / 景别焦段 / 运镜 / 构图 / 前景遮挡 / 光源色温 / 角色活人感 / 行为动机 / 物理惯性 / 调色 / 音频
本次加载 skill:director-orchestrator, sd2-pe, storyboard-video-prompt-optimization, storyboard-live-character-realism, storyboard-character-acting, storyboard-character-motivation, storyboard-foreground-occlusion, storyboard-physics, director-cinematic-composition, storyboard-color-grading-control, storyboard-audio
未加载及原因:<逐个明确写清为何不需要;写不出理由 = 不该省>
```

**先表、后生成。** 数量低于该层套餐基线就回头补;若这是武侠电影视频而表里没有 活人感 / 前景遮挡 / 物理 / 调色 —— 明显漏了。

### 每个加载的 skill 必须在 prompt 里留下「落地痕迹」(否则等于没触发)

**光说「用了活人感」不算数**——最终 prompt 里要能看到每个 skill 的具体贡献字段。加载了就必须落地:

- `storyboard-live-character-realism` 痕迹:眼神从画外滑到手中武器 + 短促眨眼一次;下颌绷紧约半秒、握剑手指压紧;衣袖随浅呼吸起伏;皮肤哑光漫反射、无油亮塑料高光。
- `storyboard-foreground-occlusion` 痕迹:左前景极虚化竹叶/门框遮住约 1/3 画面;横移时前景遮挡产生视差;空气有薄雾、浮尘、柔和光路。
- `storyboard-physics` 痕迹:手腕转半圈、剑自胸前斜向外挡;冲击带动身体侧后滑半步、靴底擦地;袖口发丝受剑风同向延迟摆动。

生成前对着「本次加载 skill」逐个问:**它的痕迹在 prompt 里吗?** 没有就补写,别急着调工具。

## STEP 0.5 —— 加载闸门:点名 ≠ 加载(强制,最常翻车的一步)

**在写任何字段之前**,把 STEP 0 第 1 问里勾到的**每一个维度**,按路由表逐一对到技能,然后**真的把它的 SKILL.md 读进来**(`npx openskills read <skill>` 或直接读其 SKILL.md / references)。

> **口号:点到了维度,就必须加载对应技能。** 在成品的「所用本地技能」里写了某个 skill,却没在这一轮真的读过它 = 失败,等于没触发。像 using-superpowers:**只要 1% 可能用得上,就加载**——加载后不合适再丢。

**闸门检查(逐条打钩,缺一不可):**
- 勾了 **10 角色锚点 / 一致性**(画面里有反复出现的人 / 角色 / 人像)→ **必须加载** `director-character-consistency`(+ 需要时 `director-anchor-extraction-quality`、多角色加 `storyboard-multi-character-control`)。**只要有「人像」就走这条,别只在嘴上说「注意角色一致」。**
- 勾了 **5 构图**、或画面偏平 / 缺纵深 / 有前后景关系 → **必须加载** `storyboard-foreground-occlusion`(前景遮挡)与 / 或 `storyboard-pseudo-perspective`。**别只写「三分法」就算构图做完了。**
- 其余每一个勾到的维度,同样按 `references/skill-routing-map.md` 找到首选技能并加载,宁可多载不可漏。

**这些念头一冒出来就是在偷懒(停,去加载):**

| 你冒出的念头 | 现实 |
|---|---|
| 「角色一致性我懂,写清脸/发/服装就行」 | 记得概念 ≠ 用了 skill;有人像就**加载** `director-character-consistency` 拿它的锚点纪律。 |
| 「构图我会,三分法带过」 | 平面构图 ≠ 纵深;涉及前后景就**加载** `storyboard-foreground-occlusion` / `storyboard-pseudo-perspective`。 |
| 「我已经在『所用本地技能』里列了它」 | 列名字不等于读过;这一轮没 read 过 SKILL.md 就是没触发。 |
| 「维度太多,挑两个主要的写就好」 | 勾到的都要加载(渐进式披露 = 只加载这镜用得到的,不是「只加载我想写的」)。 |

## 13 维摄制框架(简表;全字段与示例见 `references/cinematography-framework.md`)

| # | 维度 | 必须是相机可复现的物理量 |
|---|------|--------------------------|
| 1 | 主体与动作 Subject·Action | 谁/什么 + 单一核心动作(动作中段、张力峰值) |
| 2 | 景别与焦段 Shot·Lens | 特写/中景/全景 + 焦距 mm(24/35/50/85) |
| 3 | 机位与角度 Camera·Angle | 机位高度(平/仰/俯/顶) + 角度 + 距离 m |
| 4 | 运镜 Movement | 推/拉/摇/移/升降/手持 + 速度 + 方向 + 起止 |
| 5 | 构图 Composition | 三分法 + 引导线 + 前中后景 + 留白/视线空间 |
| 6 | 景深与对焦 DoF·Focus | 光圈 f 值 + 对焦面 + 变焦点/移焦 + 散景 |
| 7 | 光源与照明 Lighting | 主光方向角° + 软硬 + 光比 + 轮廓/补/环境光 |
| 8 | 色温与调色 Color·Grade | 开尔文 K + 主/辅色 hex + 对比 + 胶片/LUT |
| 9 | 环境与时空 Environment | 地点 + 时刻(由阴影角推) + 天气 + 大气 |
| 10 | 角色锚点与一致性 Anchors | 脸/体型/服装/记号 + [char] 标签锁定 |
| 11 | 物理与微表情 Physics | 运动矢量(角°/位移cm/速度) + 眉/瞳 mm |
| 12 | 节奏与时间线 Timing | 单镜时长 s + 节拍结构 + 视频逐帧 |
| 13 | 风格与质感 Style·Texture | 介质(赛璐珞/写实/颗粒) + 物理化情绪线索 |

## 正向提示词为默认(不写反向)

**默认只写正向提示词,把"想要的状态"用真实技法词肯定地写出来**,而不是堆"不要…"清单。
- 例:不写「不要模糊」→ 写「主体锐利对焦,背景 f/1.8 散景」;不写「别变形」→ 写「解剖正确,五指清晰,自然比例」。
- 仅当目标模型确有独立负向字段且确需(SD/Midjourney 的 `--no`),才用 `storyboard-negative-control` / `director-prompt-engineering` 的负向段;能转正向就转正向。审查规避走 `storyboard-dodge`(同样用正向轮廓/物理量改写)。

## 运镜/结构化描述术语来源:先查知识库,再联网(search_cinematography_kb 优先)

写字段前的术语来源有**两级,先库后网**:

1. **首选 `search_cinematography_kb`(运镜与结构化描述库)。** 填 运镜(4)/ 景别焦段(2)/ 机位角度(3)/ 构图(5) 等字段前,或不确定某个运镜术语(推 / 拉 / 摇 / 移 / 甩 / 升降 / 环绕 / 手持…)、想把镜头写成**结构化分镜描述**时,**先调 `search_cinematography_kb` 工具**——它检索本项目的「运镜与结构化描述库」(阿里百炼 RAG:权威运镜术语 + 结构化分镜描述范式 + 镜头语言样例),比泛联网更准、更贴本项目产出格式。传一句自然语言 `query`(如「地铁站手持跟拍 结构化描述」「低角度仰拍推镜 术语」「情绪→生理 微表情量化」),读回检索片段,用其中的**真实术语与结构范式**填 13 维字段。**每次写运镜/结构化描述都先过它一遍**,别只凭记忆。
2. **再联网检索(兜底 / 补充)。** 库里没命中,或涉及具体技法 / 作家 / 片例时,联网查权威资料,不要只靠记忆:
   - 真人/实拍:StudioBinder、ASC、No Film School、ShotDeck、Wikipedia "Cinematic techniques"。
   - 动画作画:Sakugabooru、Sakuga Blog/Journal、Animétudes、ANN/AniDB。
   - 用检索到的**真实技法词**(焦距/f值/景别/运镜/三点光/色温K/LUT/タメツメ/コマ打ち)填字段;商业作品仅作学习参考并标注出处,**不批量下载未授权商业素材**。

> `search_cinematography_kb` 由 codex 内置的 `cinematography_kb` MCP 提供(应用「设置 → 运镜知识库」填 DASHSCOPE_API_KEY 后即可用)。工具不存在 / 未配 key 时静默退回第 2 级联网检索,不要报错卡住。

## 输出格式:结构化文本(非 JSON)

**绝不要求/输出 JSON。** 用带标题的结构化中文文本,直接可喂给生成模型。模板:

```
【镜头 01 / SHOT 01】
主体·动作:…(单一核心动作,动作中段)
景别·焦段:中景 / 50mm
机位·角度:平视,正面偏左 30°,距主体约 2m
运镜:缓慢推近(dolly-in),~0.5x 速,由中景收至胸上
构图:三分法,主体置左交点;前景虚化栏杆,背景街景纵深
景深·对焦:f/2.0,对焦睫毛,背景散景
光源·照明:左侧逆光 45° 硬光,光比 1:4,右侧弱补光,发丝轮廓光
色温·调色:3200K 暖调,主色 #2b1d12 + 点缀 #e8a23d,低饱和高对比
环境·时空:黄昏室内窗边,长斜影,微尘
角色锚点:[char1] 脸/体型/服装/记号锁定(正向描述)
物理·微表情:眉内拢 3mm,瞳孔 4mm,手指收拢速度慢
节奏·时间线:本镜 4s;0–2s 起势,2–4s 推近到位
风格·质感:写实电影颗粒;情绪以光影与微动作呈现
正向提示词(成品):<把以上压成一段英文/中文成品提示词,120 词内,只正向>
所用本地技能:director-cinematic-composition, storyboard-visual, director-lighting-continuity, storyboard-physics
```

多镜头时重复该块并保证连续性(用 `director-visual-continuity` / `director-lighting-continuity` / `director-narrative-flow`)。

## 与 catimation 流程衔接

1. **开放/高价值需求** → 先 `catimation-brainstorm` 用 `ask_user` 卡片定方向(气质/景别/运镜/时长),再回到本调度器写镜头。
2. **明确简单需求**(「让这张图动起来」)→ 跳过提问,STEP 0 自反问后直接写、直接生成。
3. 提示词写好 → 图像交 `catimation-image`(`generate_image`/`generate_images`),视频交 `catimation-video`(`generate_video`,默认全能参考)。素材一律按序号 图片1/视频1/音频1 引用。
4. **出片后必做 `view_image` 自检(分图像 / 视频,别省)。**
   - **图像:出图后 `view_image` 那张成片**,对照 `catimation-image` 四项验收(符合要求 / 质量 / 风格一致 / 过门)亲眼核对,不合格带改进点重生成。
   - **视频:必须过 `ffmpeg-win` 的视觉门 + 反向审片(不是直接宣布完成)**——`view_image` 不能直接开 MP4,所以**视觉结构**用 `ffmpeg-win` 抽帧拼 **3×3 九宫格 contact sheet**,再 `view_image` **那一张宫格图**自检;**同一次自检里再用** `catimation-understand` 的 `understand_video` 看懂**剧情 / 字幕 / 连续性 / 穿帮**(模型替你"看"整段,补上宫格图采不到的帧间内容)——**宫格图 + understand_video 两面一起看,不二选一**,别把 MP4 原始字节塞进聊天、也别拿 `view_image` 去开 MP4。
     - **反向审片清单(逐条对着「本次加载 skill」的落地痕迹核,任一不达标就带针对性改进点重生成一版):**
       - 有没有**前景遮挡 / 纵深**?还是像贴纸壁纸?(`storyboard-foreground-occlusion`)
       - 人物有没有**眼神 / 呼吸 / 手指 / 重心**等微反应?(`storyboard-live-character-realism` / `storyboard-character-acting`)
       - 动作有没有**触发原因**,还是无动机乱动?(`storyboard-character-motivation`)
       - 是不是只是**摆拍 / 站桩 / NPC**?
       - 有没有跑成**玄幻特效 / 发光乱飞**(武侠写实片尤其)?
       - 调性是否符合**低饱和《卧虎藏龙》方向**,而不是艳丽?(`storyboard-color-grading-control`)
       - 有没有**多余人物 / 混脸 / 武器变形 / 首帧被改**?(`director-character-consistency` / `storyboard-video-prompt-optimization` 首帧霸权)
   - **宫格图 / 故事板就是素材**:按剧情裁剪、拼接出的九宫格、分镜板本身是优质可复用素材——回喂 `referenceImages` 传主体/风格,抽尾帧/关键帧作下一镜 `firstFrame`。**跨镜续接首选 `ffmpeg-win` 抽上一镜尾帧/关键帧,而不是把上一段 Seedance MP4 整段当视频参考回喂(整段回喂是兜底,不是首选)。** 需要抽帧/抽音频先载入 `ffmpeg-win`。

## 示例(一次完整调度)

用户:「把这张人物参考图做成黄昏窗边、电影感的特写。」

**STEP 0 自反问(说给用户听):**
> 涉及维度:2 景别焦段、5 构图、6 景深、7 光源、9 环境时空、10 角色锚点、13 风格。
> 我会加载:`director-anchor-extraction-quality`(从参考图锁角色)+ `director-cinematic-composition`(构图)+ `storyboard-visual`(强制 Z 轴/物理光/镜头)+ `storyboard-light-reconstruction`(黄昏窗光)+ `director-scene-analysis-depth`(环境)。参考图走 `referenceImages`。目标:gpt-image,默认正向。

**输出(结构化文本,非 JSON):**
```
【镜头 01 / SHOT 01】
主体·动作:[char1] 倚窗静立,目光投向窗外,呼吸使肩部极缓起伏
景别·焦段:特写 / 85mm
机位·角度:平视,正面偏右 20°,距主体约 1.2m
运镜:固定机位(静帧)
构图:三分法,眼睛置上三分线;前景虚化窗棂,背景窗外街景纵深
景深·对焦:f/1.8,对焦近眼睫毛,背景与前景散景
光源·照明:右侧窗口逆侧光 40° 柔光,光比 1:6,左颊弱补光,发丝暖轮廓光
色温·调色:3400K 暖调,主色 #3a2a1a + 点缀 #f0b25a,低饱和高对比
环境·时空:黄昏室内窗边,长斜影,空气微尘可见
角色锚点:[char1] 脸型/发型/服装/记号按参考图锁定(正向描述)
物理·微表情:眉自然舒展,瞳孔约 4.5mm,下唇微启 1mm
节奏·时间线:单帧定格(图像)
风格·质感:写实电影感,细腻胶片颗粒;情绪靠逆光与微动作呈现
正向提示词(成品):Close-up, 85mm, f/1.8 of [char1] standing by a window at dusk, gazing outside; soft backlight from right window 40°, warm rim light on hair, 3400K, low-saturation high-contrast cinematic grade, rule-of-thirds with eyes on upper third, foreground bokeh of window frame, fine film grain, sharp focus on eyelashes
所用本地技能:director-anchor-extraction-quality, director-cinematic-composition, storyboard-visual, storyboard-light-reconstruction, director-scene-analysis-depth
```
随后交 `catimation-image`(`generate_image`,带 `referenceImages`)出图。

## 边界

- 本技能是**路由器 + 输出规范**,具体技法细节在被路由的子技能里,需要时去读它们,别重抄。
- 不强加重问卷;明确需求就给默认值直接做。
- 详尽 13 维字段表见 `references/cinematography-framework.md`;完整维度→技能路由表见 `references/skill-routing-map.md`。
