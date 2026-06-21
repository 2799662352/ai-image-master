# 制作包目录与命名规范

## 1. 项目目录结构

每个剧本项目输出到：

```text
storyboard_projects/<project-slug>/
├── 01_script_brief/
│   ├── script.md
│   ├── script_analysis.md
│   └── project_brief.md
├── 02_bibles/
│   ├── character_bible.md
│   ├── product_prop_bible.md
│   ├── scene_bible.md
│   ├── style_bible.md
│   └── continuity_bible.md
├── 03_storyboard/
│   ├── master_storyboard.md
│   ├── shot_cards.md
│   ├── clip_plan.md
│   ├── shot_motion_budget.md
│   ├── reference_input_matrix.md
│   ├── handoff_design_matrix.md
│   ├── edit_boundary_matrix.md
│   ├── seedance_segments.md          # 旧项目兼容
│   └── transition_matrix.md          # 旧项目兼容
├── 04_prompts/
│   ├── img2_zh.md
│   ├── img2_en.md
│   ├── scenedance_shot_prompts.md
│   ├── scenedance_clip_prompts.md     # 旧命名兼容，内容指向 shot prompts
│   ├── seedance_prompts.md            # 旧项目兼容
│   ├── transition_prompts.md
│   └── negative_prompts.md
├── 05_images/
│   ├── zh/
│   ├── en/
│   ├── selected/
│   └── references/
├── 06_delivery/
│   ├── scenedance_usage_list.md
│   ├── seedance_usage_list.md         # 旧命名兼容
│   ├── edit_continuity_notes.md
│   ├── post_edit_plan.md
│   ├── risk_fallback_plan.md
│   └── jianying_edit_list.md
└── final_image_package/
    ├── clip_storyboards/
    │   └── panels/                    # 干净分镜板视觉源，不是最终 board
    ├── clip_keyframes/
    ├── storyboards_15s/               # 旧项目兼容
    ├── seedance_keyframes/            # 旧项目兼容
    ├── transition_bridges/
    ├── support_assets/
    └── image_manifest.md
```

## 2. 默认生产逻辑

- 新项目默认 `SH### = CLIP###`：一个电影镜头对应一次 SceneDance 生成。
- `CLIP###` 必须 `<=15s`，时长根据剧情、动作复杂度、情绪节奏和信息量决定。
- 只有低风险插入镜头、同一机位微表演或用户明确要求时，才允许一个 `CLIP###` 覆盖多个 `SH###`，且必须在 `clip_plan.md` 说明原因。
- 用户要求“分镜图 / 重新生成分镜图 / SceneDance 输入图”时，默认交付单位是 `CLIP###`，不是全片总览图。
- 全片总览图、master storyboard sheet、contact sheet 只能作为审阅辅助，不能计入最终 `CLIP###` 分镜图交付，也不能作为 SceneDance 主输入。
- 最终 `clip_storyboards/` 必须是生产分镜板，不是图片模型直接生成的氛围板、海报、空 caption 三格图或全片概念图。
- 图片模型只能生成干净视觉源：start panel、key-action panel、edit-out panel、handoff panel 或 clean keyframe；最终 board 的排版和可读文字必须由本地确定性渲染生成。
- 如果两镜合并使用，必须先在 `clip_plan.md` 合并成一个明确的 `CLIP###`；然后为这个合并 clip 生成一张干净起始关键帧和一张单 clip 生产分镜板。不要把两格或多格分镜表作为 SceneDance 主图。
- 每个镜头必须先有动作起点、动作终点、情绪起点、情绪终点、接棒入点、交棒出点和剪辑出点，再写 SceneDance 提示词。
- 相邻镜头先设计镜头接力，再设计剪辑边界，再生成关键帧。默认使用可剪辑边界，不默认要求首尾帧严格连续。
- 镜头接力原则：上一 clip 结尾必须交代下一 clip 的空间、运动、视觉线索、遮挡载体或声音线索；下一 clip 开头必须接住这个线索。不能只写“自然衔接”。

## 3. ID 规则

