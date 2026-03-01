# AI 提示词工程方法论 - 精华提炼

> 来源：刺猬星球/Super-i 提示词创作系列课程（第23-34节）
> 提炼日期：2026-02-27

---

## 一、核心哲学

**做导演，不做抽卡者。** 用物理参数替代情绪形容词，用结构化指令替代祈祷式生成。

所有技巧贯穿的底层逻辑是 **控制变量**：
- 拆分资产 → 锁定视觉变量
- 拆分空间 → 锁定环境变量
- 拆分时间 → 锁定随机性变量

---

## 二、图像生成 - 五大核心维度

### 2.1 氛围感三底层控制（消除塑料感）

#### 明暗控制 — 物理打光

| 错误 | 正确 |
|------|------|
| `dark, sad, gloomy, depressing vibe` | 物理打光指令 |

AI 遇到情绪形容词只会全局降低亮度，导致画面发灰。**情绪的落点在光影交界处，不在整体变暗。**

**打光公式**：

```
[大面积暗部描述] + [单一/极少数明确光源] + [强对比术语]
```

参考词库：
- 暗部：`submerged in deep pitch-black shadows` / `surrounded by absolute darkness`
- 光源：`a single sharp spotlight` / `a dramatic rim light` / `a narrow beam of light`
- 对比：`High contrast` / `Chiaroscuro`

示例：
```
Cinematic portrait of a man sitting in a room.
80% of the image is submerged in heavy, deep pitch-black shadows.
A single, sharp dramatic spotlight shines from above,
illuminating only half of his face and the texture of his coat.
High contrast, chiaroscuro lighting, 8k.
```

#### 冷暖控制 — 色彩阶级

| 错误 | 正确 |
|------|------|
| 同时写 `warm sunlight, cool blue light`（色彩浑浊） | 建立主色+辅色的统治关系 |

**阶级控制公式**：

```
[The entire scene is dominated by + 主色调] +
[Only (极小区域) catch a subtle/faint + 辅色调]
```

参考词库：
- 主色调：`dominated by warm amber light` / `dominated by melancholic cool blue tone`
- 辅色区域：`Only the deepest shadows` / `Only the rim of the glass`
- 辅色：`a faint cool teal reflection` / `a subtle warm orange glow`

示例：
```
The entire scene is strictly dominated by a rich, warm golden hour palette.
Only the deepest shadows in the background contain a very subtle,
faint cool teal reflection.
Kodak Portra 400, cinematic color grading.
```

#### 虚实控制 — 焦段叙事

| 错误 | 正确 |
|------|------|
| `sharp focus on everything, 8k, ultra-detailed` | 用光圈/景深引导视线 |

**焦段叙事公式**：

```
[镜头/光圈参数] + [主体清晰度描述] + [背景虚化描述]
```

两种叙事方向：
- **内在孤独**（主体实，环境虚）：`85mm f/1.2 + subject razor-sharp + background blurred into abstract bokeh`
- **迷失渺小**（环境实，主体虚）：`Wide angle + deep DOF + subject with slight motion blur`

#### 氛围感万能公式

```
[媒介与主体区] + [虚实控制区] + [明暗控制区] + [冷暖色彩区] + [画质后缀]
```

---

### 2.2 构图叙事感三原则

#### 三分法 — 打破居中陷阱

AI 默认生成"证件照式"居中构图，缺乏故事感。

**通用公式**：`[主体描述] + [位置/构图词] + [环境/负空间描述]`

关键词：
- `positioned at the left/right third`
- `off-center composition`
- `negative space on the left/right`

工具特异性：
- Nano Banana Pro：直接用自然语言 "请把人物构图安排在画面的右下角，左上角留白展示天空"
- 即梦/可灵（视频）：`Subject positioned at the left third`（利用留白空间生成运镜）

#### 视觉动线 — 拒绝散乱

主体位置决定第一眼看哪里，动线决定第二眼、第三眼看哪里。

关键词：
- `leading lines` / `converging lines`
- `one-point perspective` / `vanishing point`
- `S-curve composition`
- `foreground framing`
- `Z-axis depth`

#### 画面平衡 — 非对称美学

三个平衡维度：
- **亮度**：亮区 > 暗区（吸睛）
- **色彩**：暖色/高饱和 > 冷色/低饱和
- **体量**：大物体 > 小物体

**构图万能公式**：

```
[构图方式] + [主体描述与位置] + [环境与引导线] + [光影/风格/平衡元素]
```

---

