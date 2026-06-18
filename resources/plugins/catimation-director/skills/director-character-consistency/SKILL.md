---
name: director-character-consistency
description: 【导演模式·角色一致性 / Director · Character Consistency】触发词:角色一致性 / 同一人物 / 跨镜一致 / 不变脸 / 服装道具不变 / 角色稳定 / character consistency / same character。Use when the same character must appear identical across panels — anchored by face / build / outfit / markers, with hair / outfit / props unchanged across cuts and relative skin-tone descriptors used instead of absolute color — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
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

## Example

[char1] anchor: medium skin, round face, green eyes, copper hair in a high ponytail; ~165cm slim; olive field jacket (#5b5e3a), grey tee, black jeans, white sneakers; small gold stud earrings, red canvas backpack.
- Panel 2 (close-up): ponytail + gold studs visible.
- Panel 5 (wide): same olive jacket + red backpack still worn.
→ Hair color/length, jacket, and backpack unchanged across cuts = consistent. (A panel that switched the jacket to blue or dropped the backpack would be flagged.)
