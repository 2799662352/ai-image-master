---
name: create-storyboard
description: Create director-grade storyboard production packages for Image 2 and SceneDance/Seedance. Use for scripts, scene/ad/drama/animation/product concepts, 分镜图/剧本分镜/连续性分镜, shot cards, keyframes, continuity/edit-boundary matrices, Seedance assets, and 3×3/4×4 sequence or cinematic art-direction boards with prompt-led atmosphere-reference handling.
---

# Create Storyboard / 连续性优先的制片包生成器

<!-- skill-budget: standard -->

## Overview

把剧本变成 SceneDance/Seedance 可用的制片包,产出表现得像由导演、分镜师、剪辑师、AI 视频协调员共同准备。**输出不是画面描述清单,而是一份连续性受控的出片计划**——用于生成许多 `4-15s` 视频片段并能顺畅剪到一起。

始终为以下目标优化:

- 独立生成的片段之间保持电影连续性
- 每次 SceneDance 生成只有一条清晰动作链 + 一个主镜头运动
- 每镜都有明确的动作起止与情绪起止
- 刻意设计的镜头接力:每个片段结尾埋下视觉/空间/运动/声音线索,下一片段接住
- 参考图纪律:角色、场景、道具、关键帧、分镜输入
- 分清身份锚点、干净关键帧、序列总览板、美术设定板和导演自由区的职责
- 在写提示词前先设计衔接与剪辑点
- 剪映/CapCut 的后期可用性

## When to Use

- 用户给剧本/场景概念/广告概念/短剧/长剧/古装/科幻动画/产品视频,要"分镜图 / 剧本分镜 / SceneDance 素材 / Image2 提示词 / 角色一致性表 / 连贯性圣经 / shot cards / 关键帧 / 剪映清单 / 图生视频素材包 / 网格镜头总览 / 电影美术设定板"。
- **何时不用:** 单镜画面打磨/参考图反推 → 交给单点画面工艺技能库(见本插件入口卡的周边插件分工);端到端"做成片" → 由上层成片编排器负责(它会在需要时调本 skill)。

## Quick Reference

| 步骤 | 产物 | 关键约束 |
|---|---|---|
| 0 确认必问项 | — | **画幅、目标时长**缺则先问(Hard Rule),再开工 |
| 1 提取 brief | 项目简报 | 视频类型/受众/时长/画幅/基调/角色/场景/道具/音频 |
| 2 拆场拆节拍 | 场景与戏剧节拍 | 找情绪转折、物理动作、揭示、可接力点 |
| 3 建圣经 | character/scene/product_prop/style/continuity bible | 写最终提示词前锁定身份/空间/光线/轴线 |
| 4 资产计划 | 转身/表情/姿势/建立/反打/道具/关键帧清单 | 干净起始关键帧优先 |
| 5 shot cards | 每默认 `CLIP###` 一张 `SH###` | 时长按动作/情绪/信息密度,不平均分 |
| 6 参考输入矩阵 | 每镜主输入图 + 辅助参考 | 每镜必有主干净输入图 ID |
| 7 衔接矩阵 | `handoff_design_matrix.md` | 上一镜埋线索、下一镜接住 |
| 8 剪辑边界矩阵 | `edit_boundary_matrix.md` | 连续性剪辑:动作/视线/方向/反应/插入/J-L-cut |
| 9 Image2 提示词 | 中、英分文件 | 同一生成 prompt 不混语言 |
| 10 生成/准备图 | 干净 panel/关键帧 → 确定性排版；按需生成序列/美术总览板 | 图像模型出视觉层，生产文字本地叠加 |
| 11 Seedance 逐镜提示词 | `scenedance_shot_prompts.md` | 接棒入点/动作起止/情绪起止/运镜/出点令牌/音频桥 |
| 12 后期材料 | SceneDance 使用清单 + 剪映/CapCut 计划 + 风险回退 + 图清单 | |
| 13 校验 | 见 §Validation | 每次生成 4–15s、有衔接与边界、有主输入图 |

## Runtime Assumptions

