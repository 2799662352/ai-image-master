---
name: character-consistency
description: Use when the same character must appear identical across panels — anchored by face / build / outfit / markers, with hair / outfit / props unchanged across cuts and relative skin-tone descriptors used instead of absolute color — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
appliesTo: [taskPlanning, extractCharacterAnchors, verifyConsistency]
priority: 1
---

CHARACTER ANCHOR FORMAT — every character MUST include ALL of:

1. Face: skin tone, face shape, eye color, hair color + style + length
2. Build: height relative to scene, body type (slim/athletic/heavy)
3. Outfit: exact garments top-to-bottom, colors (use hex if possible), patterns, accessories
4. Markers: scars, tattoos, glasses, jewelry, props — anything unique

Consistency Checks:
- Hair color and length must NOT change between panels unless story demands it
- Outfit remains identical across all panels in the same scene
- If a character holds a prop in panel N, the prop must be visible or accounted for in panel N+1
- Lighting may change skin tone perception — anchor by relative tone, not absolute color

Verification Scoring:
- Deduct 2 points per character with missing anchor fields
- Deduct 3 points per cross-panel inconsistency (hair, outfit, prop continuity)
- Flag as issue if anchor description is under 30 words (too vague to reproduce)
