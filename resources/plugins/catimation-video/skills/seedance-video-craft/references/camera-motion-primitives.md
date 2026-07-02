# 运镜基元词表(CameraBench-Pro 真实 taxonomy)

> **来源与可信度:** 本词表**逐条来自** CameraBench-Pro 官方公开的 test 分片标注文件
> `georgeliu59/CameraBench-Pro`(HuggingFace,938 视频 / 245 标签,作者 = CHAI 论文组 George Liu、Siyuan Cen)。
> 本地已下载标注 jsonl(不含视频):`D:\tecx\text\videos\CameraBench\CameraBench-Pro.jsonl`。
> 245 个标签 ≈ 官网宣传的「225 电影基元 + 若干二元判别任务」;按前缀归入 **17 个技能类**(下)。
> 前身 CameraBench(NeurIPS'25 Spotlight,arXiv 2504.15376,~50 基元)的微调 VLM 可用来自动打这些标签:
> `chancharikm/qwen2.5-vl-{7b,32b,72b}-cam-motion`。
>
> **用法:** 写 Seedance 运镜/机位提示词时,从下面挑**精确的电影术语**填进 prompt,而不是写「镜头动一下」。
> 这是 `sd2-pe` 八大要素里「运镜/机位」那一格的**受控词表**,不替代 sd2-pe,只提供准确用词。

---

## 一、平移 Translation(相机整体位移)

| 术语 | 含义 | prompt 用词 |
|---|---|---|
| **dolly in / out** | 相机前进 / 后退(forward / backward motion) | dolly in, dolly out, push in, pull back |
| **pedestal up / down** | 相机垂直升 / 降(机身平移,非俯仰) | pedestal up, pedestal down, boom up/down |
| **truck left / right** | 相机水平左 / 右移(横移,非摇) | truck left, truck right, crab left/right |
| **crane up / down** | 摇臂大幅升降(比 pedestal 幅度大) | crane up, crane down, jib up/down |

> 判别陷阱(数据集显式区分):`pan-left` ≠ `truck-left`(摇 vs 横移)、`tilt-down` ≠ `pedestal-down`(俯仰 vs 升降)。写 prompt 时选对那一个。

## 二、旋转 Rotation(相机绕自身轴)

| 术语 | 含义 | prompt 用词 |
|---|---|---|
| **pan left / right** | 绕垂直轴左右摇 | pan left, pan right |
| **tilt up / down** | 绕水平轴上下俯仰 | tilt up, tilt down |
| **roll cw / ccw** | 绕光轴顺 / 逆时针滚转 | roll clockwise, roll counterclockwise |

## 三、变焦 / 内参 Intrinsic

| 术语 | 含义 | prompt 用词 |
|---|---|---|
| **zoom in / out** | 焦距变化(镜头内参,机身不动) | zoom in, zoom out |
| **dolly-zoom in / out** | 推轨 + 反向变焦(Vertigo/眩晕效果) | dolly zoom, vertigo effect |

## 四、弧形 / 环绕 Arc

| 术语 | 含义 | prompt 用词 |
|---|---|---|
| **arc clockwise / ccw** | 绕主体或画面中心做圆周运动 | arc shot, orbit clockwise, orbit counterclockwise |

## 五、跟拍 Tracking(7 种,按机位关系)

| 术语 | 含义 |
|---|---|
| **lead-tracking** | 从前方引导拍(相机在主体前) |
| **tail-tracking** | 从后方尾随拍 |
| **side-tracking**(front-side / rear-side) | 从侧面跟(偏前 / 偏后) |
| **aerial-tracking** | 空中/航拍跟拍 |
| **arc-tracking / pan-tracking / tilt-tracking** | 用弧形/摇/俯仰完成的跟拍 |
| **focus-tracking** | 焦点跟随主体 |
| **tracking-subject-larger / smaller** | 跟拍中主体在画面里变大/变小 |

## 六、稳定度 Steadiness

| 术语 | 含义 | prompt 用词 |
|---|---|---|
| fixed vs moving | 相机固定 / 移动 | locked-off shot, static camera / moving camera |
| stable vs shaky | 稳 / 抖 | stabilized, smooth / handheld, shaky |
| fixed-camera shaking | 固定机位但有轻微抖动 | subtle handheld shake |

## 七、速度 / 时间 Speed & Time

| 术语 | prompt 用词 |
|---|---|
| regular speed | normal speed |
| **slow-motion** | slow motion |
| **fast-motion**(含无延时的快动) | fast motion |
| **time-lapse** | time-lapse |
| **speed-ramp** | speed ramp(变速) |
| **stop-motion** | stop motion |
| **time-reversed** | reverse footage |
| **frame-freeze** | freeze frame |

## 八、机位角度 Camera Angle(俯仰视角)

`bird-eye`(鸟瞰) · `high`(俯) · `level`(平) · `low`(仰) · `worm-eye`(虫视)
— 数据集含 `start_with` / `end_with` / `change`(如 high→low、level→high),即**角度转场**也是基元。

## 九、离地高度 Height w.r.t. Ground(机位物理高度)

`aerial`(航拍高度) · `overhead`(头顶) · `eye`(眼平) · `hip`(腰胯) · `ground`(贴地) · `water`(水面) · `underwater`(水下)
— 含高度转场(low↔high)。

## 十、相对主体高度 Height w.r.t. Subject

`above-subject` / `at-subject` / `below-subject`(及彼此转场)。

## 十一、景别 Shot Size(8 级)

`extreme-close-up` → `close-up` → `medium-close-up` → `medium` → `medium-full` → `full` → `wide` → `extreme-wide`
— 含 `change`(large↔small,如 wide→close-up 的推近)。

## 十二、对焦 Focus

- 焦平面所在:`background` / `middle-ground` / `foreground` / `out-of-focus`(含彼此转移)
- **rack / pull focus**(变焦点)、`focus-tracking`(焦点跟随)
- 景深:`deep-focus` / `shallow-focus` / `ultra-shallow-focus`

## 十三、荷兰角 Dutch Angle

`dutch-angle`:`fixed`(固定倾斜) / `varying`(倾斜变化)。prompt: dutch angle, canted angle。

## 十四、镜头畸变 Lens Distortion

`fisheye-distortion` / `with-lens-distortion`。prompt: fisheye lens, wide-angle distortion。

## 十五、POV 视角类型

`drone` · `dashcam` · `first-person` · `selfie` · `broadcast` · `screen-recording` · `locked-on` · `objective` · `overhead` ·
第三人称游戏视角:`over-shoulder` / `over-hip` / `side-view` / `top-down` / `isometric` / `full-body`。

## 十六、主体 / 画面类型 Shot & Subject Type

`single-dominant-subject`(单一主导主体) / `many-subjects`(多主体) / `scenery`(空镜/风景) / `human` / `non-human` ;
主体事件:`subject-revealing`(揭示) / `subject-disappearing`(消失) / `subject-switching / subject-change`(切换) / `framing-subject`(构图锁定)。

## 十七、转场与特殊 Transitions & Special

`shot-transition`(机位切换/剪切) · `above-water↔underwater`(出入水) · `overlays`(叠加层/字幕UI) · `motion-blur`(运动模糊) · `has-frame-freeze`(定格)。

---

## 落地到 Seedance 提示词的三条纪律

1. **一个主导运镜 + 至多一个修饰**:如「slow dolly-in, subtle pan-right」。别把 5 个运镜堆一句(违反本 skill 的「单一主导动作」)。
2. **选对判别对**:数据集专门区分 `pan` vs `truck`、`tilt` vs `pedestal`、`zoom`(内参)vs `dolly`(位移)。写错术语 = 出错运动。
3. **机位三件套一起写**:角度(第八类)+ 离地高度(第九类)+ 景别(第十一类),比只写「low angle」信息量大得多,Seedance 更可控。

> 需要**自动识别**一段参考视频的运镜来复刻时,可提示用户用 `chancharikm/qwen2.5-vl-7b-cam-motion`(Qwen2.5-VL 用法)对视频打上述标签,再把标签翻成 prompt。
