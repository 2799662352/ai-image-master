---
name: director-structured-captioning
description: 【导演模式·结构化描述 / Director · Structured Captioning】触发词:结构化描述 / HoloCine / 全局+角色+分镜 / 省token / 角色标签 / [char1] / 锁定外观 / structured caption / token saving。Use when prompts repeat character appearance across panels and waste tokens — restructure as HoloCine: GLOBAL (scene, time, weather, mood) → CHARACTER DEFINITIONS ([char1]: anchor, [char2]: anchor) → PER-SHOT (references [char1] tag, never re-describes appearance), cutting tokens ~40% and locking one canonical look — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

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
