# 13 维电影摄制框架 —— 全字段与示例

**铁律:每个字段必须是相机可复现的物理量,不能是主观情绪词。** 情绪只能通过物理线索(光、影、微表情、运动)间接呈现。

---

## 1. 主体与动作 Subject · Action
- **谁/什么** + **单一核心动作**。一镜只给一个核心动作,定格在动作中段(张力峰值),不要「然后…接着…」。
- 写法:`[char1] 伸手去推门把,身体前倾`,而不是「她进了房间」。
- 关联:`storyboard-structure`(动作中段/单核心动作)、`storyboard-character-motivation`(动作有动机)。

## 2. 景别与焦段 Shot Size · Lens
- 景别:大远景 / 远景 / 全景 / 中景 / 近景 / 特写 / 大特写。
- 焦距:24mm(广角张力)/ 35mm(纪实)/ 50mm(自然)/ 85mm(人像压缩)/ 长焦压缩空间。
- 景别与焦段要逻辑自洽(远景+浅景深+长焦压缩别打架);关联 `storyboard-shot-emotion-matching`。

## 3. 机位与角度 Camera Position · Angle
- 高度:平视 / 仰角 / 俯角 / 顶视;水平角度(正面 / 偏侧 N° / 侧面 / 背面);**与主体距离 m**。
- 仰角 = 压迫/权威,俯角 = 渺小;由叙事意图决定。

## 4. 运镜 Camera Movement
- 类型:推 dolly-in / 拉 dolly-out / 横移 truck / 摇 pan / 俯仰 tilt / 升降 crane / 手持 handheld / 环绕 arc / 变焦 zoom。
- 必带:**速度**(慢/匀/快 + 大致倍率)+ **方向** + **起止画面**。
- 反推参考视频运动 → `storyboard-kinematic-reverse-engineering`;区分 dolly vs zoom(视差)。

## 5. 构图 Composition
- 三分法 / 中心构图 / 对称;**引导线**;**前景—中景—背景三层纵深**;**留白 / 视线空间(look-space)**。
- 前景遮挡建立 Z 轴与偷窥感 → `storyboard-foreground-occlusion`;伪透视加纵深 → `storyboard-pseudo-perspective`。
- 关联 `director-cinematic-composition`、`storyboard-visual`(强制 Z 轴 fg/mg/bg)。

## 6. 景深与对焦 DoF · Focus
- 光圈 f 值(f/1.4 极浅 … f/8 较深)；**对焦面**(对焦睫毛/前景/远景)；移焦 rack focus;散景质感。
- 主体塌缩/局部虚化营造情绪 → `storyboard-feature-collapse`。

## 7. 光源与照明 Lighting
- **主光方向**(左/右/顶/逆 + 角度°)、**软硬**(硬光锐影 / 柔光渐变)、**光比**(1:2 平 … 1:8 强反差)、轮廓光 rim / 补光 fill / 环境光 / 实用光 practical。
- 经典布光:三点光、伦勃朗、蝴蝶光、逆光。日景阴影占比 10–40%,夜景 60–90%。
- 去光再重打 → `storyboard-light-reconstruction`;跨镜一致 → `director-lighting-continuity`。

## 8. 色温与调色 Color · Grade
- 色温 K(暖 3000–4000K / 中性 5500K / 冷 6500K+);**主色 + 辅色 hex,比例 ≥7:3**,避免暖冷各半;对比;胶片/LUT。
- HEX 调色法、低饱和胶片感 → `storyboard-color-grading-control`;跨镜色彩/尺度一致 → `director-visual-continuity`。

## 9. 环境与时空 Environment · Time/Space
- 地点 + **时刻(由阴影角度/光色反推)** + 天气 + 大气(雾/尘/丁达尔)。一句话锁定 env。
- 从参考图抽 env/subjects/style → `director-scene-analysis-depth`;反推整图复刻 → `storyboard-scene-breakdown`。

## 10. 角色锚点与一致性 Anchors · Consistency
- 每个角色锚点必含 **脸 / 体型 / 服装 / 记号**,≥40 词,相似体型显式区分(「A 比 B 高约 10cm」),遮挡部位标 [inferred]。
- 跨镜用 [char1][char2] 标签锁定,发型/服装/道具不变,用相对肤色而非绝对色。
- 抽锚点 → `director-anchor-extraction-quality`;跨镜锁定 → `director-character-consistency`;多角色互不污染 → `storyboard-multi-character-control`。

## 11. 物理与微表情 Physics · Micro-expression
- 身体/动作只用物理语言:运动矢量(角°/位移 cm/速度 m·s⁻¹)、肌肉张力、骨架。
- 微表情用 mm:眉内拢 X mm、瞳孔 X mm、嘴角位移 X mm —— **不用情绪形容词**。
- 活人感/微反应 → `storyboard-live-character-realism`、`storyboard-character-acting`、`storyboard-physics`。

## 12. 节奏与时间线 Timing · Beats
- 单镜时长 s;节拍结构;视频按 0–Xs 分段描述起势/爆发/收尾(逐帧)。
- 镜头序列:先建立后细节,180° 轴线、视线匹配、动作连续、景别交替不连用 → `director-narrative-flow`、`director-shot-sequence-patterns`。
- 时间词制造势能/因果 → `storyboard-time-words`;情绪蒙太奇 → `storyboard-emotional-montage`。

## 13. 风格与质感 Style · Texture
- 介质统一:赛璐珞/厚涂/写实/胶片颗粒密度;**文字风格优先于参考图**(参考图只供角色身份,不定渲染介质)。
- 情绪靠物理线索(光影、微动作)呈现,不靠形容词堆叠。
- 风格一致 → `director-style-consistency`、`storyboard-style`、`storyboard-style-extraction-logic`;动画防厚涂 → `director-anime-quality-boost`;去 AI 味/可控失稳 → `storyboard-robustness-breaking`。

---

## 12 条硬规则(贯穿所有镜头)

1. 物理参数 > 情绪形容词:每个字段相机可复现。
2. 一镜一核心动作,定格动作中段。
3. 焦距/光圈/色温/角度尽量给具体数值或方向。
4. 强制 Z 轴:前景—中景—背景至少三层。
5. 主色辅色比例 ≥7:3,不暖冷各半。
6. 光源方向/软硬/光比明确,跨镜不反向。
7. 角色锚点 ≥40 词,跨镜用 [char] 标签锁定。
8. 微表情用 mm/角度,禁止「开心/悲伤/愤怒」。
9. 默认只写正向提示词;负向仅在模型确需时用。
10. 不确定的技法先联网查权威源,用真实技法词。
11. 多镜头显式标转场(cut to / dolly in / match cut / 时间跳跃)与连续性。
12. 输出结构化文本,绝不输出/要求 JSON。
