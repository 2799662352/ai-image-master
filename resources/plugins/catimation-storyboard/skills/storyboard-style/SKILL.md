---
name: storyboard-style
description: 【分镜模式·风格 / Storyboard · Style】触发词:配色 / 色板分解 / 光源类型 / 阴影占比 / palette / hex。Use when a scene needs a hard palette decomposition (dominant+accent hex ≥ 7:3), typed light source (rim/fill/key) with angle and intensity %, and shadow depth as % of frame.
---

# Storyboard Style / 分镜风格

## Overview

为场景做硬性色彩分解:主色+点缀色(hex,比例 ≥ 7:3)、分型光源(rim/fill/key,带角度与强度%)、阴影占比。

## When to Use

- 需要锁定基础色板与光源类型时。
- 何时改用:要加镜头规格(mm/光圈)与 Z 轴前中后景 → `storyboard-visual`;要系统化 LUT/HEX 调色与色彩 DNA → `storyboard-color-grading-control`。

Style Rules:
- Color palette: dominated by [hex] + accent [hex], ratio ≥ 7:3
- Light source: specify type (rim/fill/key), angle, intensity %
- Shadow depth: percentage of frame in shadow

## Example

- Palette: teal #0f3a3d dominant + warm orange #e08a3c accent (≈8:2 ratio).
- Light source: key from upper-left 45°, intensity 80%; rim from back-right, intensity 20%.
- Shadow depth: ~55% of the frame in shadow.

## Common Mistakes

- 主色与点缀色平均分配 → 保持 ≥ 7:3 比例。
- 只写"电影光" → 指明 rim/fill/key + 角度 + 强度%。