- 制品目录树由 agent 按 `assets/production_package_spec.md` 用文件读写工具**确定性创建**,无需外部脚本或特定语言运行时(harness-agnostic)。
- 制片分镜规划需要一个能读写文件、检视剧本与生成产物、修订生产文档的 agent。
- 涉及参考图、角色表、关键帧、分镜板或对生成视频/图像做审查时,用多模态模型。
- 真实制片包用强推理模型;长片、多场景连续性、密集衔接/边界矩阵时尽量用更高推理档。
- 平台细节见 `references/runtime-and-platform.md`(向用户承诺可复现性前先读)。

## Hard Rules

- SceneDance/Seedance **生成时长必须为 4–15s**。剪辑中需要 1.5–3s 的插入、
  反应或冲击节拍时，先生成至少 4s 并预留稳定首尾，再在后期裁到目标时长。
- 新项目默认 `SH### = CLIP###`:一个电影镜头 = 一次 SceneDance 视频生成。仅低风险插入镜或用户明确要求时,一个 `CLIP###` 才覆盖多镜。
- 用户说"分镜图""重新生成分镜图""storyboard images""SceneDance inputs"默认是
  **逐 clip 交付**；总览板不能替代逐 clip 生产板。
- 序列总览板/电影美术设定板是可生成的氛围与沟通资产，不是每个项目必交。
  **但只要任一板被加入视频参考，视频提示词必须带“提示词主导 / 氛围板低约束”
  职责前缀**，并把它标为 `atmosphere-loose`，不得省略。
- 全片总览板/主分镜表/拼贴图可用于 review，也可按 `atmosphere-loose` 作为氛围
  辅助参考；它们不是最终 SceneDance 分镜图，不计入已交付的 `CLIP###` 分镜产出，
  也不得作为主输入或 `firstFrame`。
- 每张最终分镜图必须正好覆盖一个 SceneDance 生成单元:`final_image_package/clip_storyboards/<CLIP###>_storyboard_<time-range>.png`。
- 最终分镜板必须是生产板,不是 AI 生成的情绪板。不要让图像模型生成最终板的版式、标签、caption、表格或可读生产文字。
- 图像模型只能生成干净视觉源:起始 panel、关键动作 panel、出点 panel、接力 panel 或干净关键帧。最终分镜板版式用本地确定性排版代码/HTML-CSS 截图/设计工具/其他可控渲染器拼装。
- 任何分镜板若有空 caption 区、缺 `CLIP ID`、缺时间范围、缺起/关键/出点结构、乱码、混入多 clip、海报式构图或缺剪辑/接力信息,一律拒收并重做/重排。
- 时长由剧情驱动，不按固定总量(如一分钟 = 4×15s)均分。插入/反应可在成片中
  使用 `1.5-4s`，但生成请求仍设为至少 4s 后裁切；清晰物理动作生成 `4-7s`、
  持续表演或氛围 `8-12s`、稳定长镜 `12-15s`。
- 每镜必须定义:目的、时长、景别、镜头运动、构图、角色状态、动作起止、情绪起止、接棒入点、交棒出点、运动矢量、空间桥、遮挡载体、视觉桥、参考图、SceneDance 提示词、上一转场、下一转场、剪辑备注、风险、回退。
- 写最终提示词前先建连贯性圣经。锁定身份、服装、发型、道具、场景地理、180 度轴线、视线、屏幕方向、光线、天气、时间状态、色彩、画幅、镜头语言、关键物件位置。
- 角色锚点按用户需要选择：大头照+全身照、三视图/四视图/多视图角色板或其它
  用户确认的干净资产都可作为 `identity-hard`。用户已提供/指定就服从；多套候选
  拿不准且身份关键时先询问，未指定的低风险项目才默认大头照+全身照。
  `character_bible.md` 必须记录最终选定主锚及职责。
