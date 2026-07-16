# 电影/剧情演出美术设定板

## 用途

把场景美术、故事节拍、机位、角色、材质与灯光放在一张总览板中，供导演评审、
美术/摄影/灯光对接和后续 AI 资产生成。它是**项目级沟通资产**，不是视频的身份
锚点、首帧或精确时间线。

不是每个视频请求都必须生成本板；但用户/制片流程一旦选择交付本板，视觉层与
确定性信息层都必须完成。只要本板被加入视频参考，视频提示词必须带“提示词主导 /
氛围板低约束”职责前缀，不能省略。

## 先选一种成品比例

- 默认横版：`3840×2160`（16:9）。
- 需要超宽银幕时：改用 21:9 对应尺寸，不要同时要求“3840×2160 且 21:9”。
- 屏幕交付以像素尺寸为准；300 DPI 只是打印元数据，不能替代真实像素。

## 必须双层交付

### A. 图像模型视觉层

图像模型生成：

- 俯视场景概念图、立面/剖面视觉、镜头缩略图。
- 角色造型、关键道具、材质样片、灯光气氛和色板。
- 电影美术设定图的整体质感、层次和视觉统一。

避免让图像模型承担关键生产文字。它生成的标题、尺寸、中文/日文说明可能乱码，
只能作为装饰草稿。

### B. 本地确定性信息层

用 HTML/CSS、Canvas、设计工具或其它可控排版方式叠加：

- 项目/场次标题、镜头编号、机位编号和方向箭头。
- 房间尺寸、层高、道具尺寸、角色尺度。
- 镜头景别、动作、运镜、情绪和对应机位。
- 材质名称、灯光类型/方向/色温、剧情摘要和情绪递进。

最终生产板的可读文字必须来自确定性信息层。

## 必需版式

1. **顶部标题栏**：项目名、场次、题材、整体调性、核心场景标签。
2. **左上主视觉区**：俯视平面图；黄色三角 + 编号标机位；引线标场景元素。
3. **右上镜头表**：3×3 或按镜数自适应的缩略图网格；每格对应一个镜头节拍。
4. **中部结构区**：关键方向立面图 + A-A 剖面图；标层高、道具与人物关系。
5. **底部美术区**：材质、装饰、关键道具、灯光方向、色温与气氛效果。
6. **侧栏扩展区**：角色身份/造型/本场状态、剧情摘要、主题、情绪递进。

## 可填 brief

```yaml
project:
  name: ""
  scene_title: ""
  scene_number: ""
  genre: ""
  style_tone: ""
  core_scene_tag: ""

space:
  dimensions: { width: "", depth: "", height: "" }
  floor_material: ""
  wall_material: ""
  fixed_elements: []
  key_props: []

shots:
  - shot_id: SH01
    camera_marker: "①"
    shot_type: ""
    action_beat: ""
    camera_movement: ""
    emotion_tone: ""

characters:
  - id: C01
    role_in_scene: ""
    identity_anchor: ""
    costume: ""
    physical_state: ""
    blocking: ""

materials:
  - id: M01
    name: ""
    usage_position: ""
    visual_reference: ""

lights:
  - id: L01
    type: ""
    direction: ""
    color_temperature: ""
    atmosphere_effect: ""

narrative:
  summary: ""
  themes: []
  emotional_arc: ""
```

## 图像模型视觉层提示词

```text
Create a professional cinematic art-direction board for [project / scene].
Landscape [16:9 or 21:9], concept art board + technical blueprint language.

Layout:
- top title strip with aligned Chinese/English/Japanese typography zones
- upper-left top-down scene plan with yellow triangular camera markers, numbered
  marker slots, direction arrows, and leader-line callouts
- upper-right [3×3 / adaptive] shot-thumbnail board, left-to-right reading order
- middle elevation and section studies showing scale and spatial depth, with
  dimension-line and section-label zones
- bottom material, prop, lighting, and color-palette studies with thumbnail +
  caption-card layout
- side area for character and narrative visual motifs with aligned info cards

Visual content:
- scene: [location / era / dimensions / fixed elements]
- characters: [stable appearance / costume / blocking]
- shot beats: [SH01...SH0N, one visible action beat per thumbnail]
- materials and props: [list]
- lighting: [source / direction / color temperature / contrast]
- palette and film texture: [list]

Professional production-document composition, disciplined hierarchy, generous
spacing, aligned rich-annotation modules, stable perspective, coherent character
identity. Generate the visual board, marker shapes, callout lines, and typography
zones; exact production labels, dimensions, shot text, and multilingual copy are
replaced/overlaid deterministically afterward. No watermarks, no random captions,
no JSON or code characters.
```

## 作为视频参考时的职责声明

```text
[提示词主导 / 氛围板低约束]
@图片N 是电影美术设定板，仅参考色彩、光线、材质、时代感、空间气质和视觉母题。
最终故事、构图、动作、顺序、时长和导演调度以文字提示词为主；不复制拼贴版式、
边框、编号、文字或表格，不把它作为首帧，也不要求最终视频与板内镜头完全一致。
角色身份以 @图片A / @图片B 为准，当前片段构图以干净关键帧 @图片C 为准。
```

设定板只提供 `atmosphere-loose` 参考，这段职责声明只要使用本板就必须写。需要
复刻某个镜头缩略图时，先把该格裁出、清理文字和边框，重绘为干净关键帧，再单独绑定。

## 终检

- 视觉层与信息层是否分开，生产文字是否可读？
- 机位编号与镜头编号是否一一对应？
- 平面、立面、剖面中的空间和尺寸是否互相矛盾？
- 人物、服装、道具、光源方向是否跨模块一致？
- 16:9 与 21:9 是否只选择了一种？
- 用于视频时是否明确写了 `prompt-primary / identity-hard / keyframe-strong /
  atmosphere-loose / director-free` 五类职责和 mandatory 前缀？
