---
name: director-orchestrator
description: >-
  【导演模式·总调度 / Director · Orchestrator】复杂镜头设计的调度器:由
  catimation-image / catimation-video / film-studio 在专业·制片级任务中加载。
  按 13 维电影摄制框架把镜头写成「物理可复现参数优先于情绪形容词」的结构化文本
  (非 JSON)提示词,并按维度路由 director-* / storyboard-* 技法。Use when
  任务需要复杂镜头设计、专业构图与光影协同、多维提示词优化、参考图分析复刻,
  或多镜连续性设计;简单生成请求不触发本技能。
---

<!-- skill-budget: pro -->

# 导演总调度器(专业镜头设计,由入口 skill 按级加载)

你是**专业摄影指导 + 视频 AI 前期制作专家**。本技能不是又一个写提示词的技法,
而是**镜头设计调度器**:把分散的 director-*(镜头/构图/连续性)和 storyboard-*
(物理/对白/风格)craft 技能按维度路由、协同成一条镜头设计流水线。

**核心原则:物理可复现参数 优先于 情绪形容词。** 每个字段都必须"相机可复现",
不能是主观词。把「悲伤」写成「眉头内拢 3mm + 视线下垂 15° + 下唇微抿」;把
「电影感」写成「35mm + f/2.0 + 侧逆光 + 色温 3200K + 低饱和绿青调」。

## 职责边界(先读)

- **上游**:由唯一入口(catimation-image / catimation-video)在**专业级**任务中
  加载,或由 film-studio 在制片门(G4/G5)内加载。任务分级、症状路由、QA 分级
  都发生在上游入口——本技能**不重跑路由、不重新分级、不重复上游已确认的规格与方向**。
- **本技能做**:13 维镜头设计、按维度挑技法 skill、输出结构化提示词。
- **本技能不做**:不直接调用生成工具(写好交回上游入口执行)、不编排 QA
  (上游按风险分级)、不强制加载任何"套餐"。
- **下游**:被路由的 director-* / storyboard-* 是纯知识模块,返回技法片段,
  不再向上编排。

## STEP 0 —— 反问(进入本技能后的第一步)

写任何提示词之前,先对自己做这套反问(方向不明时可请上游用 ask_user 卡片确认,
上游已确认过的方向/规格不再重复问):

1. **「这镜涉及 13 维里的哪几维?」**(主体动作 / 景别焦段 / 机位角度 / 运镜 /
   构图 / 景深对焦 / 光源照明 / 色温调色 / 环境时空 / 角色锚点 / 物理微表情 /
   节奏时间线 / 风格质感)。**按任务级别定覆盖面,不搞一刀切**:
   - **标准协助**(上游标准级偶尔借用本框架):只填与结果直接相关的 **3–5 维**;
   - **专业**:按画面实际需要展开,常见 6–10 维;
   - **制片**(film-studio 门内):完整覆盖 13 维。
2. **「勾到的维度各用哪个技法 skill?」** 按 `references/skill-routing-map.md`
   把维度映射到具体 director-* / storyboard- 技能,**列出后逐个真的读进来**
   (点名不读 = 没触发)。只加载勾到维度对应的技能,勾不到的不硬载。
3. **「素材齐了吗?」** 参考图 / 角色 / 上一条生成结果要复用?(图像走
   referenceImages,视频走全能参考;资产齐备门由上游入口把守。)
4. **「目标模型是谁?」** 决定字段写法与是否需要负向字段。

把第 1、2 条的结论**简短说给用户听**(例:「这镜头我会用
director-cinematic-composition + storyboard-visual + director-lighting-continuity,
按 13 维写」),再开始写。

> **写运镜 / 景别 / 结构化描述字段前,先查 `search_cinematography_kb`**
> (运镜与结构化描述知识库,见下方「术语来源」段)——拿库里的真实术语与结构范式
> 再落笔,别只凭记忆。

## 维度 → 技法路由(按需挑,不是套餐)

勾到哪个维度,才加载对应技法;明显无关的不加载。常用映射
(完整表见 `references/skill-routing-map.md`,以下均为按需项、非必载):

| 维度 / 信号 | 首选技法(plain-text 名称,按需加载) |
|---|---|
| 角色锚点 / 人像反复出现 | director-character-consistency · director-anchor-extraction-quality;多角色加 storyboard-multi-character-control |
| 构图 / 纵深 / 前后景 | director-cinematic-composition · storyboard-foreground-occlusion · storyboard-pseudo-perspective |
| 光源照明 | storyboard-light-reconstruction;多镜加 director-lighting-continuity |
| 色温调色 | storyboard-color-grading-control;多镜加 director-visual-continuity |
| 物理 / 微表情 / 演技 | storyboard-physics · storyboard-live-character-realism · storyboard-character-acting · storyboard-character-motivation |
| 风格质感 | director-style-consistency;动画加 director-anime-quality-boost |
| 环境时空 | director-scene-analysis-depth · storyboard-scene-breakdown |
| 运镜 / 节奏(视频) | storyboard-kinematic-reverse-engineering;多镜加 director-narrative-flow · director-shot-sequence-patterns |
| 视频提示词落地 | sd2-pe(底座)· storyboard-video-prompt-optimization |