- 出图前先设计衔接矩阵与剪辑边界矩阵。每对相邻镜要写清:上一镜交出什么、下一镜接住什么、空间出入、运动方向、遮挡载体、视觉桥、音频桥、剪辑类型、是否需帧匹配、CapCut 处理、回退切。
- 默认边界策略是**可剪连续性**,不是严格帧连续。优先动作匹配、视线匹配、屏幕方向匹配、构图匹配、cutaway、插入、反应、空镜、遮挡切、硬切、J-cut、L-cut。仅当动作必须真正连续时才用严格首尾帧匹配。
- 边界不能只标"自然切""平滑转场""硬切",除非衔接设计写明传递的接力棒,或该镜明确选择刻意跳切/情绪断裂。
- 不要让 SceneDance 在一次生成里解决复杂多人调度、多次镜头切换或太多动作节拍。用特写、插入、反应、道具或氛围镜拆分。
- 镜头运动按剧情与 SceneDance 稳定性选择,不要习惯性重复。仅在有动机时用固定镜;按需用跟拍、横移、前景遮挡推进、拉远揭示、手持微晃、POV、过肩、低/高机位、门框窥视、道具引导、光线引导或 UI 前景遮挡服务接力。
- 含文字/网格/多格的分镜板不是 SceneDance 主输入。主视频输入应是 `final_image_package/clip_keyframes/` 或 `05_images/selected/` 里的干净关键帧。
- 单帧与总览板不冲突：身份锚点锁人/产品，干净关键帧锁当前 clip 构图与画质；
  故事板/多宫格/美术设定板只作 `atmosphere-loose` 氛围参考，提取色彩、光线、
  材质、时代感、空间气质和视觉母题。故事、构图、动作、顺序、时长由文字提示词
  主导；总览板不得作为 `firstFrame`。精确跟随某格时先拆格并清理成干净图。
- 若两相邻镜合并后生成时长仍在 `4–15s`,它们在 `clip_plan.md` 成为一个明确
  `CLIP###`。为该合并 clip 生成一张干净起始关键帧和一张单 clip 生产分镜板;
  不要把双格/多镜板当主图喂 SceneDance。
- 若用户未指定画幅,在出最终提示词或生成图像前先问一句。若目标时长不可推断,在最终分镜规划前先问。

## Standard Workflow

1. 提取 brief:视频类型、受众/平台、目标时长、画幅、故事意图、基调、角色/产品、场景、道具、对白/音频、交付范围。
2. 把剧本拆成场景与戏剧节拍。识别情绪转折、物理动作、物件交互、揭示,以及可接力下一空间或隐藏生成断点的位置。
3. 建圣经:`character_bible.md` / `scene_bible.md` / `product_prop_bible.md` / `style_bible.md` / `continuity_bible.md`。
4. 建资产计划:用户选定的角色主锚（大头照+全身照或多视图板）、表情/姿势、场景建立/反打、道具/
   产品表、干净起始关键帧、关键动作帧、出点帧、可选桥接帧、最终 clip 分镜板；
   按项目需要增加序列总览板和电影美术设定板。
5. 建 shot cards,默认每 `CLIP###` 一张 `SH###`。每镜按动作负载、情绪、信息密度、剪辑节奏、接力需求选时长。
6. 写参考输入矩阵。每个 SceneDance 镜必须列出主干净输入图 + 所有辅助角色/场景/
   道具/分镜参考，并给每份素材标 `prompt-primary / identity-hard / keyframe-strong /
   atmosphere-loose / director-free` 职责与 `must_not_copy`（如网格边框、编号、
   文字、拼贴版式）。
7. 出最终提示词前建 `handoff_design_matrix.md`。上一 clip 必须埋下下一 clip 的空间/运动/视觉令牌/声音线索;下一 clip 开头接住。
8. 从衔接矩阵建剪辑边界矩阵。用连续性剪辑:动作匹配、视线匹配、屏幕方向、构图/节奏匹配、景别递进、反应、插入、cutaway、遮挡、J-cut、L-cut。
9. Image 2 提示词分中、英文件写。同一生成 prompt 不混语言。
10. 要求生成图像时先生成/准备参考图。先出干净 panel/关键帧,再为每个
    `CLIP###` 拼装一张确定性生产分镜板；按项目需要另出 3×3/4×4 序列总览板
    或电影美术设定板。图像模型生成视觉底图/缩略图，本地确定性层叠加机位、
    尺寸、镜头表、材质和灯光文字。
