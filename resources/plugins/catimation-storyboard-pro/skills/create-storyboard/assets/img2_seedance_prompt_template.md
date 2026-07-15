# Img2 与 SceneDance/Seedance 提示词模板

## 1. Img2 中文提示词结构

```text
【图片用途】<角色一致性 / 表情表 / 动作姿势 / 场景建立 / 场景反打 / 产品英雄图 / 道具参考 / Clip 起始关键帧 / Clip 关键动作帧 / Clip 出点关键帧 / Clip 接力关键帧 / Clip 分镜 panel 源图 / 可选序列/氛围总览板 / 可选电影美术设定板>
【主体 ID】<C001 / S001 / P001 / CLIP001>
【生产目的】<这张图将如何稳定 SceneDance 生成或剪辑衔接>
【连续性锁定】<脸型、发型、服装、道具、空间布局、轴线、视线方向、运动方向、光线、天气、时间状态>
【画面内容】<谁在什么地方做什么，动作处于起点/中段/终点哪一个状态>
【构图与镜头】<景别、机位、焦段感、视角、主体位置、前后景、留白方向>
【动作状态】<手、头、身体、道具和视线的精确状态>
【接力状态】<本图是接住上一镜头、表现主动作、还是交出下一镜头；写清视觉/空间/运动/声音线索>
【情绪状态】<表情和情绪强度>
【光线与色彩】<时间、光源、色调、对比度、质感>
【风格】<写实/动画/电影感/古装/科幻等>
【技术要求】<高清、主体清晰、无文字乱码、产品 logo 清晰、手部稳定>
【负面约束】<不要换脸、不要换衣服、不要多手指、不要产品变形、不要改变空间方向>
【输出路径】<目标路径>
```

## 2. Img2 English Prompt Structure

```text
Purpose: <character sheet / expression sheet / action pose sheet / scene establishing / reverse angle / product hero / prop reference / clip start frame / key-action frame / edit-out frame / handoff frame / clean storyboard panel source / optional sequence-atmosphere board / optional cinematic art-direction board>.
Subject ID: <C001 / S001 / P001 / CLIP001>.
Production purpose: <how this image stabilizes SceneDance generation or edit continuity>.
Continuity locks: <face, hairstyle, wardrobe, props, scene layout, axis, eyeline, screen direction, light, weather, time state>.
Image content: <who is doing what, where, and whether the action is start/mid/end>.
Composition and camera: <shot size, camera angle, lens feel, subject placement, foreground/background, look room>.
Action state: <hands, head, body, prop, and eyeline state>.
Handoff state: <whether this image receives the prior shot, shows the main action, or hands off to the next shot; specify visual, spatial, motion, or sound clue>.
Emotion state: <expression and emotional intensity>.
Lighting and color: <time of day, light source, color palette, contrast, texture>.
Style: <realistic, cinematic, animation, period drama, sci-fi, etc.>.
Technical requirements: <high detail, clean hands, readable package, stable identity>.
Negative constraints: <no face change, no outfit change, no extra fingers, no prop deformation, no changed screen direction>.
Output path: <target path>.
```

## 3. 角色 / 表情 / 动作资产

### 身份锚点方案（按用户需要）

- 方案 A：正脸无表情大头照 + 正面全身照。前者负责面部，后者负责妆造/体型。
- 方案 B：三视图/四视图/多视图角色板。可直接作为 `identity-hard` 主锚，
  特别适合背面服装、复杂角度、建模或系统角色设计。
- 方案 C：用户确认的其它干净角色资产/角色设定图。
- 用户已提供或指定方案时直接采用；同时存在多套候选且主锚不明确时先询问用户。
  仅在低风险且未指定时默认方案 A。
- 多视图板内必须明确“同一角色的不同视角”，保持同一脸、发型、妆容、服装和比例，
  避免被误读为多个角色。

### 表情九宫格

