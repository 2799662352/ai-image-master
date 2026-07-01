# 维度 / 意图 → 本地技能 路由表

STEP 0 第 2 问用这张表:把任务涉及的维度/意图映射到具体技能,**列出来再逐个加载**(读其 SKILL.md / references)。宁可多列,不要漏。能 1% 用上就加载。

## 按 13 维路由

| 维度 | 首选技能 | 备选/配合 |
|------|----------|-----------|
| 1 主体·动作 | storyboard-structure | storyboard-character-motivation |
| 2 景别·焦段 | storyboard-shot-emotion-matching | director-cinematic-composition |
| 3 机位·角度 | director-cinematic-composition | storyboard-director-thinking |
| 4 运镜 | storyboard-kinematic-reverse-engineering | storyboard-video-prompt-optimization |
| 5 构图 | director-cinematic-composition | storyboard-foreground-occlusion, storyboard-pseudo-perspective, storyboard-visual |
| 6 景深·对焦 | storyboard-feature-collapse | storyboard-visual |
| 7 光源·照明 | storyboard-light-reconstruction | director-lighting-continuity, storyboard-visual |
| 8 色温·调色 | storyboard-color-grading-control | director-visual-continuity |
| 9 环境·时空 | director-scene-analysis-depth | storyboard-scene-breakdown |
| 10 角色锚点·一致性 | director-anchor-extraction-quality | director-character-consistency, storyboard-multi-character-control |
| 11 物理·微表情 | storyboard-physics | storyboard-live-character-realism, storyboard-character-acting |
| 12 节奏·时间线 | director-narrative-flow | director-shot-sequence-patterns, storyboard-time-words, storyboard-emotional-montage |
| 13 风格·质感 | director-style-consistency | storyboard-style, storyboard-style-extraction-logic, director-anime-quality-boost, storyboard-robustness-breaking |

## 按任务意图路由

| 用户/你要做的事 | 加载 |
|------------------|------|
| 写/优化单条提示词的字段结构 | director-prompt-engineering(7 字段);本调度器默认转正向 |
| 给参考图做结构化描述/打标 | director-structured-captioning, director-scene-analysis-depth |
| 反推一张爆款图/截图 | storyboard-scene-breakdown, storyboard-style-extraction-logic |
| 反推参考视频的运动 | storyboard-kinematic-reverse-engineering |
| 多镜头连续性(色/光/尺度/轴线) | director-visual-continuity, director-lighting-continuity, director-narrative-flow |
| 对白逐字保留 | storyboard-dialogue |
| 三层音频(配乐/音效/配音) | storyboard-audio, storyboard-voice-control |
| 多角色动作互不污染 | storyboard-multi-character-control |
| 人物太"AI"/僵硬/摆拍 | storyboard-live-character-realism, storyboard-character-acting, storyboard-character-motivation, storyboard-robustness-breaking |
| 画面太平/没纵深 | storyboard-foreground-occlusion, storyboard-pseudo-perspective |
| 调色/胶片感/HEX 色卡 | storyboard-color-grading-control |
| 重新打光/光影混乱 | storyboard-light-reconstruction |
| 情绪表达(蒙太奇/时间词) | storyboard-emotional-montage, storyboard-time-words |
| 创意/打破物理 | storyboard-creative-imagination |
| 动画厚涂漂移→赛璐珞 | director-anime-quality-boost |
| 视频提示词太长/动作稀释 | storyboard-video-prompt-optimization |
| 内容易触审查 | storyboard-dodge(正向轮廓/物理量改写) |
| 导演整体思维/场面调度 | storyboard-director-thinking |
| 端到端成片编排(剧本→分镜→出片→剪辑) | film-studio |
| Seedance 2.0 视频技法 | seedance-video-craft |
| 日式动画作画原理/技法参考 | animation-craft |

## 按症状 / 抱怨路由(不必等用户点名 skill —— 任务暴露了问题就触发)

用户很少直接说「用 storyboard-foreground-occlusion」。他们说的是**症状**。听到下面这些词/意图,就**自动**加载对应技能(意图识别 > 关键词匹配):

| 用户说的(症状 / 意图) | 自动加载 |
|---|---|
| 「不像电影 / 太 AI / 太假 / 没质感 / 塑料感」 | `storyboard-live-character-realism`、`storyboard-foreground-occlusion`、`storyboard-light-reconstruction`、`storyboard-color-grading-control` |
| 「武打 / 打斗 / 动作 / 运镜 / 武侠 / 藏龙卧虎」 | `storyboard-physics`、`storyboard-shot-emotion-matching`、`director-shot-sequence-patterns`、`storyboard-video-prompt-optimization` |
| 「人物不自然 / 像 NPC / 站桩 / 摆拍 / 没表演」 | `storyboard-character-acting`、`storyboard-character-motivation`、`storyboard-live-character-realism` |
| 「电影感 / 画面单薄 / 像壁纸 / 没纵深」 | `director-cinematic-composition`、`storyboard-foreground-occlusion`、`storyboard-pseudo-perspective` |
| 「风格不对 / 不像某部电影 / 调性不对」 | `storyboard-style-extraction-logic`、`storyboard-color-grading-control`、`director-style-consistency` |
| 「光很平 / 塑料光 / 打光不对」 | `storyboard-light-reconstruction`、`director-lighting-continuity` |
| 「动作太多 / 太乱 / 首帧被改」 | `storyboard-video-prompt-optimization`(首帧霸权、只驱动运动、不动作过载) |

## 任务类型 → 最低 skill 套餐(分层叠加,只增不减)

判断任务属于哪一层,**从上往下叠加**加载。低层是高层的子集——武打片要把「单图 / 人物 / 电影感」三层的套餐都含上。

**① 单图动起来(纯物体/风景,无人表演)** — 最低套餐:
```
director-orchestrator + sd2-pe + storyboard-video-prompt-optimization
```

**② 人物图生视频(画面里有人要动/演)** — 在 ① 基础上加:
```
storyboard-live-character-realism + storyboard-character-acting + storyboard-character-motivation
```

**③ 电影感人物视频(要「电影感 / 质感 / 高级」)** — 在 ② 基础上加:
```
director-cinematic-composition + storyboard-foreground-occlusion + director-lighting-continuity + storyboard-color-grading-control
```

**④ 武打 / 武侠视频** — 在 ③ 基础上加:
```
storyboard-physics + storyboard-shot-emotion-matching + director-shot-sequence-patterns + storyboard-audio
```

**⑤ 多镜连续片 / 成片** — 在对应层基础上加:
```
film-studio + director-character-consistency + director-visual-continuity + storyboard-multi-character-control + ffmpeg-win
```

> 自检:若这是「武侠电影视频」,套餐里却没有 活人感 / 前景遮挡 / 物理 / 调色 —— 就是明显漏了,回头补。

## 正向 vs 负向(注意)

- `director-prompt-engineering`、`storyboard-negative-control`、`storyboard-dodge` 原文含负向段。
- 本调度器**默认正向**:能把负向转成正向就转(「不要模糊」→「主体锐利对焦 + 背景散景」)。
- 仅当目标模型有独立负向字段且确需(SD/Midjourney `--no`)才保留负向。

## 出片衔接(非 craft 技能)

- 定方向/给选项:`catimation-brainstorm`(ask_user 卡片)。
- 出图:`catimation-image`(generate_image / generate_images)。
- 出视频:`catimation-video`(generate_video,默认全能参考)。
