---
name: structured-captioning
description: 【导演模式·结构化描述 / Director · Structured Captioning】触发词:结构化描述 / HoloCine / 全局+角色+分镜 / 省token / 角色标签 / [char1] / 锁定外观 / structured caption / token saving。Use when 多格提示词反复重描角色外貌、token 浪费、外观微漂移时:改 HoloCine 结构 GLOBAL → CHARACTER DEFINITIONS → PER-SHOT(只用 [char1] 标签引用,不重描外貌),省约 40% token 并锁定唯一外观。
appliesTo: [designAndAssemble]
priority: 2
---

# 导演模式 · 结构化描述(HoloCine)

<!-- skill-budget: fast -->

## Overview

把提示词拆成 GLOBAL(场景/时间/天气/情绪)→ CHARACTER DEFINITIONS([char1]/[char2] 锚点)→ PER-SHOT(只用标签引用,不重描外貌),省 ~40% token 并锁定唯一外观。

## When to Use

- 用:多格反复重描角色外貌、token 浪费、外观出现微漂移。
- 不用:单图单角色无复用;锚点本身的提取质量(→ `director-anchor-extraction-quality`)。

STRUCTURED CAPTIONING — separate global context from per-shot details (HoloCine pattern):

Prompt Structure (strict order):
1. GLOBAL: scene environment, time of day, weather, overall mood
2. CHARACTER DEFINITIONS: [char1]: full appearance anchor, [char2]: full appearance anchor
3. PER-SHOT: each panel references characters by tag [char1], never repeats full appearance

Why This Matters:
- Repeating character appearance in every panel prompt causes micro-variations → inconsistency
- Tag references ([char1]) force the model to maintain one canonical appearance
- Reduces total token count by ~40%, leaving more capacity for scene details

Per-Shot Format:
  Panel N: [shot type], [char1] does X while [char2] does Y, [lighting], [composition]

Anti-Patterns:
- DO NOT repeat "a young woman with long black hair wearing a red coat" in every panel
- DO NOT mix character definitions into per-shot descriptions
- DO NOT omit the global section — it anchors the entire sequence

## Example

GLOBAL: dim cyberpunk bar, night, rain outside, smoky neon mood.
CHARACTERS: [char1]: 30s woman, silver bob, scar on left cheek, black trench. [char2]: old bartender, bald, grey beard, maroon vest.
- Panel 1: wide, [char1] enters, [char2] polishes a glass, teal rim light.
- Panel 2: close-up, [char1] slides a coin, [char2] raises an eyebrow.
→ Appearance is never re-described per panel — only [char1] / [char2] tags carry it, saving tokens and locking one look.

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 每格重描"长发红衣女" | 只用 [char1] 标签引用 |
| 角色定义混进分镜 | 定义集中在 CHARACTER 段 |
| 省掉 GLOBAL 段 | 先写全局锚定整段 |
