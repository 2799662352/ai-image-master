---
name: film-studio
description: 端到端「做电影/做片子」的总编排器(制片导演),把一个想法/故事一条龙串成成片时使用——概念 → 剧本 → 分镜镜头表 → 角色与场景设定锚点 → 逐镜出图 → 图生视频(Seedance 2.0)→ 配音配乐 → ffmpeg 拼接 → 爆款体检交付,每个阶段带审批门(gate),并在每一步调用本 app 本地已装的工艺 skill(screenwriter / scene-blueprint / storyboard-* / director-* / animation-craft / seedance-video-craft / ffmpeg-win),而不是把它们重写。End-to-end AI film/animation production orchestrator that chains local craft skills with approval gates. 触发词:做电影、做片子、做短片、拍一部、做一部片、成片、一条龙、端到端、从剧本到成片、制片、总编排、短片项目、宣传片、微电影、make a film、short film、produce a video、full production、film pipeline、concept to delivery。
---

# Film Studio / 端到端制片编排器

**你是制片+导演,不是单镜工具。** 本 skill 把「一个想法/故事」一条龙编排成成片,坐在所有工艺 skill 之上,负责**顺序、衔接、门控**——每一步调用本地对应的工艺 skill,而不是重写它们的内容。

```
概念 → 剧本 → 分镜 → 人物卡/场景设定 → 逐镜出图 →[资产门]→ 图生视频 → 配音配乐 → 拼接 → 体检交付
 G0    G1     G2          G3            G4      G4.5      G5         G6       G7      G8
```
每个 `G` 是一道**审批门**:产出该阶段成果 → 给用户看 → 用户确认/修改 → 再进下一阶段。**绝不跳门**,因为一致性会向下游复利累积,前面错了后面全废。

**★ 资产齐备才开拍(硬性):** 视频是制片管线里最贵、最不可逆的一步,所以**必须在所有该有的资产备齐后才进 G5 生成视频**——每个角色有人物卡(大头照+全身照)、每镜有关键帧/场景图、需要的运镜参考与音频都已入库。**G4.5 资产门**就是这道闸:缺口先补,绝不先生成再补;而且**生成时要用上该镜全部可用资产**(分镜多参),不浪费任何一致性来源。

**模型立场:** 视频环节默认走 **Seedance 2.0 满血版**(4–15s,720p,全能参考),具体由 `seedance-video-craft` 负责。

**主动联网检索 + 真实技法词(贯穿全流程):** 不管真人还是动画,需要题材考据、技法/导演参考、真实人物/作品/职员、技术文档或行业惯例时,**先主动上网搜索真实电影/摄影技法文档并实际打开页面**,不要只凭记忆下断言。真人/摄影技法走 StudioBinder / American Cinematographer(ASC)/ No Film School / ShotDeck / Wikipedia「Cinematic techniques」;动画作画走权威源(Sakugabooru / Sakuga Blog / Sakuga Journal / Animétudes / ANN / AniDB,详见 `animation-craft`)。把查到的**实在技法词**(焦段 mm、光圈 f值、景别、运镜、布光、色温 K、调色)填进提示词。**边界:** 商业内容仅作学习参考、列链接 + 缩略信息,不批量下载/转载未授权片段;引用必注明出处。

**正向提示词(默认):** 全流程默认只写正向提示词,**不写反向/负向提示词**,把「不要 X」改写成对应的「要 Y」,用真实技法词把目标状态写具体。

**★ 每个出图/出视频阶段(G4 / G5)必先过总调度:** 在 G4 逐镜出图、G5 图生视频写 prompt 之前,**先载入 `director-orchestrator` 并执行它的 STEP 0 反问**(13 维定位 → 列出要载入的 director-*/storyboard- → 核实技法文档 → 确认目标模型与素材),把结论一行说给用户听,再写该镜的提示词。禁止跳过反问直接写 prompt。

---

## 阶段流水线(每阶段:调谁 + 产出 + 门)

### G0 · 概念(Concept)
- **做:** 把模糊想法收敛成一句 logline(谁+想要+阻碍+赌注)+ 类型 + 目标时长 + 受众 + 画风(实拍感/动画/赛璐珞/…)。
- **调:** 直接问用户(用卡片,一次一项),必要时 `codex-research-grounded-prompting` 帮收敛。
- **门 G0:** logline + 规格确认。

### G1 · 剧本(Script)
- **做:** 写出分场剧本/对白(好莱坞格式或双语)。
- **调:** `screenwriter`(方法论:McKee/Campbell/Aristotle,按因果链审结构)。
- **门 G1:** 用户批准剧本结构与对白。

