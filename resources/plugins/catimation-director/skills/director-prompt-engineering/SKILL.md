---
name: director-prompt-engineering
description: 【导演模式·提示词结构 / Director · Prompt Structure】触发词:提示词结构 / 七字段 / 提示词模板 / 怎么写提示词 / 镜头+灯光+构图+风格 / prompt structure / 7-field / prompt template。Use when assembling a prompt in the canonical 7-field order — Subject+Action → Character Ref ([char1] tags) → Scene → Shot+Camera (e.g. 50mm, eye-level) → Lighting (direction, quality, color temperature) → Composition (rule of thirds, DoF) → Style+Mood — within 120 words and paired with negative prompts (blurry, deformed, bad anatomy, extra limbs, watermark) — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

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

Negative Prompt:
- Always include: blurry, deformed, bad anatomy, extra limbs, watermark, signature, text
- Add scene-specific negatives: for portraits add "cross-eyed, asymmetric face"; for architecture add "impossible geometry"

## Example

Assembled in 7-field order (≤120 words):
[char1] reaches for a brass door handle, leaning in — [char1] — dim Victorian hallway, dusk — medium shot, eye-level, 50mm — warm tungsten side-light from left, soft, 3200K — rule of thirds, subject at left intersection, shallow DoF on background — muted sepia palette, tense, noir mood.
Negative: blurry, deformed, bad anatomy, extra limbs, watermark, text, cross-eyed.