- 同一角色、同一发型服装、九宫格排布。
- 常用表情：平静、微笑、惊讶、紧张、愤怒、悲伤、怀疑、恐惧、坚定。
- 表情只改变脸部和细微姿态，不改变年龄、脸型、服装或发型。

### 动作姿势表

- 每个复杂动作至少生成起始、中间、结束三个姿势。
- 动作包括：伸手、拿起、递交、奔跑、转身、跌倒、打斗、舞蹈、拥抱、拔剑、开车等。
- 姿势图优先使用全身或半身，背景简化，便于 SceneDance 识别动作连续性。
- 动作必须标注屏幕方向，例如从左向右、从画面深处走向镜头、从门内走出。
- 若该动作承担镜头接力，必须额外标注“交棒姿势”和“接棒姿势”，例如人物擦镜遮挡、手把道具送入特写、视线转向下一空间入口。

## 4. 场景 / 道具资产

### 场景建立图

- 锁定空间关系、主机位方向、光源方向、天气、时间状态和关键物件位置。
- 对话、追逐、对望、打斗等需要空间关系的段落，必须补充反打方向图或空间方向图。
- 场景图要标注入口、出口、角色站位、道具位置和运动方向。

### 产品 / 道具图

- 产品广告必须包含正面、背面、侧面、英雄图、手持图、使用场景图、材质微距图。
- 品牌、包装、颜色、形状、logo 位置必须锁定。
- 道具特写必须明确尺寸关系、拿取方式、位置变化和镜头重点。

## 5. Clip 关键帧

- `start frame`：SceneDance 主输入图，必须清楚、干净、无表格文字。
- `key action frame`：只在动作中段需要锁定时使用。
- `edit-out frame`：只在剪辑出点需要明确时使用；不默认要求与下一 clip 首帧连续。
- `handoff frame`：只在相邻 clip 需要更强交接时使用，明确上一 clip 交出的遮挡、光线、道具、空间入口、UI 或运动方向。
- 每张关键帧必须写明角色位置、视线方向、手部动作、道具位置、场景光线、运动方向和接棒/交棒状态。

## 6. 可选项目级总览板（使用时前缀必填）

- **序列/氛围总览板**：图像模型生成 3×3/4×4 镜头缩略图；作为视频参考时只
  提取色彩、光线、材质、时代感、空间气质和视觉母题，标 `atmosphere-loose`。
- **电影美术设定板**：图像模型生成俯视图、立/剖面、材质、灯光、色板与角色/道具
  视觉源；本地叠加机位、尺寸、镜头表和生产文字。作为视频参考同样只供氛围。
- 两类板都不能替代 `identity-hard` 和 `keyframe-strong`。只要被某 clip 引用，
  该 clip 的提示词必须先写“提示词主导 / 氛围板低约束”前缀。
- 精确复刻某一格时，裁出相关格，清除边框/文字并重绘为干净 `keyframe-strong`。

## 7. SceneDance Shot 视频提示词结构

```text
Shot ID: <SH###>.
Clip ID: <CLIP###>.
Duration: <generation must be 4-15 seconds; shorter final beats are trimmed from a >=4s render>.
Primary input image: <selected clean keyframe image id/path>.
Auxiliary references: <character sheet, scene sheet, prop sheet, pose/expression sheet, storyboard board if useful>.
Reference roles: <prompt-primary / identity-hard / keyframe-strong / atmosphere-loose / director-free>.
Board preamble: <required whenever a storyboard/grid/art-direction board is referenced; prompt controls story/composition/action/order/duration, boards supply atmosphere only>.
Must not copy from boards: <grid borders, panel numbers, captions, tables, collage layout>.
Shot purpose: <why this shot exists in the edit>.
Main action: <one clear action chain only>.
Start receiver state: <what visual/spatial/motion/audio clue this clip receives from the prior clip; "opening" if first clip>.
Action start: <exact beginning body/prop/eyeline state>.
Action end / edit-out: <exact natural cut point>.
End handoff state: <what this clip plants for the next clip: foreground, doorway, object, light, shape, motion, UI, sound, or spatial clue>.
Edit-out visual token: <the visible token at the cut point that editor can cut on>.
Next-scene clue: <what the audience should subconsciously expect in the next clip>.
Emotion start: <beginning emotion>.
Emotion end: <ending emotion>.
Camera movement: <one main movement chosen for purpose: locked-off / slow push-in / pull-back reveal / lateral track / following track / foreground occlusion push / POV / over-shoulder / low-high angle / handheld micro-move / prop-led or light-led move>.
Composition: <shot size, subject position, look room, foreground/background, screen direction>.
Continuity locks: <identity, wardrobe, hair, scene layout, prop placement, light, weather, color, axis, eyeline, screen direction>.
Edit handles: <keep 0.5-1s at start/end if possible for trimming>.
Audio direction: <dialogue, ambience, SFX, music cue, J-cut/L-cut idea>.
Avoid: <identity drift, wardrobe changes, scene jumps, axis flip, eyeline mismatch, rushed cuts, unfinished action, malformed hands, logo changes, AI-invented interpolation between unrelated scenes>.
```