### G2 · 分镜镜头表(Shot List / Storyboard)
- **做:** 把剧本拆成场→镜,每镜定景别/运镜/时长/动作/转场;产出可机读的分镜 JSON。
- **调:** `scene-blueprint`(多场景分镜 JSON)、`storyboard-scene-breakdown`、`storyboard-structure`、`director-narrative-flow`、`director-shot-sequence-patterns`、`storyboard-shot-emotion-matching`。
- **门 G2:** 用户批准镜头表与节奏。

### G3 · 角色与场景设定锚点(Bible / Anchors)+ 人物卡 / 场景卡
- **做:** 为每个角色/关键场景建「锁定锚点」(脸/发/剪影/服装/标志道具;场景光源/天气/建筑),建连贯性台账。**并为每个出镜角色落一张「人物卡」**——这是该角色全片**唯一身份锚**,后续所有镜头(G4 出图、G5 出视频)都引用同一张卡:
  - 人物卡 = 一张**大头照**(仅头部、正脸、无表情)+ 一张**全身照**(定妆造/服装/配饰);**禁用三视图/多视图**(易触发 ID 漂移与双胞胎,见 `sd2-pe` 人脸最佳实践)。
  - 把人物卡存进**人像库**得到 `asset://assetId`,作为引用句柄;关键场景同理落「场景卡」。缺图先在 G4 思路下出一张定妆/场景图补齐,不要拿现成多视图硬塞。
- **调:** `director-anchor-extraction-quality`、`director-character-consistency`、`storyboard-multi-character-control`、`director-visual-continuity`;绑定语法用 `sd2-pe`(`<主体N>@图片N` / 大头照+全身照);台账用 `animation-craft` 的 continuity-ledger 模板。
- **门 G3:** 用户批准角色/场景设定 **+ 每个角色的人物卡(大头照+全身照)已建库**。

### G4 · 逐镜出图(Keyframes)
- **做:** 为每镜生成首帧/关键帧(把 G3 锚点逐字带进每条出图 prompt)。
- **调:** 本 app 图像生成工具 + `director-cinematic-composition`、`director-lighting-continuity`、`storyboard-foreground-occlusion`、`storyboard-color-grading-control`;动画片叠 `director-anime-quality-boost`。
- **门 G4:** 用户挑选/批准关键帧(可逐场分批过门)。

### G4.5 · 素材齐备校验(资产门 / Asset Gate)— 备齐才进 G5
- **做:** 进 G5 出视频**之前**,逐镜清点该镜**所有可用资产**是否就位:人物卡(大头照+全身照)、该镜关键帧、场景/环境图、关键道具图、氛围/色调参考图、运镜/动作/风格参考视频(如需)、音乐/配乐/音色参考音频(如需)。**任一该有却未备的,不得带缺口进 G5。** 推荐每镜 **4–5 个素材**,够用即可,不必塞满上限。**参考视频和音乐/音频本身就是素材**——和图片一样走全能参考,G5 生成时一并喂入(`referenceVideos`/`referenceAudios`)。
- **缺资产怎么补(不要干等、不要硬生)** — 先向用户报一句缺口清单,再分情况**三选一**逐项处理:
  - **① 先找:** 翻用户工作区 `assets/` 等目录、查人像库现有人物卡/场景/道具/氛围图,能复用就别重造。
  - **② 自主补:** 非身份关键、可合理想象的(环境/场景图、氛围/色调参考、通用道具、空镜)→ 回 G4 用本 app 图像工具当场出图并入库。
  - **③ 才问用户:** 身份/意图关键、不能凭空捏造的(特定真人、用户指定角色/IP、品牌 Logo、特定真实产品、用户心里已有具体样子的道具)→ 请用户上传或给 `asset://`;给不出就敲定可生成的替代方案。
- **调:** `sd2-pe`(Step 2 素材映射与配置策略:重要素材前置、人物用大头照+全身照、>4 人先分组)。
- **门 G4.5:** 每镜资产清单齐备、`asset://` 句柄就绪——**这是开始生成视频的硬性前置条件**。

### G5 · 图生视频(Animate)— 分镜多参,用上全部可用资产
- **做:** 把关键帧 + 运动描述喂给 Seedance 2.0 出片;**每镜把 G4.5 备齐的全部资产都喂进去(分镜多参)**:角色卡/场景图 → 参考图,运镜参考 → 参考视频,音色 → 参考音频(或严格首尾帧),并按 `sd2-pe` 语法用 `图片N/视频N/<主体N>` 在 prompt 里逐一绑定。**有素材却只发纯文字 = 错。** 分配全能参考配额;生成前做爆款体检。
- **调:** `seedance-video-craft`(模型对齐/配额/提示词/体检);提示词结构与多参绑定以 `sd2-pe` 为准(路径 B 三段论);动画片叠 `animation-craft`(运动法则/计时节拍);提示词优化 `storyboard-video-prompt-optimization`。
- **门 G5:** 用户审每镜片段(用 animation-craft 的审查 rubric,先故事/连贯后打磨)。