### 2.3 电影级调色 — 数据驱动三步法

#### Step 1：数据降维（提取色彩 DNA）

将参考图喂给多模态 AI，使用以下指令：

```
请作为专业的数字影像工程师（DIT），分析这张参考图片的色彩科学。
不要给我形容词，我要具体的参数数据。请输出：
- 直方图分析：高光、中间调、阴影的色彩倾向（RGB值及占比）
- 对比度与动态范围：黑位是否压低？白位是否过曝？
- 关键色板：提取画面中占比最高的5种颜色的HEX代码
- 光比数据：主光与辅光的大致光比
目标：将这些数据用于指导下一张图片的生成与重绘。
```

#### Step 2：参数嵌入（Hybrid Prompting）

在自然语言中嵌入硬数据：

```
错误：Cinematic shot, dark moody atmosphere, teal and orange style
正确：Cinematic shot. Shadows anchored at #003333, Highlights at #FFAA55.
      Lighting Contrast Ratio 1:4. Low-Key exposure, Desaturated Midtones.
```

HEX 代码的绝对性让 AI 无法"猜测"，只能"执行"。

#### Step 3：闭环验证（AI 监督者）

上传生成图与参考图，使用验证指令：

```
请对比图A和图B。假设图B是标准答案，图A是模仿作品。
请从色彩直方图、黑白场分布、色彩饱和度三个维度，
无情地指出图A的差异。如果色调偏离，请告诉我具体的偏差值。
```

根据反馈迭代修正提示词，直到匹配度 95%+。

---

### 2.4 精准复刻脑中画面 — 逆向对话三步法

#### Phase 1：让 AI 采访你

```
我脑子里有一个模糊的画面/感觉，我想生成一张图片（或一段视频）。
但我不知道怎么描述细节。请你扮演一位顶级的视觉艺术总监，
从镜头语言、构图方式、主体细节、光影色调、艺术风格这几个维度，
向我提问。请一个个问题问我，引导我把脑子里的画面具象化。
```

做选择题比凭空创造容易得多。

#### Phase 2：逻辑重组

图片公式：`[主体描述] + [环境背景] + [构图与视角] + [光影与色调] + [风格/渲染引擎]`

视频公式：`[主体运动] + [镜头运动] + [环境运动] + [氛围持续性]`

#### Phase 3：对比校准（做减法）

诊断三部曲：
1. **哪一部分不对？**（定位）
2. **为什么不对？**（归因）
3. **目标预期是什么？**（修正）

核心原则：2026 年的 AI 能力是溢出的，你需要学会**抑制它过度表现的冲动**，学会控制"留白"。

---

### 2.5 反向破译法 — 解决词穷

#### 感性具象化
先用大白话告诉 AI 你的感受 → AI 翻译成视觉参数（光影/构图/色调/细节）

#### 图生文反推
找参考图（电影截图/摄影作品） → 上传给 AI 分析微表情和细节 → 提取高级形容词 → 应用到自己的角色

#### 环境叙事法
不知道怎么写动态时，描述环境的连锁反应：

```
人跑 → 水花溅起 → 衣服贴身 → 头发向后甩
     → 车辆卷起水雾 → 霓虹灯倒影晃动 → 排水口溢水
```

公式：A 动了 → B 跟着动（线性物理推导）

---

## 三、视频生成 - 四大核心技法

### 3.1 人物一致性 — 三维度拆解

#### 资产维度：建立"神经锚点"

1. 生成人物三视图（正面/侧面/背面），不要"人物+场景+动作"一锅炖
2. 将三视图上传到视频模型，建立"角色 ID"
3. 复用角色 ID 生成不同场景

**原理**：人物和场景共同参与去噪。场景光影变化会渗入人物像素特征，导致人物不再是独立实体。

#### 空间维度：静态定型，动态演绎

1. **纯净动作图**：白底/灰底下生成人物动作（AI 全部算力用于人物）
2. **场景融合**：将人物抠图放入背景图合成
3. **图生视频**：合成图作为起始帧/结束帧，视频模型只需计算像素位移

**核心**：不要让视频模型去"设计"画面，只让它去"驱动"画面。

#### 时间维度：切碎镜头，对抗漂移

- 扩散模型每往前推演一帧，就多一次"像素偏移"的可能（时间漂移 Temporal Drift）
- 每段控制在 **2-4 秒"高保真甜蜜区"**
- 一个视频片段只承载一个核心动作
- 用剪辑软件缝合短镜头

---

### 3.2 动作描述 — 从清单到状态流