11. 写 SceneDance 镜头提示词:选定图、时长、接棒入点、动作起止、情绪起止、镜头运动、连续性锁定、交棒出点、出点视觉令牌、下一场景线索、剪辑余量、音频桥、避免清单。
12. 写后期材料:SceneDance 使用清单、剪辑连续性备注、剪映/CapCut 剪辑计划、风险/回退计划、图清单。
13. 校验:每次生成 `4–15s`、短节拍已标后期裁切、每镜有衔接与边界计划、
    每镜有主输入图 ID、每张承诺图被追踪、无遗漏的身份/空间/风格锁定。

## Production Package

不使用任何脚本。按 `assets/production_package_spec.md` 列出的目录与文件清单,用文件工具**确定性创建**包骨架,以 `assets/storyboard_template.md` 作可填模板,以 `assets/img2_seedance_prompt_template.md` 作提示词结构。

包结构:

```text
storyboard_projects/<project-slug>/
├── 01_script_brief/
├── 02_bibles/
├── 03_storyboard/
├── 04_prompts/
├── 05_images/
├── 06_delivery/
└── final_image_package/
```

确切文件与字段读 `assets/production_package_spec.md`;可填模板读 `assets/storyboard_template.md`;提示词结构读 `assets/img2_seedance_prompt_template.md`;详细工作流与连续性/剪辑规则读 `references/storyboard_workflow.md`。

## Required Outputs

完整制片包必须包含:脚本分析与项目简报;角色、场景、道具/产品、风格、连贯性圣经;资产生成清单;主分镜与详细 shot cards;SceneDance 参考输入矩阵;衔接设计矩阵;剪辑边界矩阵;Image 2 中文与英文提示词;SceneDance 镜头提示词;SceneDance 使用清单;后期/剪映/CapCut 计划;风险与回退计划;最终图清单。若交付序列总览板/电影美术设定板，在 manifest 标为 `atmosphere-loose`，并在每条使用它的视频提示词前加必填职责前缀。

## Shot Card Schema

每张 shot card 必须是可读 Markdown,并含一个含以下必填键的 YAML 块:

```yaml
shot_id: SH001
clip_id: CLIP001
scene_id: S001
purpose: ""
duration: ""
shot_size: ""
camera_movement: ""
composition: ""
character_state: ""
action_start: ""
action_end: ""
emotion_start: ""
emotion_end: ""
receiver_in: ""
handoff_out: ""
motion_vector: ""
spatial_bridge: ""
occlusion_carrier: ""
visual_bridge: ""
handoff_risk_reduction: ""
primary_input_image: ""   # 本镜主干净输入关键帧 ID(必填);reference_images 为辅助参考
reference_images: []
scenedance_prompt: ""
prev_transition: ""
next_transition: ""
edit_notes: ""            # 仅放本镜出入点摘要;相邻镜的完整剪辑边界写进 edit_boundary_matrix.md,勿重复/冲突
risks: []
fallback_plan: ""
```

## Editing Logic To Apply

刻意使用电影语言:

- 在依赖视线或运动方向前先建立地理。
- 尊重 180 度轴线,除非 shot card 明确设计了轴线重置。
- 把每对相邻镜当接力棒:上一镜结尾必须提供下一镜可继承的接力物、运动、前景、光线、色彩、门口、UI 层、声音或空间线索。
- 不要依赖 AI 插值在不相关图像间编造连续性。设计视频本身:镜头运动、前景遮挡、构图延展、空间进出、声音延续。
- 用视线匹配:角色看向画外,再切到他所见。
- 用动作匹配:手伸出,切到道具特写;头转动,切到反应或 POV。
- 用屏幕方向匹配:左右进出在空间上保持有意义。
- 用景别节奏:远到中到近用于定位、动作、情绪;近到插入用于细节;反应镜吸收断点。
- 用插入、道具、空镜、遮挡、前景擦镜、门框、过往车辆、黑暗、闪光或运动模糊隐藏 AI 断点。
- 用 J-cut 与 L-cut:让对白、环境声、音乐、脚步、物件声或撞击声跨片段桥接。
- 尽量留 `0.5-1s` 剪辑余量,以便裁切生成的首尾。

## Camera Language Library

