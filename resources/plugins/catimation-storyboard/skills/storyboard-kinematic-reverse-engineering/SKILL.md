---
name: storyboard-kinematic-reverse-engineering
description: 用于反推 AI 视频或参考视频的运动学规律,避免只看图说话。适用于 视频反推、三帧分析、起始帧/爆发帧/结尾帧、相机运动结构、运动矢量、dolly/zoom/pan/truck/crane 区分、焦距变化、视差、速度、motion weight、把感性描述翻译成动作参数。
---

# Storyboard Kinematic Reverse Engineering / 运动学反推

核心信念:视频不是会动的图,而是时间和空间参数的连续变化。只给 AI 一张截图,只能得到“像这张图”的画面;要复刻视频神韵,必须反推运动过程、相机结构和矢量参数。

提炼自中文教程《拒绝“看图说话”:AI视频反推的真正逻辑—运动学解构》。参考: <https://www.super-i.cn/info-2610.html>

## 第一步:三帧定乾坤

不要只截图一帧。至少截:

- **起始帧 Setup**:动作开始前的状态。
- **爆发帧 Climax**:动作幅度最大、光影变化最剧烈的一刻。
- **结尾帧 Resolve**:动作完成后的状态。

分析指令:

```text
请不要只描述画面内容。请基于这三帧反推视频的运动学规律:
1. 主体从起始到结尾的位移方向、速度变化、加速度
2. 摄像机运动:推/拉/摇/移/升降/变焦
3. 是否存在真实视差,判断是 dolly/truck 还是 zoom
4. 焦距、景深、透视是否变化
5. 光影和环境粒子的运动方向
6. 输出可执行的视频提示词,不要写影评式散文
```

## 第二步:找相机运动结构

常见区别:

- **Dolly forward**:摄影机向前移动,前景/中景/后景有视差。
- **Zoom in**:焦距变化,画面放大但没有真实视差。
- **Truck left/right**:摄影机横向移动,前景遮挡产生快速位移。
- **Pan left/right**:原地摇镜,空间位置不变。
- **Crane up/down**:机位上下移动,地平线和透视关系改变。
- **Orbit**:围绕主体环绕,背景相对主体旋转。

输出时用结构化参数:

```text
Camera: dolly forward + slight crane up
Lens: wide angle, perspective changes visibly
Motion: subject moves from left-lower frame to center, acceleration high
Parallax: foreground moves fastest, background moves slowest
```

## 第三步:感性描述翻译成参数

不要把“飞鸟般掠过海面”直接喂回模型。翻译:

| 感性描述 | 参数化指令 |
|---|---|
| 镜头平移浏览场景 | Camera Move: Pan Right / Horizontal Pan |
| 飞速穿梭 | Dolly Forward: Fast + Motion Blur: High |
| 画面张力剧烈 | Motion Weight: 8 / Chaos: 20 |
| 时间流逝 | Speed: 2.0 / Lighting: Time-lapse |
| 逼近压迫 | Dolly in + low angle + increasing subject scale |

示例:

```text
Subject: cyberpunk city street, neon lights.
Action: hyper-lapse forward through traffic.
Camera: fast dolly forward, low angle, strong parallax from foreground signs.
Motion: high motion blur, light trails stretch backward.
Lens: 20mm wide angle, perspective distortion increases speed and scale.
```

## 反推输出模板

```text
运动摘要:
- 主体运动:
- 镜头运动:
- 速度曲线:
- 视差:
- 焦段/景深:
- 环境粒子/光影:

可执行视频 prompt:
[主体] + [动作矢量] + [相机运动] + [速度/时间] + [镜头参数] + [环境运动]
```

## 出稿前检查

- 是否使用三帧,而不是单张截图?
- 是否区分 dolly 和 zoom?
- 是否输出相机运动参数,而不是影评散文?
- 是否描述主体、镜头、环境三套运动?
- 是否把抽象震撼感翻译成可执行的速度/视差/焦段?
