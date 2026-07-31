---
name: storyboard-to-workbench
description: >-
  Lands an existing shot list, storyboard table or create-storyboard production
  package onto the CATIMATION 视频工作台 as one board of cards. Use when the user
  already holds a script breakdown / 分镜表 / 制片包 and asks to 铺满工作台 / 排成卡片 /
  一次落板. Gives the Shot Card → card field mapping, the one-card-one-shot rule and
  the cross-card anchor discipline. Leaf skill — it does not grade tasks or render.
---

<!-- skill-budget: fast -->

# 分镜 → 视频工作台整板

把**已经存在的**分镜产物(shot list / 分镜表 / create-storyboard 制片包)一次性
落成工作台的一板卡片。本 skill 只管**映射与落地纪律**,不做任务分级、不写提示词
工程、不触发渲染 —— 那些归 catimation-video 入口和 sd2-pe。

## 什么时候用

用户手里已经有分镜产物,并且想要它出现在「生成视频」工作台上。典型说法:
「按这个分镜排卡片」「把制片包铺到工作台」「这几镜一次落板」。

**不适用**:用户只有一个想法、还没有分镜 —— 那是 catimation-video 分级之后的事,
标准级以上先排故事板给用户过,或走 create-storyboard 出制片包,再回到这里。

## 一张卡 = 一次生成 = 一个镜头

这是本 skill 存在的首要理由。Seedance 一次调用只出一段,把「镜头1…镜头2…镜头3」
写进同一张卡的提示词,模型会把它们压进 5–15 秒里,**四个镜头一个都不成立**。

N 个镜头就是 N 张卡,**数组顺序即镜头顺序**。

## Shot Card → 卡片字段映射

create-storyboard 产出的 Shot Card YAML 与工作台卡片几乎一一对应
（此处刻意不用反引号：依赖边由 create-storyboard 单向指向本 skill，反过来引用会成环）:

| Shot Card 字段 | 工作台卡片字段 | 说明 |
| --- | --- | --- |
| `scenedance_prompt` | `prompt` | 正文直接搬。若制片包里是分段结构,先按 sd2-pe 的口径连成可提交的成文 |
| `duration` | `duration` | 收敛到 4–15;`-1` 表示智能时长 |
| `primary_input_image` | `referenceImages[0]` | 首图放第一位 —— 它承担构图/画质锚点 |
| `reference_images` | `referenceImages` | 合计 ≤9 张 |
| `shot_size` / `camera_movement` | 并入 `prompt` | 卡片没有独立字段,写进提示词的运镜段 |
| `shot_id` | 卡片顺序 | 卡片本身没有 shot_id 字段,靠**排列顺序**表达;别把 S01/S02 塞进 prompt 当结构 |
| `prev_transition` / `next_transition` | 不映射 | 转场属于后期剪辑,不是单镜生成的输入 |

卡片还有几个 Shot Card 里没有、需要你决定的字段:`model`(默认 `2.0`)、
`resolution`(默认 `720p`)、`ratio`(默认 `16:9`)、`mode`(默认全能参考)、
`generateAudio`(默认开)。**默认值不等于用户确认过** —— 没确认过规格就先问,
别让默认值替用户做决定。

## 怎么落板

两条路,按镜头数选:

- **少量镜头(≤5)**:逐张 `video_workbench_add_tasks`,默认只填不跑。
- **整板(多镜、要控制顺序与分板)**:`video_workbench_export` 拿当前 IR →
  按上表填好整个数组 → `video_workbench_apply` 一次写回。数组顺序即卡片顺序,
  这是把制片包整包落地最省事的通道。注意保持 `irVersion` / `structureRevision` /
  每张卡的 `rev` 不变,否则会被拒。

**默认只填不跑。** 落板之后把结果交给用户过目,由用户或后续步骤决定何时
`video_workbench_start`。

## 落板前必须清点的三件事

来自 catimation-video 的「角色片/多镜」硬门,在工作台上一字不改地适用。建卡 ≠ 备齐资产,
「只填不跑」正是补这三样的窗口:

1. **每个复用角色有 `identity-hard` 主锚**,并且**逐字写进每一张卡的 prompt**。
   跨卡不共享上下文 —— 每次生成都是独立调用,不写就漂。
2. **故事板已经给用户过目**。用户没点头就落板,等于替他决定了镜头设计。
3. **逐镜资产齐备**。缺口先在人像库找现成,非身份关键的自己补图,身份/IP/品牌关键的
   问用户。推荐每镜 4–5 个核心素材。

## 落板之后

渲染、QA、返工都回到 catimation-video 的口径:批次跑完会主动推「[视频工作台]
批次渲染完成」,**别轮询** `video_workbench_status`。批次摘要只报成败与落盘路径,
**不代表 QA 已做** —— 人脸/复杂动作的卡照样抽九宫格,多镜剧情照样过内容 QA。