每 clip 选一个主镜头方法,并说明它如何服务该镜或接力:

- `locked-off`:稳定观察、产品清晰、视觉对比或精确插入。
- `slow push-in`:情绪压迫、揭示或注意力收窄;别当每镜默认。
- `pull-back reveal`:揭示新空间、隐藏物件、人群、UI 状态或后果。
- `lateral track`:跟随运动方向、交接左右屏幕地理或从前景后方掠过。
- `following track`:随角色走、走廊/门口移动、进入新空间。
- `foreground occlusion push`:让门框、身体、货架、招牌、烟雾、雨、车辆或 UI 层把画面擦入下一 clip。
- `POV / subjective`:接住视线并展示角色所见。
- `over-shoulder`:保持对白轴线与空间关系。
- `low/high angle`:强调权力、脆弱、规模或产品英雄地位。
- `handheld micro-move`:张力与人在场感;为 SceneDance 稳定性把动作保持小幅。
- `prop-led / light-led move`:让手持物、屏幕辉光、手电、产品反光或色场把观众拉入下一镜。

## Image Generation Handling

生成图像时:

- 中文 prompt 图生成到 `05_images/zh/`;英文到 `05_images/en/`;选中的干净 SceneDance 输入放 `05_images/selected/`。
- 最终干净 clip 关键帧放 `final_image_package/clip_keyframes/`。
- 生成的干净分镜 panel 源图放 `final_image_package/clip_storyboards/panels/` 或其他明确命名的 panel 源文件夹。
- 确定性最终 clip 分镜板放 `final_image_package/clip_storyboards/`。
- 项目级总览板分别放 `final_image_package/overview_boards/sequence/`
  与 `final_image_package/overview_boards/art_direction/`；它们不计入逐 clip 分镜交付数。
- 角色、场景、产品、道具、表情、姿势参考放 `final_image_package/support_assets/`。
- 文件名可追踪:`<image-id>__zh__v01.png`、`<image-id>__en__v01.png`、`<image-id>__selected.png`。
- 若图像工具无法直接存盘,仍创建 prompt 文件并记录预期输出路径。把图像生成标记为 blocked,不要假装参考条件图已存在。

## Storyboard Board Contract

最终 `clip_storyboards/` 文件是确定性生产板:

- 每板正好覆盖一个 `CLIP###`。
- 每板用干净视觉 panel 或关键帧作图像输入;版式与所有可读文字由本地确定性工具渲染。
- 必需视觉 panel:`START` / `KEY ACTION` / `EDIT OUT`。仅在能厘清边界时加 `RECEIVE IN` 或 `HANDOFF`。
- 必需可读字段:项目/标题、`CLIP ID`、时间范围、时长、场景/地点、画幅、风格/基调、镜头方法、动作起点、关键动作、出点状态、情绪起止、接棒入点、交棒出点、剪辑类型、音频桥、参考图组合、风险/回退。
- 必需源映射:每个视觉 panel 映回关键帧/panel 路径,每个文字字段来自 `clip_plan.md`、`shot_cards.md`、`handoff_design_matrix.md`、`edit_boundary_matrix.md` 或 `scenedance_shot_prompts.md`。
- 不要在最终板留空文本框或占位 caption。
- 不要依赖图内生成文字作生产元数据。若图像模型生成了文字,当作装饰噪声,用确定性渲染替换该板。
- 直到人类剪辑师不打开 Markdown 也能读懂前,不算最终板完成。

## Validation Before Delivery

定稿前:

