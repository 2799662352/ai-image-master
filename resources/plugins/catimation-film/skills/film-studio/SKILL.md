---
name: film-studio
description: 端到端「做电影/做片子」的总编排器(制片导演),把一个想法/故事一条龙串成成片时使用——概念 → 剧本 → 分镜镜头表 → 角色与场景设定锚点 → 逐镜出图 → 图生视频(Seedance 2.0)→ 配音配乐 → ffmpeg 拼接 → 爆款体检交付,每个阶段带审批门(gate),并在每一步调用本 app 本地已装的工艺 skill(screenwriter / scene-blueprint / storyboard-* / director-* / animation-craft / seedance-video-craft / ffmpeg-win),而不是把它们重写。End-to-end AI film/animation production orchestrator that chains local craft skills with approval gates. 触发词:做电影、做片子、做短片、拍一部、做一部片、成片、一条龙、端到端、从剧本到成片、制片、总编排、短片项目、宣传片、微电影、make a film、short film、produce a video、full production、film pipeline、concept to delivery。
---

# Film Studio / 端到端制片编排器

**你是制片+导演,不是单镜工具。** 本 skill 把「一个想法/故事」一条龙编排成成片,坐在所有工艺 skill 之上,负责**顺序、衔接、门控**——每一步调用本地对应的工艺 skill,而不是重写它们的内容。

```
概念 → 剧本 → 分镜 → 角色/场景设定 → 逐镜出图 → 图生视频 → 配音配乐 → 拼接 → 体检交付
 G0    G1     G2        G3            G4        G5         G6       G7      G8
```
每个 `G` 是一道**审批门**:产出该阶段成果 → 给用户看 → 用户确认/修改 → 再进下一阶段。**绝不跳门**,因为一致性会向下游复利累积,前面错了后面全废。

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

### G3 · 角色与场景设定锚点(Bible / Anchors)
- **做:** 为每个角色/关键场景建「锁定锚点」(脸/发/剪影/服装/标志道具;场景光源/天气/建筑),建连贯性台账。
- **调:** `director-anchor-extraction-quality`、`director-character-consistency`、`storyboard-multi-character-control`、`director-visual-continuity`;台账用 `animation-craft` 的 continuity-ledger 模板。
- **门 G3:** 用户批准角色/场景设定。

### G4 · 逐镜出图(Keyframes)
- **做:** 为每镜生成首帧/关键帧(把 G3 锚点逐字带进每条出图 prompt)。
- **调:** 本 app 图像生成工具 + `director-cinematic-composition`、`director-lighting-continuity`、`storyboard-foreground-occlusion`、`storyboard-color-grading-control`;动画片叠 `director-anime-quality-boost`。
- **门 G4:** 用户挑选/批准关键帧(可逐场分批过门)。

### G5 · 图生视频(Animate)
- **做:** 把关键帧 + 运动描述喂给 Seedance 2.0 出片;分配全能参考配额;生成前做爆款体检。
- **调:** `seedance-video-craft`(模型对齐/配额/提示词/体检);动画片叠 `animation-craft`(运动法则/计时节拍);提示词优化 `storyboard-video-prompt-optimization`。
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
| 已有关键帧图 | G5(图生视频) |
| 已有片段要成片 | G6/G7(声音+拼接) |

**判断规则:** 用户给了带锁定属性的角色描述 → 跳过 G3;给了带运镜的详细镜头表 → 跳到 G4;拿不准就从 G0 开始。详见 `references/gates-and-routing.md`。

---

## 编排行为准则

1. **当制片人,不当单镜工具:** 按顺序跑阶段,每道门展示成果再前进。
2. **绝不跳门:** 哪怕用户很急。门是为了早抓问题——一致性向下游复利。
3. **锚点逐字下传:** G3 的角色/场景锚点必须**原文**粘进 G4 每条出图 prompt、G5 每条视频 prompt。
4. **引用而非重写:** 每阶段点名要调的本地工艺 skill,不要把它们的内容抄进本 skill。
5. **可回退:** 用户想改某阶段,回到该阶段重跑,不丢下游已完成的工作。
6. **追踪进度:** 记录哪些场/镜/角色已完成,随时能报「到哪了」。

---

## 常见错误

| 错误 | 纠正 |
|---|---|
| 没设定就直接出图 | 先过 G3 锁锚点,除非用户已给成品设定 |
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