```text
【Shot ID】<SH###>
【Clip ID】<CLIP###>
【建议生成时长】<生成必须 4–15 秒；短于 4 秒的成片节拍先生成至少 4 秒再后期裁切>
【主输入图】<选中的干净关键帧 ID/路径>
【辅助参考图】<角色图、场景图、道具图、动作/表情图、必要时分镜图>
【参考职责】<prompt-primary / identity-hard / keyframe-strong / atmosphere-loose / director-free>
【氛围板前缀】<只要引用故事板/多宫格/美术设定板即必填：提示词主导故事/构图/动作/顺序/时长，板只供色彩/光线/材质/时代感/空间气质/视觉母题>
【总览板禁止复制】<网格边框、编号、文字、表格、拼贴版式>
【镜头目的】<这个镜头在剪辑里的作用>
【主动作】<只写一条清晰动作链>
【接棒入点】<本 clip 从上一 clip 接住什么视觉/空间/运动/声音线索；首镜写片头>
【动作起点】<身体、手、道具、视线的开始状态>
【动作终点/出点】<可自然剪切的结束状态>
【交棒出点】<本 clip 结尾交给下一 clip 的前景、门、道具、光线、形状、运动方向、UI 或声音线索>
【出点视觉令牌】<剪辑点上可被剪辑师抓住的可见元素>
【下一场景线索】<观众在结尾应该被提前带向的下一空间或潜在内容>
【情绪起点】<开始情绪>
【情绪终点】<结束情绪>
【镜头运动】<固定观察 / 缓慢推进 / 拉远揭示 / 横移跟拍 / 随行跟拍 / 前景遮挡推进 / POV / 过肩 / 低高机位 / 手持微晃 / 道具或光源引导>
【构图】<景别、主体位置、视线留白、前后景、屏幕方向>
【连续性锁定】<身份、服装、发型、空间、道具、光线、天气、色调、轴线、视线、运动方向>
【剪辑余量】<尽量保留 0.5-1 秒开头/结尾可裁切>
【声音方向】<对白、环境声、动作声、音乐、J-cut/L-cut>
【避免事项】<身份漂移、换衣服、空间跳变、轴线反转、视线不匹配、动作未完成、手部错误、logo 变形、让 AI 自行硬插值转场>
```

## 8. 镜头接力提示词结构

```text
Handoff ID: <HO_CLIP001_CLIP002>.
Boundary: <CLIP001 -> CLIP002>.
Prior clip handoff: <what the prior clip visibly/sound-wise hands over at the end>.
Next clip receiver: <what the next clip starts by receiving>.
Spatial entrance/exit: <door, corridor, window, screen, product surface, UI panel, light source, object direction>.
Motion vector: <left-to-right, right-to-left, push-in, pull-back, down-up, toward camera, away from camera>.
Occlusion carrier: <door frame, body crossing lens, black foreground, smoke, flare, vehicle, package, UI window; "none" only with reason>.
Visual bridge: <matched color, shape, brightness, texture, composition, object position, foreground mass>.
Sound bridge: <J-cut/L-cut using ambience, dialogue, music, footsteps, click, impact, product SFX>.
How it hides AI discontinuity: <identity jump, lighting jump, space jump, hand mismatch, object position jump, rhythm break>.
Fallback if failed: <insert, reaction, prop close-up, empty shot, rebuild keyframe, shorten clip>.
```

