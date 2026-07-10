---
name: seedance-video-craft
description: >-
  用 Seedance 2.0 满血版出片的深度实战 skill——由视频入口在**复杂 Seedance 任务**
  中加载:多模态参考配比(9图/3视频/3音频)、多镜叙事、视频编辑/延长、复杂动作、
  口播/广告片、高质量商业交付、爆款体检。基于字节 Seedance 2.0 技术报告
  (统一多模态音视频联合生成,4-15s,原生音频+口型,主体控制/运动操控/风格迁移/
  视频延长),给出全能参考配方、模型对齐提示词补充、爆款体检自评(改编自
  Higgsfield Virality Predictor)与广告/短视频模式分类。简单单镜生成不触发本技能。
---

<!-- skill-budget: standard -->

# Seedance Video Craft / Seedance 2.0 出片实战

把 **Seedance 2.0 满血版** 当成它论文里真实的样子来用,而不是当成一个「随便写句话
就出片」的黑盒。本 skill 是「模型对齐 + 复杂任务出片工艺 + 爆款体检」这一层的
**专业知识模块**:由上游视频入口在复杂 Seedance 任务中加载,**假定上游已完成
任务分级、方向确认与基础提示词工程**(sd2-pe 八大要素 / 路径 A·B / 兜底包)——
本 skill 不重跑路由,`references/prompt-engineering.md` 定位为「sd2-pe 之上的
Seedance 模型对齐补充」,不替代它。

**理论基础:** 字节跳动 Seedance 2.0 技术报告《Seedance 2.0: Advancing Video
Generation for World Complexity》(arXiv 2604.14148)+ Seed2.0 Model Card,2026‑02。
**写法借鉴:** Higgsfield AI 的 Marketing Studio 模式分类 与 Virality Predictor
(`brain_activity`)爆款打分维度。

**运镜/结构化描述先查知识库:** 落笔运镜 / 景别 / 分镜 / 结构化镜头描述字段前,
**先调 `search_cinematography_kb` 工具**查「运镜与结构化描述库」(阿里百炼 RAG:
权威运镜术语 + 结构化分镜描述范式),用库里真实术语与结构范式填运镜段——比泛联网
更准、更贴本项目产出格式;工具不可用 / 未配 key 时再退回下面的联网检索。

**主动联网检索 + 真实技法词:** 需要题材考据、运镜/作画/导演参考、真实人物/作品/
职员、最新模型能力或行业惯例时,**先主动上网搜索真实电影/摄影技法文档并实际打开
页面核实**,不要只凭记忆下断言。真人/摄影技法走 StudioBinder / American
Cinematographer(ASC)/ No Film School / ShotDeck / Wikipedia「Cinematic
techniques」;动画作画走权威源(Sakugabooru / Sakuga Blog / Sakuga Journal /
Animétudes / ANN / AniDB,详见 animation-craft 技能)。把查到的**实在技法词**
(焦段 mm、光圈 f值、景别、运镜、布光、色温 K、调色)填进提示词。

**正向提示词(默认):** 默认只写正向提示词,**不写反向/负向提示词**,把「不要 X」
改写成对应的「要 Y」(详见 `references/prompt-engineering.md` 法则 5)。

---

## 一、先记住模型的真实能力(不要假设)

Seedance 2.0 是**原生统一多模态音视频联合生成**模型,一次前向同时产出画面 +
双声道音频。关键参数(详见 `references/seedance-2.0-capabilities.md`):

