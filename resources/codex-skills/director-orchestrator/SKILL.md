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

## STEP 0 —— 先反问(强制,不可跳过)

写任何提示词 / 调用任何生成工具**之前**,先对自己做这套反问(可在必要时用 `catimation-brainstorm` 的 `ask_user` 卡片摊给用户确认):

1. **「AI/Codex 有没有注意到这些?」** —— 这次任务涉及 13 维里的哪几维?(主体动作 / 景别焦段 / 机位角度 / 运镜 / 构图 / 景深对焦 / 光源照明 / 色温调色 / 环境时空 / 角色锚点 / 物理微表情 / 节奏时间线 / 风格质感)
2. **「要用到哪些本地 skill?」** —— 按 `references/skill-routing-map.md` 把涉及的维度映射到具体 `director-*` / `storyboard-*` 技能,**列出来再逐个加载**(读取其 SKILL.md / references)。宁可多列,不要漏。
3. **「素材齐了吗?」** —— 有没有参考图 / 角色 / 上一条生成结果要复用?(图像走 `referenceImages`,视频走全能参考)
4. **「目标模型是谁?」** —— 可灵 / 即梦 / Seedance(视频)或 gpt-image / Midjourney / FLUX / SD(图像),决定字段写法与是否需要负向字段。

把第 1、2 条的结论**简短说给用户听**(例:「这镜头我会用 director-cinematic-composition + storyboard-visual + director-lighting-continuity,按 13 维写」),再开始写。这一步就是本调度器的灵魂。

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

## 主动联网检索 + 真实技法词

不确定的技法 / 作家 / 镜头语言,**先联网检索权威资料再写**,不要只靠记忆。
- 真人/实拍:StudioBinder、ASC、No Film School、ShotDeck、Wikipedia "Cinematic techniques"。
- 动画作画:Sakugabooru、Sakuga Blog/Journal、Animétudes、ANN/AniDB。
- 用检索到的**真实技法词**(焦距/f值/景别/运镜/三点光/色温K/LUT/タメツメ/コマ打ち)填字段;商业作品仅作学习参考并标注出处,**不批量下载未授权商业素材**。

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
4. 出片后简短确认,不要 `view_image` 自检。

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
