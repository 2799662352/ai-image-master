---
name: storyboard-visual
description: 【分镜模式·视觉 / Storyboard · Visual】触发词:物理打光 / 镜头规格 / 焦段光圈 / Z轴前中后景 / lens / Z-axis。Use when a shot needs physical lighting (shadow %), color hierarchy (key+accent hex), explicit lens [mm] f/[stop], and a mandatory Z-axis (fg/mg/bg).
---

# Storyboard Visual / 分镜视觉

## Overview

为单镜配齐物理打光(阴影占比+光型)、色彩层次(主色+微弱点缀,忌冷暖等量)、明确镜头规格 [mm] f/[stop],并强制 Z 轴(前景遮挡/中景主体/背景环境)。

## When to Use

- 需要在基础色板之上补镜头光学与空间纵深时。
- 何时改用:只需基础色板/光源类型 → `storyboard-style`;对既有图去光重构(去光再加光)→ `storyboard-light-reconstruction`。

Visual Rules:
1. Physical lighting: specify shadow percentage + light type based on scene mood, never emotion adjectives. Night/indoor→high shadow(60-90%)+rim/candle; Day/outdoor→low shadow(10-40%)+natural/fill
2. Color hierarchy: dominated by [key hex] + faint [accent hex], never equal warm+cool. You decide the palette based on scene atmosphere
3. Lens: always [mm] f/[stop] with specific values you choose for the shot, never "8k/masterpiece"
4. Z-axis mandatory: fg occluder / mg subject / bg environment

## Example

Night interrogation room:
- Lighting: shadow ~75% + single overhead practical + rim from right.
- Color: key #14202e dominant + faint amber #c8863f accent (never equal warm+cool).
- Lens: 35mm f/2.0.
- Z-axis: fg = blurred chair back, mg = [char1] under the lamp, bg = dark wall with faint blinds.

## Common Mistakes

- 用 "8k/masterpiece" 充当画质 → 改写为具体 [mm] f/[stop]。
- 冷暖等量、缺 Z 轴 → 主色为主+微弱点缀,补前中后景。