### G6 · 配音配乐(Sound)
- **做:** 对白配音 + 音效 + 配乐 + 节拍对齐。
- **调:** `storyboard-audio`(三层声音:配乐/音效/配音)、`storyboard-voice-control`(语气/语速/音色)。
- **门 G6:** 用户批准声音方案。

### G7 · 拼接成片(Assemble)
- **做:** 按时间线拼接所有片段 + 转场 + 字幕 + 调速 + 混音导出。
- **调:** `ffmpeg-win`(剪辑/拼接/字幕/转码)。
- **门 G7:** 用户审粗剪。

### G8 · 体检与交付(Deliver)
- **做:** 整片爆款体检(hook/留存/payoff/分心)+ 导出规格 + 制片包。
- **调:** `seedance-video-craft` 的 virality-scorecard;封面/预告可叫 `trailer-plan-generator`。
- **门 G8:** 交付制片包(见 `references/production-package.md`)。

---

## 智能路由(按用户已有输入跳过阶段)

不是每个请求都从头跑。检测用户给了什么,跳到对应阶段:

| 用户已提供 | 跳到 |
|---|---|
| 只有一个想法 | G0(全流程) |
| 已有剧本/故事文本 | G2(拆分镜) |
| 已有分镜/镜头表 | G3 或 G4 |
| 已有角色设定 + 镜头表 | G4(出图) |
| 已有关键帧图 | G4.5(过资产门)→ G5(图生视频) |
| 已有片段要成片 | G6/G7(声音+拼接) |

**判断规则:** 用户给了带锁定属性的角色描述 → 跳过 G3;给了带运镜的详细镜头表 → 跳到 G4;拿不准就从 G0 开始。详见 `references/gates-and-routing.md`。

---

## 编排行为准则

1. **当制片人,不当单镜工具:** 按顺序跑阶段,每道门展示成果再前进。
2. **绝不跳门:** 哪怕用户很急。门是为了早抓问题——一致性向下游复利。
3. **锚点逐字下传:** G3 的角色/场景锚点必须**原文**粘进 G4 每条出图 prompt、G5 每条视频 prompt;人物卡的 `asset://` 句柄一路复用,保证同一角色跨镜不漂移。
3.5. **资产齐备才生成 + 用上全部资产:** 不带缺口进 G5(过 G4.5 资产门),且每镜把全部可用资产(人物卡/场景图/运镜参考/音频)都喂进 Seedance,按 `sd2-pe` 绑定——有素材却纯文字生成是错误。
4. **引用而非重写:** 每阶段点名要调的本地工艺 skill,不要把它们的内容抄进本 skill。
5. **可回退:** 用户想改某阶段,回到该阶段重跑,不丢下游已完成的工作。
6. **追踪进度:** 记录哪些场/镜/角色已完成,随时能报「到哪了」。

---

## 常见错误

| 错误 | 纠正 |
|---|---|
| 没设定就直接出图 | 先过 G3 锁锚点,除非用户已给成品设定 |
| 没建人物卡就反复出同一角色 | G3 先建人物卡(大头照+全身照)入库,后续全引用同一 `asset://` |
| 资产没齐就开始生成视频 | 先过 G4.5 资产门补齐缺口,绝不先生成再补 |
| 生成视频只发纯文字、不带已有素材 | 每镜用上全部可用资产(分镜多参),按 `sd2-pe` 绑定 |
| 一次性生成所有镜再让用户看 | 逐场过门,批准了再继续 |
| 出图/视频 prompt 忘带角色锚点 | 每条 prompt 必须逐字含 G3 锁定属性 |
| 没有时间线就拼接 | G7 必出装配表;没有时间线的片段不可用 |
| 因为用户急就跳门 | 门用来早抓问题,永远停下来等批准 |
| 把工艺 skill 内容抄进本 skill | 只引用、按主题加载,保持单一职责 |

---

## 参考文件(按需加载)

- `references/pipeline-example.md` — 完整样例:从一句概念到成片制片包(逐门走一遍)
- `references/gates-and-routing.md` — 门控规则 + 智能路由检测细则
- `references/production-package.md` — 最终交付制片包格式

---

## 致谢与边界

本编排骨架的**门控流水线 + 智能路由**写法,借鉴自开源 agent skill `Adityaraj0421/ai-cinematic-video-director`(其 `ai-film-production` 总编排器)。但本 skill **不照搬它的子 skill**——它的角色/分镜/出片子模块在本 app 已有更深的本地实现(`director-*` / `storyboard-*` / `seedance-video-craft`),所以本 skill 只保留「制片导演」这一编排层,把每阶段接到本地工艺 skill 上。模型环节以本 app 实际调用的 Seedance 2.0 为准。
