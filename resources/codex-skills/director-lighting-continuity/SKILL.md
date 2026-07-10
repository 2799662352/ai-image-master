---
name: director-lighting-continuity
description: 【导演模式·光照连续性 / Director · Lighting Continuity】触发词:打光 / 光源方向 / 色温 / 光影一致 / 布光 / 黄金时刻 / 夜景光 / 霓虹 / lighting / key light / color temperature。Use when 同场景多格光源方向乱、色温跳变、影子方向不一致时:锁定主光方向(左/右/顶/背)、软硬与色温(黄金时刻 3000-4000K、阴天 5500-6500K、夜景蓝环境+暖实用光、霓虹混合),排查无时间跳变的光向反转。
---

# 导演模式 · 光照连续性

<!-- skill-budget: fast -->

## Overview

锁定每格的主光方向(左/右/顶/背)、软硬、色温(黄金时刻 3000–4000K、阴天 5500–6500K、夜景蓝环境+暖实用光、霓虹混合),并排查无时间跳变的光向反转与色温跳变。

## When to Use

- 用:同场景多格的打光方向/色温一致性;阴影方向穿帮排查。
- 不用:配色/比例/地标等更广连续性(交视觉连续性技法);单图布光设计。

LIGHTING CONTINUITY (VGoT HDR dimension) — same scene = same physics of light:

Per-Panel Lighting Specification:
- Every panel MUST explicitly state: key light direction (left/right/top/back), quality (hard/soft), color temperature (warm/cool/neutral)
- If panel 1 has "warm golden side-light from left", ALL subsequent panels in the same scene maintain left-side warm light
- Shadow direction follows light source — never contradictory between adjacent panels

Color Temperature Rules:
- Golden hour: warm (3000-4000K), shadows are long and soft
- Overcast/cloudy: cool neutral (5500-6500K), diffuse shadows
- Night/indoor: blue-shifted ambient + warm practicals (candles, lamps)
- Neon/cyberpunk: mixed cool ambient + saturated colored practicals

Scene Transition Lighting:
- Same scene: lighting MUST be identical across all panels
- Time skip within scene: gradual shift only (sunrise→morning, not noon→midnight)
- Location change: lighting reset allowed, but state it explicitly

Verification Checklist:
- Flag any panel where light direction reverses from its neighbor
- Flag color temperature shifts without scene/time change
- Flag missing light source description (every panel needs one)

## Example

Same scene, 3 panels:
- Panel 1: warm key from LEFT, hard, 3500K, long shadows falling right.
- Panel 2: same LEFT warm key, 3500K — subject turns, shadows still fall right. ✓
- Panel 3: key suddenly from RIGHT, 6000K cool, with no time skip → FLAG (light-direction reversal + color-temperature jump).

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 邻格光向反转 | 同场景主光方向保持 |
| 无时间跳变却跳色温 | 色温只随时段渐变 |
| 漏写光源描述 | 每格都标方向/软硬/色温 |
