---
name: director-style-consistency
description: 【导演模式·风格一致性 / Director · Style Consistency】触发词:风格一致 / 风格统一 / 图文风格冲突 / 材质统一 / 赛璐璐密度 / 颗粒一致 / 写实vs动画 / style consistency / uniform texture。Use when resolving image-vs-text style conflict (TEXT WINS — reference image supplies only character identity, never rendering medium or color grading), enforcing uniform texture / cel-shading / film-grain density across panels, and reinforcing negative prompts (photoreal target → ban anime/cartoon; anime target → ban photoreal) — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

# 导演模式 · 风格一致性

## Overview

统一全片渲染介质 / 材质 / 调色,解决"图文风格冲突"(参考图只给角色身份,不给渲染风格),保证跨格质感一致。

## When to Use

- 用:多格风格漂移、参考图风格与目标模板冲突、赛璐璐/颗粒密度不统一。
- 不用:单图无一致性需求;角色外貌锚点本身的问题 → `director-character-consistency`。

Style Consistency & Conflict Resolution Rules:

## Cross-Panel Uniformity
- All panels in a contact sheet MUST share a single rendering medium — never mix.
- Color temperature shifts between panels are only allowed when motivated by time-of-day changes.
- Texture quality (film grain density, cel shading weight) must remain uniform.

## Image-Text Conflict Resolution
- When a user Template is selected, the Template's implied medium is the authoritative source.
- Reference images provide CHARACTER IDENTITY only — face, hair, body, outfit, props.
- Reference images do NOT define rendering medium, color grading, or lighting.
- If reference image style contradicts user Template: TEXT WINS. Always.
- Style keywords in panel prompts must not contradict the resolved style anchor.

## Negative Prompt(默认正向,按需补充)
- 默认正向描述:把"想要的介质"肯定写出(如 photoreal cinematic / cel-shaded anime),与 `director-orchestrator` 一致。
- 负向仅在必要时按需补充(目标模型有独立负向字段、且确有跨风格漂移):photoreal 目标 → 可加 anime, cartoon, illustration, cel shading;anime 目标 → 可加 photorealistic, real person, photograph。
- 目的是防止模型漂回参考图原风格;能转正向就转正向。

## Example

User Template = "1990s cel-shaded anime"; reference image = a photoreal portrait.
→ TEXT WINS: take only identity from the photo (face, hair, outfit); render medium = cel-shaded anime across ALL panels with uniform line weight + flat shading.
(按需)负向补充:photorealistic, real person, photograph, 3D render。

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 让参考图决定渲染风格 | 参考图只取身份,风格以文本/模板为准(TEXT WINS) |
| 各格混用渲染介质 | 全片单一介质,色温只随时间变化 |
| 无脑堆负向词锁风格 | 默认正向,负向按需补充 |
