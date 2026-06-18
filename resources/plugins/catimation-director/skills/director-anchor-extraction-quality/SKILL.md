---
name: director-anchor-extraction-quality
description: 【导演模式·角色锚点 / Director · Character Anchors】触发词:角色锚点 / 锚点提取 / 人物设定 / 参考图提取 / 脸型 / 体型 / 服装 / 区分相似角色 / character anchor / reference extraction。Use when extracting character anchors from reference images where every anchor must list face / build / outfit / markers, hit the 40-word minimum, differentiate similar builds explicitly ("A is taller by ~10cm"), and mark occluded parts with [inferred] — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

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
