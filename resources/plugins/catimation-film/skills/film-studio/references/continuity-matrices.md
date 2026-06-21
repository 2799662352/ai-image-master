# 连续性矩阵 · 门内校验参考

> 本文件是 `film-studio` 的**门内校验参考**(列定义 + schema + 校验清单),蒸馏自 `catimation-storyboard-pro` 的 `create-storyboard`。**完整制片包仍由 `create-storyboard` 产出**;此处只给 film-studio 在 G3/G4.5 检查衔接/边界/输入图三类是否填齐时对照用。

## 一、衔接设计矩阵 `handoff_design_matrix`(每对相邻镜一行)

刻意设计的镜头接力:上一镜结尾埋线索,下一镜开头接住。每对相邻镜必须填齐以下列:

| 列 | 含义 |
|---|---|
| prior_clip_gives | 上一镜结尾交出的接力棒(运动/前景/光线/色彩/门口/UI 层/声音/空间线索) |
| next_clip_receives | 下一镜开头接住的同一接力棒 |
| spatial_in_out | 空间出入(从哪进、往哪出,屏幕左右/纵深) |
| motion_direction | 运动方向(与相邻镜在空间上是否一致) |
| occlusion_carrier | 遮挡载体(门框/身体/货架/烟雾/雨/车辆/UI 层) |
| visual_bridge | 视觉桥(可继承的构图元素/色场/光位) |
| audio_bridge | 音频桥(对白/环境声/音乐/脚步/物件声/撞击声跨片段) |
| edit_type | 剪辑类型(见下表) |
| needs_frame_match | 是否需严格首尾帧匹配(默认否,仅动作必须真连续时是) |
| capcut_handling | 剪映/CapCut 后期处理 |
| fallback_cut | 回退切方案 |

**铁律:** 边界不能只写"自然切/平滑转场/硬切",除非衔接设计写明传递的接力棒,或该镜明确选择刻意跳切/情绪断裂。

## 二、剪辑边界矩阵 `edit_boundary_matrix`(每对相邻镜一行)

从衔接矩阵推导。默认策略是**可剪连续性**,不是严格帧连续。每个边界须含:剪辑类型 + 匹配逻辑 + 音频桥 + CapCut 处理 + 风险 + 回退,并引用对应的衔接逻辑。

连续性剪辑类型清单:

- 动作匹配(match on action:手伸出→切道具特写;头转→切反应/POV)
- 视线匹配(eyeline match:角色看画外→切其所见)
- 屏幕方向匹配(screen-direction:左右进出保持空间意义)
- 景别节奏(远→中→近定位/动作/情绪;近→插入细节;反应镜吸收断点)
- 反应镜(reaction)
- 插入镜(insert)
- 空镜/cutaway
- 遮挡切(occlusion cut)
- 硬切(hard cut)
- J-cut(声先入)/ L-cut(声后延)
- 尽量留 `0.5-1s` 剪辑余量以裁切生成的首尾。

## 三、Shot Card YAML Schema(每镜必填键)

每张 shot card 是可读 Markdown + 含以下必填键的 YAML 块:

```yaml
shot_id: SH001
clip_id: CLIP001
scene_id: S001
purpose: ""
duration: ""          # 剧情驱动,不均分;≤15s
shot_size: ""
camera_movement: ""   # 一镜一主运镜
composition: ""
character_state: ""
action_start: ""      # 动作起
action_end: ""        # 动作止
emotion_start: ""     # 情绪起
emotion_end: ""       # 情绪止
receiver_in: ""       # 接棒入点
handoff_out: ""       # 交棒出点
motion_vector: ""
spatial_bridge: ""
occlusion_carrier: ""
visual_bridge: ""
handoff_risk_reduction: ""
reference_images: []  # 每镜必有主干净输入图 ID
scenedance_prompt: ""
prev_transition: ""
next_transition: ""
edit_notes: ""
risks: []
fallback_plan: ""
```

## 四、交付前校验清单(聚焦衔接/边界/输入图三类)

film-studio 资产门(G4.5)校验时对照:

**输入图类:**
- 每镜有主干净输入关键帧 ID,并列出参考图组合(角色/场景/道具/分镜)
- 分镜板不被当作唯一 SceneDance 视频输入;主输入是干净关键帧
- 复用角色/产品/场景用圣经 ID

**衔接类:**
- 每对相邻镜有一行衔接设计(handoff)
- 每镜有 `receiver_in`/`handoff_out`/`motion_vector`/`spatial_bridge`/`occlusion_carrier`/`visual_bridge`/`handoff_risk_reduction`

**边界类:**
- 每对相邻镜有一行剪辑边界
- 每个边界有剪辑类型、匹配逻辑、音频桥、CapCut 处理、风险、回退,并引用衔接逻辑
- 边界不只写"自然切/平滑转场"

**通用:**
- 无 SceneDance clip 超过 `15s`;每镜默认 `SH### = CLIP###`
- 每镜有动作起止与情绪起止
- 视频提示词最终经 `sd2-pe` 工程化

> 需要逐镜画面工艺(9 维填充/LUT/情绪生理)时,见 `catimation-storyboard` 的 `storyboard-grid-to-seedance/references/`;需要一张图出整套分镜的网格法时,用 `storyboard-grid-to-seedance`。