#### 技巧一：减少动词，增加方式词

```
错误：A man runs, jumps over a barrier, and rolls on the ground.
正确：Sprinting through dense fog, body tilted 15° forward into momentum,
      hair streaming backward, boots slamming wet earth,
      mud splattering with each heavy stride.
```

方式词（Manner）告诉 AI "怎么动"，而不是"动什么"。

#### 技巧二：锚点锁定法

一个自然的动作提示词包含两个层级：
- **锚点动作**（Anchor）：决定物理惯性/重心/位移（躯干和腿部）
- **从属动作**（Satellite）：附着在锚点之上的微调（头部/手臂/表情）

从属动作必须顺应锚点动作的节奏，否则像"提线木偶"。

#### 技巧三：状态快照法

```
错误：He finishes the drink, then slams the glass on the table angrily.
       （AI 会融合三个状态：嘴里塞着东西+笑+半站半坐）

正确：Mid-action freeze. An empty glass being pressed against the wooden table
      by a clenched fist. Liquid droplets still suspended in mid-air.
      Knuckles white with force. Jaw locked tight.
```

描述 Mid-action State（动作中段状态），大脑会自动补全前后连贯性。

**三条检查规则**：
1. 动词多吗？删掉，换成方式词
2. 主次分吗？找出一个主动作，其他做修饰
3. 有时间词（然后/之后）吗？删掉，改成描述当下状态

---

### 3.3 微表情精准控制

#### 方法一：控制情绪强度

```
错误（导致油腻）：Beautiful woman smiling happily at the camera.
正确（微表情路径）：A relaxed woman, corners of mouth slightly upturned,
                    soft gaze, facial muscles at ease, no posing feel.
```

**填空公式**：
```
[角色基本状态], [克制的情绪词], [具体的面部肌肉/五官描述],
[一个物理微动作], [光影/氛围]
```

情绪强度替换词库：
| 强情绪（避免） | 弱情绪（推荐） |
|----------------|----------------|
| Laughing | Slight smile / corners of mouth barely lifted |
| Angry | Jaw tightened / brow furrowed |
| Crying | Eyes glistening / a single tear forming |
| Scared | Eyes widened / breath held |

#### 方法二：动作驱动表情

```
错误：The woman is shy. （凭空捏造面部运动）
正确：She feels shy. She immediately lowers her head to avoid eye contact.
      Eyes look down, glancing nervously to the side.
      Chin tucked, biting lower lip gently. She doesn't dare look at camera.
```

**公式**：身体微动 + 视线转移 = 真实微表情

动作在前，表情在后。

#### 方法三：时间演变（视频专用）

```
Start (起始状态) → Transition (变化动作) → End (最终微表情)
```

示例：
```
Phase 1 (Start): Maintaining a serious, contemplative expression...
Phase 2 (Transition): Closes eyes, takes a deep visible breath...
Phase 3 (End): A faint, relieved smile slowly forms...
```

---

### 3.4 导演思维 — 超越工具人

#### 维度一：调度优先（场面调度 Mise-en-scène）

1. **Z 轴纵深**：强制划分前景（遮挡物）/ 中景（主体动作区）/ 后景（环境信息）
2. **动机光源**：不写"昏暗的光线"，写"光从哪里来"（百叶窗月光？台灯暖光？）
3. **视差运镜**：使用 Truck right 让镜头在前景遮挡物后方平移，制造物理视差

**提示词结构**：
```
[空间层次：前景遮挡 + 中景主体 + 后景环境] +
[光源动机：光从何处来，照亮什么] +
[运镜方式：结合空间的视差运动]
```

#### 维度二：叙事优先

- 不写情绪结果（`极度悲伤`），写生理过程（`喉结滚动 + 胸口起伏 + 嘴角微颤`）
- 不堆叠形容词（`孤独/唯美/苍凉`），强化对抗性动词（`逆风前行 + 死死压住斗笠 + 身体大幅前倾`）
- 必须给角色设定一个**环境阻力**

**提示词结构**：
```
[核心行动（一个高强度动词）] +
[身体对抗描述（肌肉/重心/呼吸）] +
[环境阻力（风/雨/人群/地形）] +
[生理细节替代情绪形容词]
```

#### 维度三：剪辑思维

即使模型能直出完美 15 秒，也不要原片直发：

1. **主镜头（A-roll）**：利用模型算力直出 15 秒基础动作长镜头
2. **情绪断点补拍**：在转折帧硬切，单独生成极特写（如惊恐瞳孔）
3. **空镜头（B-roll）**：生成物品掉落/环境变化的 2-3 秒高速摄影