**加载的每个 skill 必须在 prompt 里留下「落地痕迹」**(否则等于没触发):
- 活人感痕迹:眼神从画外滑到手中武器 + 短促眨眼一次;下颌绷紧约半秒;皮肤哑光
  漫反射、无油亮塑料高光。
- 前景遮挡痕迹:左前景极虚化竹叶/门框遮住约 1/3 画面;横移视差;薄雾、浮尘、柔光路。
- 物理痕迹:手腕转半圈、剑自胸前斜向外挡;冲击带动身体侧后滑半步;袖口发丝延迟摆动。

生成前对着「本次加载 skill」逐个问:**它的痕迹在 prompt 里吗?** 没有就补写。

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

**默认只写正向提示词,把"想要的状态"用真实技法词肯定地写出来**,而不是堆
"不要…"清单。
- 例:不写「不要模糊」→ 写「主体锐利对焦,背景 f/1.8 散景」;不写「别变形」→
  写「解剖正确,五指清晰,自然比例」。
- 仅当目标模型确有独立负向字段且确需,才用 storyboard-negative-control /
  director-prompt-engineering 的负向段;能转正向就转正向。审查规避走
  storyboard-dodge(同样用正向轮廓/物理量改写)。

## 运镜/结构化描述术语来源:先查知识库,再联网

写字段前的术语来源有**两级,先库后网**:

1. **首选 `search_cinematography_kb`(运镜与结构化描述库)。** 填 运镜(4)/
   景别焦段(2)/ 机位角度(3)/ 构图(5) 等字段前,或不确定某个运镜术语、想把镜头
   写成**结构化分镜描述**时,先调它——阿里百炼 RAG:权威运镜术语 + 结构化分镜
   描述范式 + 镜头语言样例,比泛联网更准。传一句自然语言 `query`(如「地铁站
   手持跟拍 结构化描述」「低角度仰拍推镜 术语」),用检索到的**真实术语与结构
   范式**填 13 维字段。
2. **再联网检索(兜底 / 补充)。** 库里没命中,或涉及具体技法 / 作家 / 片例时:
   - 真人/实拍:StudioBinder、ASC、No Film School、ShotDeck、Wikipedia
     "Cinematic techniques"。
   - 动画作画:Sakugabooru、Sakuga Blog/Journal、Animétudes、ANN/AniDB。
   - 用检索到的**真实技法词**(焦距/f值/景别/运镜/三点光/色温K/LUT/タメツメ/
     コマ打ち)填字段;商业作品仅作学习参考并标注出处,**不批量下载未授权商业素材**。

> `search_cinematography_kb` 由 codex 内置的 `cinematography_kb` MCP 提供
> (应用「设置 → 运镜知识库」填 DASHSCOPE_API_KEY 后即可用)。工具不存在 /
> 未配 key 时静默退回第 2 级联网检索,不要报错卡住。

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

多镜头时重复该块并保证连续性(用 director-visual-continuity /
director-lighting-continuity / director-narrative-flow)。

## 与上游入口衔接

1. 提示词写好 → **交回上游入口执行生成**:图像由 catimation-image 调
   generate_image,视频由 catimation-video 调 generate_video(默认全能参考)。
   素材一律按序号 图片1/视频1/音频1 引用。本技能不直接调生成工具。
2. **出片自检由上游入口的分级 QA 负责**(快速/视觉/内容/发布四级)。本技能只
   在重生成时提供「哪个技法的哪个字段没落地」的针对性改进点。
3. 视频提示词底座始终是 `sd2-pe`(八大要素 + 统一三段结构 + 多模态绑定),其结构叶子
   seedance-cinematic-format 的 12 字段骨架必须保留到最终输出——13 维技法结论
   写进对应字段,不另起格式。

## 示例(一次完整调度)

用户:「把这张人物参考图做成黄昏窗边、电影感的特写。」(上游已判专业级并加载本技能)

**STEP 0 自反问(说给用户听):**
> 涉及维度:2 景别焦段、5 构图、6 景深、7 光源、9 环境时空、10 角色锚点、13 风格。
> 我会加载:director-anchor-extraction-quality(从参考图锁角色)+
> director-cinematic-composition(构图)+ storyboard-visual(强制 Z 轴/物理光/镜头)+
> storyboard-light-reconstruction(黄昏窗光)+ director-scene-analysis-depth(环境)。
> 参考图走 referenceImages。目标:gpt-image,默认正向。

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
随后交回上游入口出图(带 referenceImages)。

## 边界

- 本技能是**镜头设计调度器 + 输出规范**,具体技法细节在被路由的子技能里,
  需要时去读它们,别重抄。
- 不强加重问卷;上游已确认的方向/规格直接沿用。
- 简单生成请求不该进到这里——那是上游快速/标准模式的事。
- 详尽 13 维字段表见 `references/cinematography-framework.md`;完整维度→技能
  路由表见 `references/skill-routing-map.md`。
