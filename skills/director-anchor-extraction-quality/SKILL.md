---
name: anchor-extraction-quality
description: 【导演模式·角色锚点 / Director · Character Anchors】触发词:角色锚点 / 锚点提取 / 人物设定 / 参考图提取 / 脸型 / 体型 / 服装 / 区分相似角色 / character anchor / reference extraction。Use when 从参考图提取可复现角色锚点:锚点缺 Face/Build/Outfit/Markers 字段、不足 40 词导致出图漂移、相似角色分不清("A 比 B 高约 10cm")、遮挡部位需标 [inferred] 时。
appliesTo: [extractCharacterAnchors]
priority: 1
---

# 导演模式 · 角色锚点提取

<!-- skill-budget: fast -->

## Overview

从参考图提取**可复现**的角色锚点:每个角色列全 Face / Build / Outfit / Markers,达 ≥40 词下限,相似角色显式区分,遮挡部位标 [inferred]。

## When to Use

- 用:从参考图新建/提取角色锚点;多个相似角色需要区分;锚点太短导致出图漂移。
- 不用:锚点已定、只需跨镜复用与一致性校验(交角色一致性技法)。

ANCHOR EXTRACTION QUALITY — every anchor must be reproduction-ready:

Mandatory Fields Per Character:
- Face: skin tone (relative, not absolute), face shape, eye shape+color, eyebrow thickness, hair color+style+length+texture
- Build: height relative to other characters or environment, body type (slim/athletic/stocky/heavy), posture
- Outfit: list every garment top-to-bottom with colors (use specific color names or hex), patterns, materials
- Markers: scars, tattoos, piercings, glasses, jewelry, hats, weapons, held objects

Anchor Length Minimum:
- Each character anchor MUST be at least 40 words
- Under 40 words = too vague for image generation consistency
- Include distinguishing details that differentiate this character from others in the scene

Multi-Character Differentiation:
- If two characters have similar builds, explicitly state the difference ("Character A is taller by ~10cm")
- If outfits are similar in color, note the distinguishing detail ("A wears a red belt, B does not")
- Use relative descriptions when absolute ones are ambiguous ("darker skin than Character B")

Extraction from Partial Views:
- If a character is partially occluded, describe what IS visible and mark unclear parts as "[inferred]"
- If only seen from behind, note hair and outfit from that angle, mark face as "[not visible, infer from context]"

## Example

[char1] — warm-medium skin, oval face, almond dark-brown eyes, thick straight brows; black shoulder-length hair, slight wave. Build: ~170cm, athletic, upright (taller than [char2] by ~8cm). Outfit: charcoal wool coat (#2b2b2e) over white collared shirt, dark slim trousers, brown leather boots. Markers: thin silver ring on left hand, faint scar above right eyebrow. (47 words — meets the 40-word floor; differs from [char2] by height + scar.)

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 锚点不足 40 词、太笼统 | 写满四类字段,≥40 词 |
| 相似角色不区分 | 显式标差异("A 高约 10cm") |
| 遮挡部位凭空编 | 标 [inferred] / [not visible] |

## 锚点落库与互指

默认用**单锚点人像库**:大头照(正脸无表情)+ 全身照;三视图/四视图可作可选补充,**慎用**(多视图易触发 ID 漂移与双胞胎)。本 skill 是全项目锚点**字数阈值(≥40 词)的基准**,其它涉及锚点的 skill 对齐此值。

**边界:** 本 skill 只负责**从参考图提取锚点的质量**;锚点提取确定后的**跨镜复用与一致性校验**(发型/服装/道具不变)交角色一致性技法。