| 类型 | 格式 | 示例 | 说明 |
| --- | --- | --- | --- |
| 角色 | `C###` | `C001` | 人物或拟人角色 |
| 场景 | `S###` | `S001` | 地点、空间、时间状态 |
| 产品 / 道具 | `P###` | `P001` | 产品、武器、载具、关键物件 |
| 镜头 | `SH###` | `SH001` | 电影镜头，默认也是一次视频生成 |
| SceneDance Clip | `CLIP###` | `CLIP001` | SceneDance 生成片段，默认与 `SH###` 一一对应 |
| 镜头接力 | `HO_<CLIP_A>_<CLIP_B>` | `HO_CLIP001_CLIP002` | 相邻片段的交棒/接棒设计 |
| 旧 Seedance 段 | `SEG###` | `SEG001` | 旧项目兼容，不作为新项目默认 |
| Clip 关键帧 | `KF_<CLIP>_<role>` | `KF_CLIP001_start` | `start` / `key` / `out` |
| 剪辑边界 | `EB_<CLIP_A>_<CLIP_B>` | `EB_CLIP001_CLIP002` | 相邻片段的剪辑边界 |
| 动作姿势 | `A_<character>_<action>` | `A_C001_turn_head` | 起始 / 中间 / 结束动作参考 |
| Clip 分镜图 | `<CLIP>_storyboard_<time-range>` | `CLIP001_storyboard_0-6s` | 制片审阅图，不是唯一视频主输入 |

## 4. 图片命名

```text
05_images/zh/<image-id>__zh__v01.png
05_images/en/<image-id>__en__v01.png
05_images/selected/<image-id>__selected.png
05_images/references/<source-name>.png
final_image_package/clip_storyboards/<CLIP###>_storyboard_<time-range>.png
final_image_package/clip_storyboards/panels/<CLIP###>_<start|key|out|handoff>.png
final_image_package/clip_keyframes/<keyframe-id>.png
final_image_package/transition_bridges/<boundary-id>_<role>.png
final_image_package/support_assets/<asset-id>.png
```

要求：

- 中文提示词生成图放 `05_images/zh/`。
- 英文提示词生成图放 `05_images/en/`。
- 最终用于 SceneDance 的干净输入图整理到 `05_images/selected/` 和 `final_image_package/clip_keyframes/`。
- 干净 storyboard panel 源图保存到 `final_image_package/clip_storyboards/panels/`。
- 最终 clip 生产分镜板保存到 `final_image_package/clip_storyboards/`，一 clip 一张。
- 分镜图可用于审阅和低权重参考；SceneDance 主输入优先使用干净 keyframe。
- 生产分镜板必须包含可读的 `CLIP ID`、时间范围、`START / KEY ACTION / EDIT OUT`、镜头方法、动作起止、接力线索、剪辑边界、音频桥、参考图组合和风险/备用方案。
- 生产分镜板的文字字段必须来自 `clip_plan.md`、`shot_cards.md`、`handoff_design_matrix.md`、`edit_boundary_matrix.md` 或 `scenedance_shot_prompts.md`；不要依赖图片模型生成可读文字。
- 如需总览图，单独保存到 `final_image_package/overview_boards/` 或写入 manifest 的 review-only 区域，不能替代 `clip_storyboards/`。
- 文件名必须包含图片 ID、语言版本和版本号；失败图使用 `v02`、`v03` 递增，不覆盖。

## 5. 必填文件职责

| 文件 | 作用 |
| --- | --- |
| `script_analysis.md` | 提炼剧情 beat、情绪转折、动作复杂点、潜在剪辑点 |
| `continuity_bible.md` | 锁定人物、服装、道具、空间、轴线、视线、方向、光线、天气、色调和画幅 |
| `shot_cards.md` | 每个镜头一张生产卡，含 YAML 必填字段和可执行说明 |
| `reference_input_matrix.md` | 每个 SceneDance 镜头要喂哪些参考图，以及为什么 |
| `handoff_design_matrix.md` | 每个相邻片段的尾部交棒、头部接棒、空间入口、运动方向、遮挡载体、视觉桥和声音桥 |
| `edit_boundary_matrix.md` | 每个相邻片段的剪辑方式、匹配依据、音频桥接和备用切法 |
| `scenedance_shot_prompts.md` | 每镜头视频生成提示词，含动作起止、情绪起止、出点和负面约束 |
| `post_edit_plan.md` | 后期拼接、J-cut/L-cut、音效、音乐、裁切余量和剪映处理 |
| `risk_fallback_plan.md` | 每镜头生成风险、失败判定和重生/改切/插入镜头备用方案 |

## 6. Shot Card YAML Schema

每个 shot card 必须包含：

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
reference_images: []
scenedance_prompt: ""
prev_transition: ""
next_transition: ""
edit_notes: ""
risks: []
fallback_plan: ""
```

## 7. 镜头接力原则

- 每个相邻 `CLIP### -> CLIP###` 必须先填写一行 `handoff_design_matrix.md`。
- 上一 clip 不能只完成自己的动作；结尾必须提前交代下一 clip 的前景、入口、运动方向、空间线索、光线/色块/形状、道具、UI 或声音。
- 下一 clip 不能凭空开始；开头必须接住上一 clip 的遮挡、光线、形状、方向、视线、动作、道具或声音。
- 常用接力方式：人物/物体擦镜、门框/黑场遮挡、走廊/窗/屏幕作为空间入口、同向运动、同形构图、同色光源、道具特写、UI 弹窗、环境声/J-cut/L-cut。
- 如果选择硬切，必须说明它是有意的节奏冲击、情绪断裂或信息跳转，而不是缺少接力设计。