| 维度 | 真实值 | 出片含义 |
|---|---|---|
| 时长 | **4–15 秒**(满血版直接出) | 别想一条出 1 分钟;长片靠多段拼 |
| 原生分辨率 | **480p / 720p**(默认 720p) | 1080p 不是原生,需上采;本 app 默认 720p |
| 输入模态 | 文本 / 图像 / 音频 / 视频(4 种) | 这就是「全能参考」的来源 |
| 参考上限 | **最多 9 图 + 3 视频 + 3 音频** | 全能参考的配额,要会分配 |
| 原生音频 | 单次前向出双声道立体声 + 口型 | 提示词要主动写声音,别只写画面 |
| 口型语言 | 8+(EN/ZH/JA/KO/ES/FR/DE/PT) | 口播/对白片可直接生成 |
| 编辑能力 | 主体控制 / 运动操控 / 风格迁移 / 视频延长 | 改片不必从零重生 |
| 快速版 | Seedance 2.0 Fast(低延迟,质量略降) | 只在用户明确要快/要省时用 |

**默认就用满血版 2.0**,不要因为「Fast 枚举更好读」就降级(这是论文与本 app 的
一致立场)。

---

## 二、出片前先选「生成模式」

| 模式 | 何时用 | 关键输入 |
|---|---|---|
| **全能参考(优先,默认)** | 多数任务:要角色/场景/风格/音色一致 | 文本 + 最多 9 图/3 视频/3 音频 |
| 文生视频 | 只有一句创意,无素材 | 纯文本 |
| 图生视频 | 有首帧/关键帧 | start_image(+可选 end_image)+ 运动描述 |
| 视频延长 | 已有片段要续 | 源视频 + 续写提示 |
| 编辑 | 改主体/运动/风格,不想重生 | 源视频 + 编辑指令 |

**默认走全能参考**,因为它最大化一致性。其余模式只在任务明显更简单或用户指定时用。
配方见 `references/all-around-reference.md`。

---

## 三、复杂任务出片流程(假定上游已定级、已确认规格)

1. **核对规格**(上游已确认的不重复问):分辨率(默认 720p)、时长(4–15s)、
   画幅(9:16/16:9/1:1)、是否要原生音频/口型。
2. **选模式**(见上表),默认全能参考。
3. **分配参考配额**(9 图/3 视频/3 音频)——见 `references/all-around-reference.md`。
4. **写提示词**——在上游 sd2-pe 工程化结果之上,按
   `references/prompt-engineering.md` 做 Seedance 模型对齐补充:单一主导动作、
   首帧霸权(图生视频不复述静态帧)、运动矢量语言、主动写声音、**默认只写正向
   提示词(不写反向)**、用真实技法词填充。**运镜/机位用词从
   `references/camera-motion-primitives.md` 挑精确电影术语**(pan≠truck、
   tilt≠pedestal、zoom≠dolly),别写「镜头动一下」。
5. **卡在哪个维度就借哪门工艺**(由上游按预算加载,plain-text 名称按需):
   运镜/构图 → director-cinematic-composition · storyboard-shot-emotion-matching;
   叙事/分镜 → director-narrative-flow · storyboard-scene-breakdown;
   角色一致性 → director-character-consistency · storyboard-multi-character-control;
   光影/调色 → storyboard-light-reconstruction · storyboard-color-grading-control;
   声音 → storyboard-audio · storyboard-voice-control;
   演技/动机 → storyboard-character-acting · storyboard-character-motivation;
   过审 → storyboard-dodge。先判断任务卡在哪 1–2 个维度,不要一次全开。
6. **生成前做爆款体检**——用 `references/virality-scorecard.md` 自评 hook(0–3s)、
   留存、payoff、分心风险;低于阈值先改提示词再生成。
7. **生成 → 自检 → 交付**:出片后按上游入口的**分级 QA**执行(视觉 QA 用
   `ffmpeg-win` 抽 3×3 九宫格 + view_image 那张宫格;内容 QA 用
   `catimation-understand` 的 understand_video;触发了两级就两面一起看)。
   不合格带针对性改进点重生成(次数上限由上游把守)。通过后给结果 + 一行摘要
   (模式、时长、分辨率)。多段片用 `ffmpeg-win` 拼接;**跨段续接抽上段尾帧/
   关键帧作下段 firstFrame,而不是把整段 Seedance MP4 当视频参考回喂**——按剧情
   裁剪/拼接出的宫格图、故事板也是优质可复用素材(回喂 referenceImages)。

