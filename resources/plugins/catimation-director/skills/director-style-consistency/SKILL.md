---
name: director-style-consistency
description: 【导演模式·风格一致性 / Director · Style Consistency】触发词:风格一致 / 风格统一 / 图文风格冲突 / 材质统一 / 赛璐璐密度 / 颗粒一致 / 写实vs动画 / style consistency / uniform texture。Use when resolving image-vs-text style conflict (TEXT WINS — reference image supplies only character identity, never rendering medium or color grading), enforcing uniform texture / cel-shading / film-grain density across panels, and reinforcing negative prompts (photoreal target → ban anime/cartoon; anime target → ban photoreal) — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

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

## Negative Prompt Reinforcement
- When the desired style is photorealistic, negative prompts must include: anime, cartoon, illustration, cel shading.
- When the desired style is anime, negative prompts must include: photorealistic, real person, photograph.
- This prevents the image generation model from drifting toward the reference image's original style.

## Example

User Template = "1990s cel-shaded anime"; reference image = a photoreal portrait.
→ TEXT WINS: take only identity from the photo (face, hair, outfit); render medium = cel-shaded anime across ALL panels with uniform line weight + flat shading.
Negative reinforcement: photorealistic, real person, photograph, 3D render.
