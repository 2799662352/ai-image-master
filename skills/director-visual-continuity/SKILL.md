---
name: visual-continuity
description: Use when verifying that a scene's 2-3 dominant colors stay consistent, color temperature does not mix warm and cool, object-to-character scale holds (table at waist height stays at waist height, ≤20% drift), and architecture / environment landmarks keep their spatial relationships across panels — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
appliesTo: [verifyConsistency]
priority: 2
---

VISUAL CONTINUITY — same scene = same visual physics:

Lighting:
- See lighting-continuity skill for detailed rules. Key principle: same scene = same light direction and color temperature.

Color & Tone:
- Establish a scene color palette (2-3 dominant colors) and maintain it
- Color temperature stays consistent: don't mix warm and cool lighting in the same scene
- Time of day determines palette — golden hour is warm, overcast is cool, night is blue-shifted

Scale & Proportion:
- Object sizes relative to characters must stay constant
- If a table reaches waist height in panel 2, it cannot reach chest height in panel 5
- Architecture and environment landmarks must maintain spatial relationships

Verification:
- Flag any panel where light direction reverses from its neighbor
- Flag color temperature shifts without scene/time change
- Flag object scale inconsistencies > 20% between panels