```text
【Handoff ID】<HO_CLIP001_CLIP002>
【边界】<CLIP001 -> CLIP002>
【上一 clip 交出的线索】<结尾可见/可听的接力物>
【下一 clip 接住的线索】<开头接住上一镜头的方式>
【空间入口/出口】<门、走廊、窗、屏幕、产品表面、UI 面板、光源、道具方向>
【运动方向】<左到右 / 右到左 / 推入 / 拉出 / 向上 / 向下 / 向镜头 / 远离镜头>
【遮挡载体】<门框、擦镜人物、黑色前景、烟雾、光斑、车辆、包装、UI 窗口；没有必须说明原因>
【视觉桥】<颜色、形状、亮度、质感、构图、道具位置、前景块面的匹配>
【声音桥】<环境声、对白、音乐、脚步、点击、撞击、产品音效的 J-cut/L-cut>
【降低的 AI 风险】<身份跳、光线跳、空间跳、手部错、道具位置跳、节奏断>
【失败备用】<插入镜头 / 反应镜头 / 道具特写 / 空镜 / 重生关键帧 / 缩短 clip>
```

## 9. 剪辑边界提示词结构

```text
Edit boundary ID: <EB_CLIP001_CLIP002>.
Boundary: <CLIP001 -> CLIP002>.
Handoff ID: <HO_CLIP001_CLIP002>.
Previous out point: <image/action/emotion/sound at the end of the prior clip>.
Next in point: <image/action/emotion/sound at the beginning of the next clip>.
Cut type: <action match / eyeline match / screen-direction match / composition match / shot-size progression / reaction cut / insert / cutaway / empty-room cut / occlusion cut / hard cut / J-cut / L-cut / continuous action>.
Why it cuts naturally: <reference the handoff design; visual match, action punctuation, emotional cause-effect, sound carry-over, object direction, rhythm>.
Audio bridge: <ambience, dialogue, music, footsteps, object sound, impact sound>.
Frame matching required: <no by default; yes only for continuous action>.
CapCut handling: <direct cut / sound overlap / trim 0.5s / insert close-up / short crossfade / speed change>.
Risk: <identity jump, object jump, rhythm break, axis flip, eyeline mismatch, lighting jump>.
Fallback cut: <switch to insert/reaction/prop close-up/empty shot/rebuild keyframe; do not rely on vague AI interpolation>.
```

## 10. Image 2 Clip 分镜 panel 源图提示词结构

Image 2 只负责生成干净的 storyboard panel 源图，不负责最终生产分镜板排版、可读文字、表格、caption 或标签。

最终 `final_image_package/clip_storyboards/<CLIP###>_storyboard_<time-range>.png` 必须由本地确定性排版生成：把 clean panels/keyframes 放入固定版式，再从 `shot_cards.md`、`handoff_design_matrix.md`、`edit_boundary_matrix.md` 和 `scenedance_shot_prompts.md` 渲染可读文字。不要接受图片模型直接生成的带文字三格板作为最终交付。

禁止把全片多个 `CLIP###` 合在一张最终分镜图里交付。序列/氛围总览板与电影美术
设定板按项目需要生成；被视频引用时标为 `atmosphere-loose`，必须带提示词主导
前缀，且不得作为主输入或 `firstFrame`；
用户要求“分镜图 / 重新生成分镜图”时，默认要逐个 `CLIP###` 交付最终生产板。
若两个镜头被合并，必须先在 `clip_plan.md` 把它们合并为一个明确的 `CLIP###`，
再生成该合并 clip 的干净主关键帧、干净 panel 源图和最终生产分镜板。

