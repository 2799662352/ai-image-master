---
name: catimation-video-director-router
description: 【生成前强制路由闸门 / Pre-Gen Director Router·每次出图出视频必先走】把用户的自然语言"症状"(太假 / AI味 / 塑料 / 像壁纸 / 没电影感 / 动作怪 / 打斗不真实 / 站桩 / 像NPC / 假笑 / 风格跑了 / 不像某电影 / 光很平 / 糖水 / 脸油 / 混脸 / 太满 / 太模板)映射到专业 director-* / storyboard-* 技能;并给每类任务(单图动起来 / 人物图生视频 / 电影感人物视频 / 武打武侠 / 参考风格 / 多镜连续片)一份最低 skill 套餐。MUST run BEFORE calling generate_image / generate_video —— 不得直接出图/出视频。先**亲自看素材**(图→view_image、视频→ffprobe+contact sheet+understand_video、剧本→读全文、音频→ffprobe),从素材事实里提取问题再选 skill(素材优先于文字);然后输出「导演路由表」(素材观察 / 文字触发 / 素材观察触发 / 任务类型 / 必载 skill / prompt 落地证据 / 生成后 QC),再交 director-orchestrator 写 13 维提示词。Use whenever generating or improving ANY image/video/animation, or when the user complains about realism, cinematics, motion, style, lighting, color, or characters, OR whenever the task leans on a real film/director/DP/brand/era/culture or asks for 像某电影 / 复刻 / 参考 / 高级 / 专业 / 电影级 (→ autonomous research grounding), OR whenever the direction is open / high-value / "更拟人化·更自然·更电影感·主动分析·给我选项·共创" (→ co-create the direction with catimation-brainstorm's ask_user card before generating). Triggers on 出图 / 出视频 / 生成 / 图生视频 / 动起来 / 太假 / 不像电影 / 动作怪 / 武侠 / 风格不对 / 像某电影 / 复刻 / 高级感 / 电影级 / 导演名 / 电影名 / 历史 / 品牌 / prompt / image / video.
---

# CATIMATION 视频/图像导演路由器(生成前强制闸门)

**本技能不生成任何东西。** 它是 `generate_image` / `generate_video` 之前的**强制路由层**:**先亲自看素材**(图/视频/剧本/音频),再把素材事实 + 用户文字("太假""不像电影""动作怪""站桩""风格跑了")翻译成该加载的专业技能,套上该任务类型的最低套餐,产出一张**导演路由表**作为执行证据,再把控制权交给 `director-orchestrator` 写 13 维提示词、交 `catimation-image` / `catimation-video` 出片。

> **铁律:不得直接调用 `generate_image` / `generate_video`。** 先看素材(STEP 0)→ 方向不明就先共创弹选项卡(STEP 0.5)→ 四层路由(STEP A)→ 输出路由表(STEP B)→ 再生成 → 生成后审片(STEP D)。跳过任一 = 失败。素材优先于文字:用户给了图/视频/剧本却没看就选 skill = 错;方向开放却自己猜 = 错。

为什么需要它:很多专业技能的触发词是导演/技术人员的话(前景遮挡 / 伪透视 / 特征塌陷 / 运动学反推),而用户说的是**症状**(太假 / 像壁纸 / 动作怪)。没有这层翻译,症状不会稳定命中技能,于是"武侠电影视频"被当成"普通图生视频"处理,漏掉活人感 / 前景遮挡 / 物理 / 调色。

---

## STEP 0 — 素材优先:先看素材,再路由(最根本的一步)

**路由入口不是"用户说了什么",是"用户给了什么素材 + 素材实际呈现了什么 + 要交付什么结果"。** 很多该触发的 skill,只有**亲眼看了图片 / 视频 / 剧本 / 音频之后**才会显现。所以:**在 STEP A 选 skill 之前,先理解素材。**

标准流程:
```
1. 读用户文字需求
2. 亲自看素材:图片→view_image;视频→ffprobe+抽 3×3 宫格+understand_video;剧本→读全文;音频→ffprobe
3. 从素材里提取「问题」和「机会」(不是把图直接塞进 referenceImages 就完事)
4. 按「素材事实」触发 skill(用户没点名的问题也要主动触发)
5. 输出路由表(STEP B,必须同时写「文字触发」和「素材观察触发」)
6. 写 prompt / 生成
7. 生成后反向审片(STEP D,再看一次素材结果)
```

**硬规则(M1–M6):**
```
M1 给了图片 → 先分析 主体/姿态/光影/纵深/色板/风格/可动性,再选 skill。
M2 给了视频 → 先 ffprobe + contact sheet + understand_video,再选 skill。
M3 给了剧本 → 先分析 结构/人物/台词/视觉节拍/片长,再选 skill。
M4 给了音频 → 先看 时长/节奏/角色/是否带偏风格,再决定是否当参考。
M5 路由表必须同时引用两类触发:① 文字触发 ② 素材观察触发。
M6 素材观察暴露了用户没点名的问题 → 主动触发对应 skill。
```

### 看图片 → 触发(M1)

先自问:人物像真人还是塑料?表情空不空?姿态是不是站桩?光源明不明确?有没有前/中/背景?画面是否太干净像壁纸?服装/时代/道具撑不撑得起目标风格?色调接近目标还是要重调?构图适合直接动还是要先补关键帧?人物适合武打还是要更克制?

```
人物空洞/站桩            → storyboard-live-character-realism + storyboard-character-acting + storyboard-character-motivation
画面太干净/无前景        → storyboard-foreground-occlusion
光源混乱/大平光/塑料高光 → storyboard-light-reconstruction + director-lighting-continuity
构图平/没纵深            → director-cinematic-composition + storyboard-pseudo-perspective
色彩不符合目标电影        → storyboard-color-grading-control + storyboard-style-extraction-logic
服装/道具不符合时代      → codex-research-grounded-prompting + director-anchor-extraction-quality
需要锁身份(反复出现的人)→ director-anchor-extraction-quality + director-character-consistency
```

### 看视频 → 触发(M2)

先 `ffprobe`(时长/帧率/比例/音轨)→ 抽 3×3(或更多)contact sheet → `understand_video`(动作/镜头/连续性)。判断运动结构(推/拉/摇/移/跟/手持/固定)、人物动作(重心/惯性/身体因果)、风格(调色/景深/光源/质感)、剪辑(是否多镜/节奏/是否分段复刻)。

```
参考动作/运镜        → storyboard-kinematic-reverse-engineering + director-shot-sequence-patterns
动作怪/要复刻运动    → storyboard-physics + storyboard-video-prompt-optimization
多镜/连续性          → director-narrative-flow + director-visual-continuity + ffmpeg-win
视频风格复刻          → storyboard-scene-breakdown + storyboard-style-extraction-logic + codex-research-grounded-prompting
视频人物演技          → storyboard-character-acting + storyboard-live-character-realism
```

### 看剧本 → 触发(M3)

先分析:谁是主角?每场价值变化?有没有因果链?哪些动作拍得出来?台词要逐字保留吗?哪些要视觉化而非解释?片长匹配吗?要不要分镜/角色卡/场景卡?

```
剧本/分场/台词  → screenwriter + storyboard-dialogue
分镜/镜头表      → create-storyboard 或 catimation-storyboard-pro + director-shot-sequence-patterns + director-narrative-flow
角色复用          → director-character-consistency + director-anchor-extraction-quality
成片/多镜        → film-studio + ffmpeg-win
```

### 看音频 → 触发(M4)

先看:时长适合参考吗?BPM 大概多少?是氛围/战斗/情绪/转场还是音色参考?要剪成 4–15s 吗?和视频节奏匹配吗?**会不会带偏风格**(如史诗战鼓会破坏《卧虎藏龙》的克制)?

```
storyboard-audio + storyboard-voice-control + ffmpeg-win + sd2-pe
```

---

## STEP 0.5 — 共创定向:开放式质量需求先弹选项卡(别自己猜方向)

从"执行型生成器"切到"**共创型导演**":方向不明 / 开放式质量改进时,**先主动分析素材,再用 `catimation-brainstorm` 的 `ask_user` 弹一张可点击选项卡让用户选方向**,选完再锁 skill。不是替用户拍板,也不是甩一堆空问题。

**什么时候进共创(C1 触发):**
- 用户说「更拟人化 / 更自然 / 更电影感 / 更像某风格 / 更高级」等**开放形容**;
- 用户说「主动分析 / 主动提问 / 给我选项 / 问清楚方向 / 共创 / 头脑风暴」;
- 用户给了图/视频/剧本/BGM 但**没完全指定最终风格**;
- **高成本**任务(生成视频 / 多镜 / 成片 / 角色一致性);
- 用户对结果不满但**问题是开放的**(「还不够对 / 感觉不行 / 不像」)。
- **跳过**:明确简单请求(「把这张图做成 5 秒视频」「生成一只猫」)——弹窗只会烦人,选合理默认直接走。

**共创硬规则(C1–C5):**
```
C1 用户要「更拟人化/更自然/更电影感/更像某风格/主动分析/给选项/共创」→ 生成前先触发 catimation-brainstorm。
C2 弹卡前先看真实素材,选项要从"观察到的问题"长出来,不是通用套话。
C3 一次只问一个聚焦问题,给具体选项;不要一次甩五个开放问题。
C4 用户选完 → 加载对应 director/storyboard skill,并说明每个 skill 会怎么改 prompt。
C5 生成后 → 核对所选方向是否真的落地(没落地就针对性重生成)。
```

**问法:别问空的(C2/C3)。** 不要问「你想怎么改?」;要问「你想让『拟人化』主要体现在哪?」并给从素材缺口长出来的选项。示例(用 `ask_user`,single/multi + 推荐项置顶):

| 选项 | 含义 | 命中 skill |
|---|---|---|
| ①眼神微表情(推荐) | 先观察/迟疑/收呼吸,减 NPC 感 | `storyboard-character-acting` + `storyboard-live-character-realism` |
| ②行为动机 | 动作由画外剑风/脚步/环境触发,不站桩挥剑 | `storyboard-character-motivation` |
| ③身体物理 | 重心/袖口/发丝/衣摆/脚步摩擦与惯性 | `storyboard-physics` + `storyboard-live-character-realism` |
| ④环境互动 | 前景遮挡/雾/风/浮尘/光束,人物不像贴背景 | `storyboard-foreground-occlusion` + `director-cinematic-composition` |
| ⑤克制武侠演技 | 少表情少大动作,靠细节出张力(《卧虎藏龙》) | `storyboard-character-acting` + `storyboard-color-grading-control` |

选完按组合加载,例:选 ①+④ → `character-acting + live-character-realism + foreground-occlusion + director-cinematic-composition + storyboard-video-prompt-optimization`;选 ②+③ → `character-motivation + physics + live-character-realism + storyboard-video-prompt-optimization`。

**共创这一步至少会用到:** `catimation-brainstorm` + `director-orchestrator` + `director-scene-analysis-depth` + `sd2-pe` + `storyboard-video-prompt-optimization`;目标含"电影感/藏龙卧虎"再叠 `codex-research-grounded-prompting` 等(见 STEP A④)。选定方向后照常走 STEP A→B→生成→D。

---

## STEP A — 四层路由(必做)

路由不是一层关键词,是四层叠加:**① 显式关键词**(用户直接说"前景遮挡/活人感/调色/物理/过审"→ 当然触发)· **② 症状词**(下表)· **③ 任务类型最低套餐** · **④ 自主研究 grounding**(下方)。原则一句话:**专业 skill 不只由用户关键词触发,也由「任务隐含的质量风险」触发。**

### ① 症状路由(用户没点名 skill,但描述暴露了问题 → 自动加载)

| 用户说的(自然语言症状) | 自动加载 |
|---|---|
| 太假 / AI味 / 塑料 / 油 / 空洞 / 没灵魂 / 像模特 | `storyboard-live-character-realism`、`storyboard-character-acting` |
| 摆拍 / 站桩 / 像NPC / 没事做 / 没表演 | `storyboard-character-motivation`、`storyboard-character-acting`、`storyboard-live-character-realism` |
| 太干净 / 像壁纸 / 没电影感 / 没纵深 / 太平 | `storyboard-foreground-occlusion`、`storyboard-pseudo-perspective`、`director-cinematic-composition` |
| 动作怪 / 武打不对 / 打击感差 / 身体乱 / 飘 | `storyboard-physics`、`storyboard-kinematic-reverse-engineering`、`storyboard-video-prompt-optimization` |
| 风格不像 / 不像某电影 / 太艳 / 太网红 / 调性不对 | `storyboard-style-extraction-logic`、`storyboard-color-grading-control`、`director-style-consistency` |
| 光不对 / 廉价 / 大平光 / 糖水 / 脸油 / 塑料高光 | `storyboard-light-reconstruction`、`director-lighting-continuity` |
| 多角色乱 / 混脸 / 两个人互相污染 | `storyboard-multi-character-control`、`director-character-consistency` |
| 情绪不高级 / 假哭 / 太直白 / 用力过猛 | `storyboard-emotional-montage`、`storyboard-character-acting` |
| 画面太满 / 背景抢 / 主体不突出 | `storyboard-feature-collapse`、`director-cinematic-composition` |
| 太模板 / 太稳 / 太完美 / 不够松弛 | `storyboard-robustness-breaking` |
| 画面像死的 / 没生活感 / 没故事 | `storyboard-time-words`、`storyboard-structure` |
| 脑洞 / 更有创意 / 别普通 / 奇观 / 魔幻 | `storyboard-creative-imagination` |

### ② 类型路由 — 最低 skill 套餐(判定任务类型,从上往下叠加,只增不减)

低层是高层的子集。武打片要把 单图 / 人物 / 电影感 三层全含上。

**单图动起来(纯物体/风景,无人表演):**
```
director-orchestrator + sd2-pe + storyboard-video-prompt-optimization
```
**人物图生视频(画面里有人要动/演):** + 
```
storyboard-live-character-realism + storyboard-character-acting + storyboard-character-motivation
```
**电影感人物视频(要"电影感/质感/高级"):** + 
```
director-cinematic-composition + storyboard-foreground-occlusion + director-lighting-continuity + storyboard-light-reconstruction + storyboard-color-grading-control
```
**武打 / 武侠视频:** + 
```
storyboard-physics + storyboard-shot-emotion-matching + director-shot-sequence-patterns + storyboard-audio + storyboard-time-words
```
**参考电影风格 / 复刻爆款:**
```
storyboard-style-extraction-logic + storyboard-color-grading-control + director-style-consistency + codex-research-grounded-prompting + director-scene-analysis-depth
```
**多镜连续短片 / 成片(>15s 或多镜):** + 
```
film-studio + screenwriter + (create-storyboard 或 catimation-storyboard-pro) + director-character-consistency + director-visual-continuity + storyboard-multi-character-control + ffmpeg-win + catimation-understand
```

> **跨插件优雅降级(重要):** 上面「必载」的 `storyboard-*` / `sd2-pe` / `film-studio` / `screenwriter` / `create-storyboard` / `ffmpeg-win` / `catimation-understand` 分属**兄弟插件**(catimation-storyboard / -video / -film / -storyboard-pro / -core)。Codex 插件规范**没有插件间依赖字段**,所以按最佳实践处理:**能用 Skill 工具加载到就加载;加载不到(用户没装该兄弟插件)就就地应用其原则并继续,绝不因缺某个 skill 而阻塞或报错。** 想要完整威力,请安装全套 6 个 catimation 插件。

### ③ 生成前逐问(一条 yes 就把对应套餐并进来)

```
有人物?          → live-realism / character-acting / character-motivation
要电影感?        → composition / foreground-occlusion / lighting / light-reconstruction / color-grading
有动作/武打?     → physics / shot-emotion-matching / video-prompt-optimization
多角色?          → multi-character-control / character-consistency
参考风格/参考图? → style-extraction / color-grading / scene-analysis-depth / anchor-extraction-quality
多镜/成片?       → film-studio / visual-continuity / narrative-flow / ffmpeg-win
有声音/台词?     → storyboard-audio / storyboard-voice-control / storyboard-dialogue
```

### ④ 自主研究 grounding(`codex-research-grounded-prompting` 不是"高风险补丁",是"别凭记忆创作")

**先问自己一句(不管用户有没有说"查资料"):**
> 这个任务里有没有任何**专有名词、风格目标、文化/历史语境、作品参考、行业标准,或"想像某个真实东西"**的要求?凭记忆写,会不会变成泛泛而谈?

只要答案是"有",就**在写任何 prompt 之前**先触发 `codex-research-grounded-prompting` 做一轮查证与选锚,再把锚点交给下游工艺 skill。硬规则:

```
R1  用户提到真实的电影/导演/摄影/美术/作曲/动画师/品牌/历史时代/文化风格/命名类型
    → 写 prompt 前 MUST 先触发 codex-research-grounded-prompting。
R2  用户说「像 / 风格 / 不像 / 复刻 / 参考 / 高级 / 专业 / 电影感」
    → 推断"外部依据能提升结果",主动查权威参考(除非用户明说别联网)。
R3  研究产出必须给出:主创锚点 / 视觉语法 / 色板 / 镜头·镜片·光线逻辑 /
    运动·剪辑节奏 / (相关时)声音·音乐参考。
R4  研究出的锚点必须交给具体工艺 skill 落地 —— 光有研究不是 prompt。
```

**什么时候自主触发(用户没点名"查资料"也要触发):**

| 需求类型 | 为什么 |
|---|---|
| 指定电影(《卧虎藏龙》《银翼杀手》《花样年华》) | 查主创/摄影/美术/调色/动作,不能靠印象 |
| 指定导演/摄影/美术/作曲 | 核实作品、风格特征、技法语汇 |
| 指定历史时代/服装/建筑/武器 | 权威参考,避免错代乱搭 |
| 指定品牌/产品/IP 气质 | 查视觉规范、品牌调性 |
| 指定地域文化(宋代/唐风/江南园林/藏地/赛博东京) | 查真实形制、配色、材料、空间 |
| "像某作品 / 不像 / 风格不对" | 风格复刻,必须查证参考源 |
| 高价值视频/短片/宣传片/商业片 | 成本高,不能泛泛提示词 |
| 系列一致性/角色世界观/美术圣经 | 先建可验证的风格锚点 |
| 给了参考图但没说清风格 | 主动反推并查同类权威参考 |
| "专业/导演级/电影级/爆款/高级感" | 必须落到真实技法与参考体系 |

**只命名了作品、没命名主创**(如"要《卧虎藏龙》的感觉")→ 走 `codex-research-grounded-prompting` 的 `title-driven-shortlisting`:把作品译成 3–5 个主创候选,让用户选锚,再继续。

**研究 → 下游工艺(把锚点交出去):**
```
电影/实拍风格 → director-cinematic-composition + director-lighting-continuity + storyboard-color-grading-control + storyboard-style-extraction-logic
动画/作画风格 → animation-craft + director-anime-quality-boost + storyboard-physics
人物/角色复用 → director-anchor-extraction-quality + director-character-consistency
多镜/成片     → film-studio + director-narrative-flow + director-visual-continuity
```

> 别再"看到《卧虎藏龙》就直接写低饱和/竹林/轻功"——那是凭印象。先查(李安/摄影鲍德熹/美术叶锦添/动作袁和平/音乐谭盾 + 低饱和·竹林纵深·留白·写意轻身法·青灰竹绿墨色·软光雾气空气透视),再把这些交给上面的工艺 skill 落地。

---

## STEP B — 输出「导演路由表」(强制,这是执行证据,不是自觉)

调 `generate_image` / `generate_video` **之前**,先产出这张表(武侠/电影感/人物片直接给用户看):

```text
用户意图:
素材观察(M1–M4):   <亲自看过素材后的事实:主体/姿态/光影/纵深/色板/风格/可动性;视频加运动·剪辑;剧本加结构·台词;音频加节奏·是否带偏>
素材类型:            <纯文 / 参考图 / 参考视频 / 音频>
输出类型:            <图 / 视频 / 多镜>
任务类型:            <单图 / 人物 / 电影感 / 武打 / 参考风格 / 多镜>
文字触发:            <STEP A①② 命中的关键词/自然语言症状>
素材观察触发(M5/M6):<从"素材事实"推出的触发,逐条写清:如"图里人物正面静站、缺行为动机 → character-motivation";"背景层次弱、易像壁纸 → foreground-occlusion";"光偏平易塑料 → light-reconstruction">
自主研究触发:        <是/否 + 原因(命中 R1/R2 哪条:真实电影/导演/历史/品牌/文化/"像·复刻·高级")>
权威参考目标:        <触发时填:主创锚点 / 视觉语法 / 色板 / 镜头·光线逻辑 / 节奏 / 声音参考(来自 codex-research-grounded-prompting)>
必载 skill:          <文字触发 + 素材观察触发 + 类型套餐 + 研究下游,去重>
可选 skill:          <再加分的>
不加载的原因:        <逐个明确写清为何不需要;写不出理由 = 不该省>
prompt 落地字段:     <STEP C 每个技能将落到 prompt 的具体字段>
生成后 QC 项:        <STEP D 清单>
```

**M5 铁律:路由表必须同时写「文字触发」和「素材观察触发」两栏。** 只写"用户说了武打 → physics"不够,还要写"图里人物正面静站、缺前景层、光偏平 → character-motivation + foreground-occlusion + light-reconstruction"。**先表、后生成。** 若这是武侠电影视频而表里没有 活人感 / 前景遮挡 / 物理 / 调色 —— 明显漏了,回头补。

---

## STEP C — prompt 落地证据(加载 ≠ 起作用;必须在 prompt 里看得到)

**光说"用了 X 技能"不算数。** 最终 prompt 里要能看到每个技能的具体贡献字段:

| 技能 | prompt 里必须出现的落地证据 |
|---|---|
| live-character-realism | 眼神走向、呼吸起伏、手指压力、下颌绷紧、重心、衣料惯性、哑光皮肤(无油亮塑料高光) |
| foreground-occlusion | 左/右前景遮挡物 + 占画面比例、横移视差、薄雾/浮尘/柔光路 |
| physics | 力从哪来、身体如何卸力、袖口/发丝如何延迟摆动、靴底擦地/侧滑半步 |
| color-grading-control | HEX 主/辅色、色温 K、光比、饱和度、暗部偏色 |
| character-acting | 情绪从起始到收住的微表情序列(不是"表情自然"四个字) |
| storyboard-audio | A1 配乐 / A2 音效 / A3 人声或台词 三层 |

生成前对着"必载 skill"逐个问:**它的证据在 prompt 里吗?** 没有就补写,别急着调工具。

---

## STEP D — 生成后强制反向审片(不得直接宣布完成)

视频/图像出片后**必须**审,不合格给修正版 prompt 或重生一版:

```
ffmpeg-win:      ffprobe 摸时长码流 → 抽 3×3 九宫格 contact sheet → view_image 看那张宫格
catimation-understand: understand_video 看整段
```
反向审片 = **再看一次素材结果**(不是只说"已生成");逐条对着"必载 skill"的落地证据 + STEP 0 的素材观察核:
- 人物是否像真人(眼神/呼吸/手指/重心微反应),还是塑料/站桩/NPC?
- 有没有前景遮挡 / 纵深,还是像壁纸?
- 动作有没有因果(动机),还是无由乱动?
- **是否保持了参考图/前一镜的身份**(脸/服装/记号,没变脸)?
- 风格是否跑偏(要低饱和《卧虎藏龙》就别艳丽)?符合 STEP 0④ 查到的权威视觉语言吗?
- 有没有混脸 / 穿帮 / 武器变形 / 多余人物 / 首帧被改 / 冒出法术爆炸?

任一不达标 → **不能说完成**,带**针对性**改进点重生成(不是泛泛"优化一下",而是"补 X skill 的 Y 字段")。

---

## 交接

路由表 + 落地证据齐了 → 交 `director-orchestrator` 按 13 维摄制框架写结构化提示词(物理可复现参数优先),再交 `catimation-image`(`generate_image`)/ `catimation-video`(`generate_video`)出片。视频提示词底座始终是 `sd2-pe`。素材一律按序号 图片1 / 视频1 / 音频1 引用。

**一句话:先路由、后落地、再审片。这是流程约束,不是模型自觉。**