---

## 四、爆款体检(生成前自评)

改编自 Higgsfield Virality Predictor 的注意力维度(`brain_activity`:Overall /
Peak hook 秒 / Sustain% / 最强最弱脑区 / Default Mode 分心)。在**生成前**对你的
提示词/分镜做一次结构化自评——把「会不会爆」前移到提示词阶段。详见
`references/virality-scorecard.md`。

核心 6 问:
1. **Hook(0–3s):** 第一秒画面有没有反常/冲突/信息钩子?
2. **单一主导:** 这 4–15s 有没有一个清晰的核心动作,而不是动作稀释?
3. **留存:** 中段有没有「为什么要看下去」的悬念或递进?
4. **Payoff:** 结尾有没有兑现 hook 埋的承诺?
5. **分心风险:** 有没有抢戏的杂乱背景/冲突运镜(对应 Default Mode 偏高)?
6. **声画协同:** 原生音频是否强化关键节拍(而不是默认静音)?

---

## 五、广告 / 短视频模式(改编自 Marketing Studio)

做广告/带货/口播片时,先选一个结构模板(完整对照见
`references/ad-short-form-modes.md`):

| 模式 | 适合 |
|---|---|
| UGC(默认) | 真人手机感、口播、安利 |
| Unboxing 开箱 | 「刚到货」拆箱揭晓 |
| How-to 教程 | 「这样用」演示 |
| Product Showcase | 干净产品高光,少出镜 |
| Product Review | 出镜给观点测评 |
| TV Spot | 高制作广播级广告 |
| Virtual Try-On | 试穿试戴 |

口播/带货优先竖屏 9:16、720p、开原生音频。

---

## 参考文件(按需加载)

- `references/seedance-2.0-capabilities.md` — 论文事实 + 完整参数/限制表
- `references/all-around-reference.md` — 全能参考配方:9 图/3 视频/3 音频怎么分配
- `references/prompt-engineering.md` — Seedance 2.0 提示词工程
- `references/virality-scorecard.md` — 爆款体检自评表(改编 Virality Predictor)
- `references/ad-short-form-modes.md` — 广告/短视频模式分类(改编 Marketing Studio)
- `references/time-allocation-and-multimodal.md` — 按内容密度切时长(字/秒)+
  `@素材`/`<图片N>` 多模态绑定(≤12 文件)+ 换人/运镜复刻/产品广告案例
  (移植自 updream jimeng-prompt-pro)
- `references/camera-motion-primitives.md` — **运镜基元词表(CameraBench-Pro 真实
  taxonomy,245 标签 / 17 技能类)**:平移/旋转/变焦/弧形/7种跟拍/机位角度/
  离地高度/景别/对焦/POV/速度时间等的**精确电影术语**,写运镜提示词时挑词用
  (数据来自官方公开 test 分片,本地 jsonl 已存)

---

## 致谢与边界

本 skill 的事实层来自字节 Seedance 2.0 技术报告(arXiv 2604.14148)与 Seed2.0
Model Card;爆款打分与广告模式的**写法**借鉴自 Higgsfield AI 开源 skills 仓库
(`higgsfield-ai/skills`)的 Virality Predictor 与 Marketing Studio,但本 skill
**不依赖 Higgsfield CLI**——它是模型无关的方法论,落到本 app 内置的 Seedance 2.0
视频工具上。具体 API/参数以本 app 实际调用为准,枚举值如有出入以运行时为准。

**角色定位:** 专业知识模块,不负责任务编排。上游 = 唯一视频入口或 film-studio;
下游 = 返回工艺建议与提示词补充,不主动加载任何调度器。跨插件技能加载不到就
就地应用其原则并继续,不阻塞不报错。
