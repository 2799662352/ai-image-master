---
name: director-anime-quality-boost
description: 【导演模式·动画质感 / Director · Anime Look】触发词:动画质感 / 日式动画截图 / 赛璐璐 / cel / 去厚涂 / 油画感 / 二次元 / 番剧风 / anime screenshot / no painterly。Use when 输出跑偏成厚涂 / 油画 / 3D 质感、需要拉回赛璐璐日式动画截图风格,或角色跨格身份(发型 / 服装 / 配饰)需要锁定时;Color Harmony / No-Painterly 为内部参数,成品以 markdown 交付、不输出 JSON。
appliesTo: [designAndAssemble, generateImages]
priority: 3
---

# 导演模式 · 动画质感强制(Anime Look)

<!-- skill-budget: fast -->

## Overview

Anime Quality Enforcement — 强制赛璐璐(cel-shading)、色彩和谐、角色身份锁定,去除厚涂/油画质感,把画面拉回日式动画截图风格。本 skill 只管「质感与身份」,不替代构图/光照/镜头序列技能。

## When to Use

- 用:输出偏厚涂 / 油画 / 3D,需要拉回赛璐璐动画截图;或角色跨格身份(发型/服装/配饰)需锁定。
- 不用:目标本就是写实 / 3D 风格;纯构图、光照、镜头序列问题 → 交对应 director-* skill。

## Character Identity Lock (BINDING)

Core principle: 基本人設は変えない、演出は変えてよい (character design stays fixed, performance can evolve).

- Face structure, hairstyle, hair color, outfit design, signature accessories MUST remain recognizable across ALL panels
- Pose, expression, action, lighting on character, camera angle MAY change freely for dramatic effect
- If a character has twin-tails, twin-tails appear in every panel. If a character wears a military tunic, the tunic appears in every panel.
- Reference image is the SINGLE SOURCE OF TRUTH for character identity. Never invent new outfits, hair colors, or accessories.

## 风格强制清单(成品 · 正向 markdown,直接喂模型)

最终交付**不输出 JSON**(遵循编排层交付纪律)。把以下正向强制句拼进成品提示词即可:

```
STYLE ENFORCEMENT (BINDING):
Japanese anime screenshot style, cel-shaded, clean sharp line art, flat coloring.
Character tones blend with scene lighting and color palette (Color Harmony 偏强).
No heavy painting texture, no oil-painterly texture (去厚涂 偏强).
Shadows and highlights driven by scene light sources.
CHARACTER IDENTITY LOCK: Strictly follow reference image character designs. Hair, outfit, and accessories MUST NOT change across panels.
将分镜画面风格变为日式动画截图风格;人物色调融入场景光感与色调,去掉人物厚涂质感。
```

默认正向即可;如目标模型确支持独立负向字段(SD / Midjourney 等),按需补充:
`heavy painting, thick oil texture, painterly brush strokes, impasto, 3D render, photorealistic, inconsistent character design, wrong outfit, changed hairstyle`

## (可选)内部参数结构

下面 JSON 仅作**内部参数结构参考**(Color Harmony / No-Painterly 等权重的含义),**属内部结构,最终交付不输出 JSON**;真正喂给模型 / 交付用户的是上面的 markdown 强制清单:

```json
{
  "instruction": {
    "reference": "Strictly follow the character designs and scene layout from the input image.",
    "style_override": "Transform the visual style into a 1990s-2010s Japanese high-quality anime screenshot style (cel-shaded).",
    "rendering_requirements": [
      "Integrate character skin tones and overall coloring perfectly into the environment's warm lighting and ambient atmosphere (Color Harmony: 1.5).",
      "Completely remove the 'heavy painting' or 'thick oil-painterly' texture from the characters (No painterly texture: 1.8).",
      "Apply clean, sharp line art and flat cel-shading to mimic professional 2D animation frames.",
      "Ensure characters' shadows and highlights are driven by the scene's light sources."
    ],
    "weight_adjustment": {
      "anime_screenshot_style": "+0.99",
      "remove_painterly_texture": "+0.99",
      "lighting_integration": "+0.95"
    }
  }
}
```

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 向用户输出 JSON 指令块 | 交付用 markdown 强制清单,JSON 仅内部参考 |
| 每格重描角色外貌 | 用参考图 + 身份锁定,跨格不变 |
| 堆厚涂/油画词当"高级感" | 明写 cel-shaded / flat coloring / sharp line art |

## Example

Output drifts toward 厚涂 / oil-painterly → 在成品提示词里拼入上面的 STYLE ENFORCEMENT 强制清单(必要时再补负向),并锁定角色身份。
Result: clean sharp line art, flat cel-shading, scene-driven shadows; [char1]'s twin-tails + sailor uniform stay identical across every panel.