```text
【图片用途】SceneDance Clip 分镜 panel 源图
【项目】<项目名>
【Clip】<CLIP###，成片时间轴例如 0-6s；对应生成请求必须 4–15s>
【参考输入】<明确列出已加载或已附加的角色图、场景图、道具图、关键帧图>
【Panel 角色】<START / KEY ACTION / EDIT OUT / HANDOFF；一次只生成一个干净 panel，或生成无文字的 panel strip 源图>
【画面要求】生成只服务此 clip 的干净视觉画面；不要生成生产板布局、文字栏、表格、caption、箭头说明或可读标签
【Clip预算】<clip 时长、主动作目标、主镜头运动、剪辑安全余量、剪辑点类型>
【镜头内容】<接棒入点、起点、关键动作、出点画面或交棒出点；角色状态、道具位置、情绪变化>
【构图要求】<干净电影画面；无文字；无表格；无多余 panel 边框；适合后续放入确定性 storyboard board 模板>
【连续性锁定】<角色脸、服装、场景布局、道具、色彩、光线、轴线、视线、运动方向>
【镜头接力】<上一镜交出的线索、本镜接住的线索、本镜交出的下一镜线索；用空间、运动、遮挡、构图、光线或声音表达>
【剪辑边界】<上一镜出点、下一镜入点、剪辑类型；默认不要求首尾帧连续>
【详细度】<普通 / 详细 / 极详细；复杂动作、情绪反转、产品特写必须提高详细度>
【负面约束】不要生成最终 storyboard board，不要生成全片总览图，不要生成带文字/标签/空 caption 的三格板，不要生成无关四宫格概念图，不要只给单张电影海报，不要无关角色，不要复刻现有 IP，不要把一个 clip 塞成多动作混剪，不要让 AI 自行硬插值转场
【输出路径】final_image_package/clip_storyboards/panels/<CLIP###>_<start|key|out|handoff>.png
```

## 11. Final Storyboard Board 确定性排版要求

最终生产分镜板不是 Image 2 prompt 产物；它由本地可控渲染生成，输出到：

```text
final_image_package/clip_storyboards/<CLIP###>_storyboard_<time-range>.png
```

每张最终板必须包含：

- Header：项目名、`CLIP ID`、时间范围、场景、地点、时间、天气、风格、画幅、色调。
- Visual panels：`START`、`KEY ACTION`、`EDIT OUT`，可选 `HANDOFF`。
- Camera block：景别、镜头运动、构图、焦点、屏幕方向。
- Action block：动作起点、动作过程、动作终点/出点、情绪起点/终点。
- Edit block：剪辑出点、建议剪辑类型、音频桥、环境声、对白/音效提示。
- Continuity block：接棒入点、交棒出点、参考图组合、风险和失败备用。

失败即重做：

- 空 caption 区、占位文字、乱码、缺少 `CLIP ID`、缺时间范围、缺 START/KEY/EDIT OUT、缺剪辑边界、缺音频桥、缺参考图组合、混入多个 clip、海报式单图冒充分镜、全片 overview 冒充分镜。

## 12. 通用负面提示词

```text
不要换脸，不要改变年龄，不要改变发型，不要改变服装，不要改变产品包装，不要 logo 变形，不要文字乱码，不要多余手指，不要畸形手，不要肢体穿模，不要场景突然变化，不要光线跳变，不要轴线反转，不要视线错乱，不要运动方向错乱，不要过度磨皮，不要低清晰度，不要水印，不要字幕。
```

```text
No face change, no age change, no hairstyle change, no wardrobe change, no product packaging change, no distorted logo, no garbled text, no extra fingers, no malformed hands, no body intersection, no sudden scene change, no lighting jump, no axis flip, no eyeline mismatch, no wrong screen direction, no over-smoothed skin, no low resolution, no watermark, no subtitles.
```
