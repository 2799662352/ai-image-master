---
name: director-prompt-engineering
description: 【导演模式·提示词结构 / Director · Prompt Structure】触发词:提示词结构 / 七字段 / 提示词模板 / 怎么写提示词 / 镜头+灯光+构图+风格 / prompt structure / 7-field / prompt template。Use when assembling a prompt in the canonical 7-field order — Subject+Action → Character Ref ([char1] tags) → Scene → Shot+Camera (e.g. 50mm, eye-level) → Lighting (direction, quality, color temperature) → Composition (rule of thirds, DoF) → Style+Mood — within 120 words and paired with negative prompts (blurry, deformed, bad anatomy, extra limbs, watermark) — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

# 导演模式 · 提示词结构(7 字段)

## Overview

把每条提示词按固定 7 字段顺序拼装(主体动作 → 角色引用 → 场景 → 镜头相机 → 光照 → 构图 → 风格情绪),≤120 词,前置重点字段。

## When to Use

- 用:需要一条规范、可复现的成品提示词;字段乱序/丢字段导致出图不稳。
- 不用:多镜连续性/叙事排序(→ continuity / narrative 系列);纯锚点提取(→ anchor-extraction)。

PROMPT STRUCTURE — follow this order for every panel prompt:

1. Subject + Action: "[char1] reaches for a door handle" (use character tags, not full descriptions)
2. Character Reference: use [char1] [char2] tags defined in the global section (never inline full appearance per panel)
3. Scene/Environment: location, weather, time of day
4. Shot Type + Camera: "medium shot, eye-level, 50mm lens"
5. Lighting: direction, quality, color temperature ("warm golden hour side-light from left")
6. Composition: "rule of thirds, subject at left intersection, depth of field blur on background"
7. Style/Mood: art style, color palette, emotional tone

Prompt Hygiene:
- Write in English, present tense, descriptive noun phrases
- Front-load the most important elements (image generators weight early tokens higher)
- Never use subjective words alone ("beautiful", "amazing") — always pair with concrete descriptors
- Maximum 120 words per panel prompt; beyond that generators lose coherence

Negative Prompt(默认正向,按需补充):
- 默认正向描述(与 `director-orchestrator` 一致):画质要求写成正向(sharp focus, correct anatomy, five clear fingers, natural proportions),而非堆"不要…"清单。
- 仅当目标模型有独立负向字段且确需时补充:blurry, deformed, bad anatomy, extra limbs, watermark, text;人像可加 cross-eyed, asymmetric face,建筑可加 impossible geometry。

## Example

Assembled in 7-field order (≤120 words):
[char1] reaches for a brass door handle, leaning in — [char1] — dim Victorian hallway, dusk — medium shot, eye-level, 50mm — warm tungsten side-light from left, soft, 3200K — rule of thirds, subject at left intersection, shallow DoF on background — muted sepia palette, tense, noir mood.
(按需)Negative: blurry, deformed, bad anatomy, extra limbs, watermark, text, cross-eyed.

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 字段乱序、重点放末尾 | 按 7 字段顺序,重要元素前置 |
| 每格内联重描角色外貌 | 用 [char1] 标签引用全局定义 |
| 默认堆负向词 | 默认正向,负向按需补充 |
