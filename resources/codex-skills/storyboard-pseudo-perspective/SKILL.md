---
name: storyboard-pseudo-perspective
description: 用于打破 AI 图像的平面感,通过伪透视词、方向延伸、空气透视、尺度反差、广角/长焦/移轴、明暗切分来制造强纵深和空间张力。适用于 伪透视、透视词、消失点、leading lines、converging lines、atmospheric depth、foreground bokeh、worm's-eye view、giant scale、chiaroscuro、Tyndall effect。
---

# Storyboard Pseudo Perspective / 伪透视空间控制

核心信念:AI 不真正理解三维几何,它在模仿像素规律。我们可以用“伪透视词”欺骗它,让它生成更深、更广、更有 Z 轴的画面。

提炼自中文教程《打破平面魔咒:利用“伪透视”欺骗 AI 视觉系统》。参考: <https://www.super-i.cn/info-2493.html>

## 三个核心欺骗方式

### 1. 方向延伸:制造消失点

弱写法:

```text
A street, buildings on both sides, blue sky.
```

强写法:

```text
A street stretching into the infinite horizon, buildings on both sides forming converging lines, leading toward a distant vanishing point, strong perspective, wide angle, deep depth.
```

关键词:

- stretching into the horizon
- converging lines
- leading toward a distant point
- vanishing point
- long corridor / endless road
- receding into distance

### 2. 空气透视:写空气,不要堆环境

弱写法:

```text
A forest with many trees, bushes, rocks, mountains in the back.
```

强写法:

```text
A forest with layered fog, volumetric lighting, atmospheric depth, foreground bokeh, misty background, distant trees fading into pale haze.
```

关键词:

- layered fog
- atmospheric perspective
- volumetric lighting
- dust / haze / mist
- foreground bokeh
- distant background fading
- lower contrast in distance

### 3. 尺度反差:微小主体 vs 巨物

弱写法:

```text
A man standing in front of a tall building.
```

强写法:

```text
A tiny silhouette of a man looking up at a gigantic monolithic skyscraper, extreme low angle, worm's-eye view, overwhelming scale, dramatic scale contrast.
```

关键词:

- tiny silhouette
- gigantic / colossal / monolithic
- overwhelming scale
- worm's-eye view
- extreme low angle
- massive object towering above

## 镜头代码

- **14-24mm 广角**:夸张纵深、边缘拉扯、速度感、巨物压迫。
- **85-200mm 长焦**:空间压缩、背景贴近主体、孤独/偷窥感。
- **Tilt-shift 移轴**:边缘虚化,制造微缩模型感。

## 光影雕刻空间

用明暗切分前中后景:

```text
chiaroscuro lighting, foreground in deep shadow, subject cut by a narrow beam of light, background falling into darkness
```

用丁达尔效应制造透视线:

```text
visible Tyndall light beams cutting through dust and smoke, rays converging toward the distant doorway
```

## 万能公式

```text
[主体] + [线性引导词] + [消失点/远方] + [镜头参数] + [空气密度] + [尺度反差]
```

## 出稿前检查

- 是否只有前景/背景叠放,没有趋势线?
- 是否有消失点或线性引导?
- 是否用空气密度区分远近?
- 是否有尺度反差?
- 画幅是否支持透视:横幅用于左右延伸,竖幅用于巨物压迫?
- 是否避免元素太满,给视线留出跑道?