- 每个 SceneDance 生成请求均为 `4–15s`；成片中短于 4s 的节拍来自后期裁切
- 每个新项目镜默认 `SH### = CLIP###`
- 每张 shot card 有全部必填 YAML 键
- 每镜有动作起止与情绪起止
- 每镜有 `receiver_in`、`handoff_out`、`motion_vector`、`spatial_bridge`、`occlusion_carrier`、`visual_bridge`、`handoff_risk_reduction`
- 每镜有主干净输入关键帧 ID(`primary_input_image` 字段)
- 每镜列出参考图组合
- 每对相邻镜有一行衔接设计
- 每对相邻镜有一行剪辑边界
- 每个边界有剪辑类型、匹配逻辑、音频桥、CapCut 处理、风险、回退,并引用衔接逻辑
- 每个复用角色/产品/场景用圣经 ID
- 中文与英文 Image 2 提示词分离
- 分镜板不被当作唯一 SceneDance 视频输入
- 分镜板由干净 panel/关键帧确定性拼装,不接受原始 AI 生成板版式
- 每张最终分镜板含可读 `CLIP ID`、时间范围、起/关键/出点结构、镜头/动作/剪辑元数据、衔接、剪辑边界、音频桥、参考图组合、风险/回退
- 每张最终分镜板无空 caption 区、占位标签、缺时间码、混 clip 版式、海报式构图或乱码生产文字
- 任一被视频引用的总览板已标 `atmosphere-loose`，对应视频提示词含 mandatory 前缀
- 所有承诺图存在或明确标记 blocked
- 最终分镜图数 = 最终 `CLIP###` 数;总览/拼贴图不计
- `final_image_package/image_manifest.md` 列出每张交付图及用途

## Common Mistakes

| 错误 | 纠正 |
|---|---|
| 把网格/带文字的整图当 SceneDance 唯一输入 | 主输入用 `clip_keyframes/`/`selected/` 的干净关键帧 |
| 让图像模型生成最终分镜板(带文字/表格) | 图像只出干净 panel;最终板用本地确定性排版 |
| 按固定总量均分时长(如 4×15s) | 时长按动作/情绪/信息密度,剧情驱动 |
| 边界只写"自然切/平滑转场" | 写明传递的接力棒 + 剪辑类型 + 音频桥 |
| 跳过衔接矩阵直接写提示词 | 先建 handoff/edit-boundary 矩阵再写 prompt |
| 一次 SceneDance 塞多人调度/多动作 | 用特写/插入/反应/道具拆分,一镜一事一运镜 |
| 用一张全片总览板搪塞"分镜图" | 默认逐 `CLIP###` 交付生产板 |
| 依赖 AI 插值编造跨镜连续性 | 用运镜/前景遮挡/构图延展/声音延续设计衔接 |

## 与本 app 的衔接

- 视频提示词最终经 `sd2-pe` 工程化(八大要素 + 多模态绑定 + 12 项内容 +
  五大必备块)后再交生成工具；制片包的多镜任务属于路径 B,加载
  `seedance-cinematic-format`,但标题、分段与散文形式自由；每次 Seedance 生成 4–15s。
- 端到端"做成片"由上层成片编排器负责,在其分镜阶段调用本 skill 产出制片包;单镜画面打磨交单点画面工艺技能库(两者的名称与分工见本插件入口卡 references/family-catalog.md)。

### 制片包的出口:落到视频工作台

制片包做完之后,用户常常要它**出现在「生成视频」工作台上**成为一板可逐张调参、
反复重跑的卡片。这条出口用 `catimation-video-workbench`,它给出 Shot Card 到卡片字段的
逐项映射与整板落地口径。

要点(完整规则在那份 skill 里):

- **一张卡 = 一次生成 = 一个连续节拍(4–15s)**,不一定等于一个镜头:同场景连着演完、
  总时长塞得下的几镜,可按 sd2-pe 路径 B 合成一段镜头流程放同一张卡;要独立重跑、
  各镜素材不同、时长超了或跨场景才拆卡。拆开时数组顺序即镜头顺序。
- 字段对应关系:`scenedance_prompt` → 卡片 `prompt`、`duration` → `duration`、
  `primary_input_image` → `referenceImages` 首位、`reference_images` → `referenceImages`;
  `shot_size` / `camera_movement` 并进提示词;`shot_id` 靠卡片排列顺序表达。
  `prev_transition` / `next_transition` 不映射 —— 转场是后期剪辑的事,不是单镜输入。
- 整板落地走 `video_workbench_export` → 填数组 → `video_workbench_apply` 一次写回;
  少量镜头直接 `video_workbench_add_tasks`。默认**只填不跑**,交用户过目。
- 落板前照样清点角色锚点、故事板确认、逐镜资产 —— 建卡不等于备齐资产。