## 8. 剪辑边界原则

- 每个相邻 `CLIP### -> CLIP###` 必须填写一行边界。
- 默认使用可剪辑边界，不强求首尾帧连续。
- 优先选择：动作接动作、视线匹配、方向匹配、构图匹配、景别递进、反应镜头、插入镜头、道具特写、空镜、遮挡切、硬切、J-cut、L-cut。
- 必须写清：引用的接力 ID、前段出点、后段入点、剪辑类型、匹配依据、音频桥、是否需要首尾帧匹配、剪映处理建议、风险、失败时改切方案。
- 若连续动作必须跨片段完成，才准备桥接关键帧或严格首尾帧匹配。

## 9. 镜头运动选择原则

- 每个 clip 仍只写一个主要镜头运动，但不能默认反复使用固定镜头或推镜。
- 先判断镜头目的：交代空间、跟随动作、制造遮挡、接住视线、展示产品、强化情绪、隐藏 AI 跳变，再选择镜头方法。
- 可选方法包括：固定观察、缓慢推进、拉远揭示、横移跟拍、随行跟拍、前景遮挡推进、主观 POV、过肩、低/高机位、手持微晃、门框窥视、道具引导、光源引导、UI 前景遮挡。
- 复杂绕行、大幅升降、多人交叉调度、连续多次变焦或多机位感剪切不适合作为单个 SceneDance clip 的默认动作。

## 10. 制作顺序

1. 确认画幅、目标时长、平台、类型、风格、主要角色/产品。
2. 做 `script_analysis.md`：按场、beat、动作复杂度和情绪转折拆解。
3. 建立角色、场景、道具、风格和连续性 bible。
4. 先列资产生成清单：人物 360、表情、动作 pose、场景建立/反打、道具/产品、关键帧、分镜 panel 源图、最终生产分镜板。
5. 创建 `shot_cards.md`：默认一镜一片段，逐镜头设计时长、起止动作、起止情绪、接棒入点、交棒出点和剪辑目的。
6. 创建 `reference_input_matrix.md`：每镜头列主输入 keyframe 和辅助参考图组合。
7. 创建 `handoff_design_matrix.md`：先解决上一镜头如何递出下一镜头、下一镜头如何接住。
8. 创建 `edit_boundary_matrix.md`：基于接力矩阵解决镜头之间怎么剪，再生成图片。
9. 写 Image 2 中英文提示词，语言分开。
10. 生成或整理参考图，先支持资产，再 clean keyframes，再干净 storyboard panels，最后用确定性本地排版生成 clip storyboard boards。
11. 写 SceneDance shot prompts 和后期剪辑清单。
12. 写风险与备用方案。
13. 输出 image manifest 并验证 promised images。

## 11. 验证清单

- 每个 `CLIP###` 都 `<=15s`。
- 默认 `SH### = CLIP###`，例外已说明。
- 每个 shot card 都有完整 YAML 必填字段。
- 每个镜头都有动作起点/终点和情绪起点/终点。
- 每个镜头都有接棒入点、交棒出点、运动方向、空间桥、遮挡载体、视觉桥和接力风险控制。
- 每个镜头都有主输入 keyframe 和辅助参考图组合。
- 每个相邻边界都有镜头接力设计，且不是空泛的“自然衔接”。
- 每个相邻边界都有剪辑类型、匹配依据、音频桥和失败备用。
- 连续性 bible 覆盖人物、服装、发型、道具、空间、轴线、视线、方向、光线、天气、时间状态、色调、画幅。
- 分镜图没有被当成唯一 SceneDance 主输入。
- 最终分镜板不是 raw AI-generated board layout；必须由干净 panel/keyframe 确定性排版生成。
- 每张最终分镜板必须有可读 `CLIP ID`、时间范围、START/KEY ACTION/EDIT OUT、镜头/动作/剪辑/音频/参考图/风险信息，不能有空 caption、乱码字、缺时间码、混多个 clip、海报式单图冒充分镜。
- `final_image_package/clip_storyboards/` 中的最终分镜图数量等于最终 `CLIP###` 数量；总览图不计入。
- 中文和英文 Image 2 提示词分开。
- 所有 promised images 在 manifest 中有路径和状态。
