---
name: storyboard-foreground-occlusion
description: 用于通过前景遮挡去除 AI 画面的塑料感、真空感、壁纸感、证件照感,建立机位感、Z轴空间、偷窥感、空气透视和电影感。适用于 AI生图、图生视频、Midjourney、NanoBananaPro、Kling、Hailuo、Seedance、前景遮挡、物理遮挡、氛围遮挡、丁达尔效应、微尘、薄雾、景深、电影构图。
---

# Storyboard Foreground Occlusion / 前景遮挡电影感

核心信念:很多 AI 画面不是不真实,而是太干净、太直接、太像“全知视角”。电影感常来自合理的前景遮挡:它告诉观众摄影机在哪里,并在二维画面里制造 Z 轴深度。

这个 skill 提炼自中文教程《告别塑料AI味!两大前景遮挡神技,一键解锁电影感》。参考: <https://www.super-i.cn/info-2690.html>

## 两类前景遮挡

1. **物理遮挡前景**:树叶、门框、柱子、玻璃、路人肩膀、窗帘、车窗边缘。
2. **氛围遮挡前景**:薄雾、雪花、雨丝、灰尘、花瓣、烟、空气颗粒、丁达尔光。

前景不是装饰,而是叙事介质。

## 方法一:物理遮挡建立机位感

弱写法:

```text
一个美丽女孩穿白裙站在森林里,电影光效,8k。
```

问题:只有主体,没有摄影机位置,像高清壁纸。

强写法:

```text
摄影机藏在热带大芭蕉叶后方,极度虚化的深绿色叶片从画面左前景遮挡三分之一画面;中景里白裙女孩站在森林光斑中,她没有看向镜头,远处树干和晨雾形成背景层次,浅景深让前景叶片成为柔软的视觉遮挡。
```

## 遮挡提示词公式

```text
[摄影参数] + [极度虚化前景/叙事介质] + [中景主体与动作] + [背景环境] + [胶片/色彩质感]
```

示例:

```text
Medium close-up, shot on ARRI Alexa 35, Leitz Summilux-C lens. A blurred textured marble pillar edge occupies the left foreground like a dark silhouette, as if the camera is peeking from behind it. In the midground, an elegant woman makes a tense phone call in a dim high-end hotel lobby. Background practical lights glow softly, shallow depth of field, rich cinematic color, subtle film grain.
```

## 遮挡物必须符合环境逻辑

不要乱加:

- 室内硬加森林树叶
- 沙漠硬加带水滴玻璃
- 古装宫殿硬加现代车窗
- 雪地硬加热带植物

用环境里本来就合理存在的东西:

- 酒店:柱子、玻璃门、灯罩、路人肩膀
- 森林:叶片、树干、枝条、雾气
- 室内书房:门框、窗帘、书架边缘、台灯灯罩
- 城市街道:车窗、雨伞、行人、霓虹反光
- 雪地:飞雪、呼气白雾、衣角、枯枝

## 方法二:氛围遮挡让空气被看见

如果画面像真空,就让空气里有介质。光必须有可见路径:

```text
late afternoon sunlight enters through the window, visible Tyndall effect, atmospheric haze, dust motes floating and glowing in the foreground, soft volumetric light beams, distant background contrast gently reduced by air perspective
```

中文写法:

```text
黄昏阳光从窗户斜射进来,空气中有可见的丁达尔光束;前景漂浮着失焦发光微尘,薄雾让远处书架对比度降低,人物被柔和的空气介质包裹。
```

## 避免过度干净

少写:

- clean sharp focus
- perfectly clear air
- ultra clean
- every detail visible

多写:

- atmospheric haze
- dust motes
- light particles
- soft foreground blur
- air perspective
- translucent mist
- rain streaks / snowflakes / floating petals

## 图生视频前景技巧

如果首帧有前景遮挡,视频 prompt 只需驱动轻微视差:

```text
镜头缓慢向前推进,掠过左侧虚化的大理石柱边缘;柱子在前景产生自然位移,中景女人继续低声打电话,背景灯光保持柔和失焦。
```

或氛围遮挡:

```text
空气中的发光微尘缓慢漂浮,窗外光束轻微晃动;人物几乎不动,只轻轻呼吸,镜头保持安静。
```

## 出稿前检查

- 画面是否只有主体和背景,没有前景?
- 前景遮挡是否说明了摄影机位置?
- 遮挡物是否符合场景逻辑?
- 是否有 foreground / midground / background 三层?
- 是否用浅景深让前景虚化,而不是抢主体?
- 空气是否有介质:雾、尘、雨、雪、花瓣、烟?
- 图生视频是否利用前景做轻微视差?