**组合**：主镜头打底 + 特写突刺 + 空镜头留白 = 掌控呼吸感

---

## 四、镜头语言速查表

### 4.1 焦段 × 情绪

| 焦段 | 视觉特性 | 情绪语言 | 提示词后缀 |
|------|----------|----------|------------|
| 8-14mm 鱼眼 | 极端透视畸变，边缘球形拉扯 | 怪诞/压迫/监控/迷幻 | `Shot on 8mm fisheye lens, extreme perspective distortion` |
| 24-35mm 广角 | 视野开阔，轻微边缘拉伸 | 临场/宏大/自由/张力 | `Shot on 24mm lens, environmental portrait` |
| 50mm 标准 | 最接近人眼，无畸变 | 平静/客观/真实/日常 | `Shot on 50mm lens, natural perspective` |
| 85mm 人像 | 轻微空间压缩，完美虚化 | 唯美/专注/高级/优雅 | `Shot on 85mm lens, beautiful bokeh, shallow DOF` |
| 135-200mm 长焦 | 极强空间压缩，极浅景深 | 偷窥/隔离/宿命/凝视 | `Shot on 200mm telephoto, compressed background, isolating subject` |

### 4.2 景别 × 心理距离

| 景别 | 心理效果 | 适用情绪 | 关键描述 |
|------|----------|----------|----------|
| 极远景 | 情绪去参与化 | 孤独/渺小/史诗/宿命 | `Extreme long shot, tiny figure, epic scale` |
| 中景 | 最佳叙事载体 | 日常/对话/情节推进 | `Medium shot, waist up, narrative photography` |
| 特写 | 情绪终极放大器 | 极度悲伤/恐惧/压迫 | `Tight close-up, macro details, high tension` |

### 4.3 逻辑归一原则（铁律）

景别、焦段、景深、光影**必须服务于同一物理逻辑**，否则生成"缝合怪"。

常见矛盾组合（必须避免）：
- ❌ 远景 + 极浅景深（远景需要深景深交代环境）
- ❌ 广角 + 背景压缩（广角拉开纵深，压缩是长焦特性）
- ❌ 特写 + 全局清晰（特写本质是剥离环境干扰）

正确搭配：
- 压迫感：特写/中景 + 广角畸变 + 高对比光影
- 大动态：全景/中景 + 超广角透视 + 动感模糊
- 孤独感：远景 + 长焦压缩 + 冷色调 + 深景深

---

## 五、核心公式速查

### 图像万能公式

```
[媒介与主体] + [虚实控制] + [明暗控制] + [冷暖色彩] + [画质后缀]
```

### 构图万能公式

```
[构图方式] + [主体描述与位置] + [环境与引导线] + [光影/平衡元素]
```

### 视频动作公式

```
[一个核心动词] + [物理方式词] + [锚点-从属层级] + [环境反馈]
```

### 微表情公式

```
[角色状态] + [克制情绪词] + [面部肌肉描述] + [物理微动作] + [光影]
```

### 视频叙事公式

```
[核心行动] + [身体对抗] + [环境阻力] + [生理细节]
```

### 视频时序公式

```
Start(起始状态) → Transition(触发动作) → End(最终微表情)
```

---

## 六、常见错误 × 正确替代

| 场景 | ❌ 错误写法 | ✅ 正确写法 |
|------|------------|------------|
| 表达压抑 | `sad, dark, gloomy` | `80% deep shadows + single spotlight + chiaroscuro` |
| 表达温暖 | `warm tone` | `dominated by golden amber + faint teal in deepest shadows` |
| 表达高清 | `8k, ultra-detailed, sharp everything` | `85mm f/1.2 + subject sharp + background creamy bokeh` |
| 表达动作 | `runs, jumps, rolls` | 一个核心动词 + 方式词（角度/重力/速度） |
| 表达情绪 | `very happy, laughing` | `slight smile, corners barely lifted, relaxed muscles` |
| 表达时序 | `first...then...finally` | 直接描述 Mid-action State |
| 表达风格 | `Wong Kar-wai style` | 提取色彩 DNA（HEX 值 + 光比 + 色温） |
| 追求完美 | 堆满元素 | 建立视觉层级，做减法，控制留白 |

---

*"当 AI 生成的像素越来越逼真，真正区分'生成者'和'创作者'的，不再是你会不会写'8k, high quality'，而是你有没有导演思维。"*
