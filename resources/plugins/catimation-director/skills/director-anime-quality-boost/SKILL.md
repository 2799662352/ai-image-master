---
name: director-anime-quality-boost
description: 【导演模式·动画质感 / Director · Anime Look】触发词:动画质感 / 日式动画截图 / 赛璐璐 / cel / 去厚涂 / 油画感 / 二次元 / 番剧风 / anime screenshot / no painterly。Use when output drifts toward painterly / 厚涂 / oil-painterly texture instead of cel-shaded anime screenshot style, character identity must lock across panels (hair / outfit / accessories), or injecting JSON instruction blocks with Color Harmony 1.5 and No-Painterly 1.8 weights (日式动画截图) — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

Anime Quality Enforcement — enforces cel-shading, color harmony, character identity lock, and removes painterly/厚涂 texture.

## Character Identity Lock (BINDING)

Core principle: 基本人設は変えない、演出は変えてよい (character design stays fixed, performance can evolve).

- Face structure, hairstyle, hair color, outfit design, signature accessories MUST remain recognizable across ALL panels
- Pose, expression, action, lighting on character, camera angle MAY change freely for dramatic effect
- If a character has twin-tails, twin-tails appear in every panel. If a character wears a military tunic, the tunic appears in every panel.
- Reference image is the SINGLE SOURCE OF TRUTH for character identity. Never invent new outfits, hair colors, or accessories.

## designAndAssemble Rules

Every panel prompt MUST embed this JSON instruction block BEFORE panel descriptions. The JSON format triggers stronger model attention than plain text:

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

## generateImages Rules

Append to composite prompt:

```
STYLE ENFORCEMENT (BINDING):
Japanese anime screenshot style, cel-shaded, clean sharp line art, flat coloring.
Character tones blend with scene lighting and color palette (Color Harmony: 1.5).
No heavy painting texture, no oil-painterly texture (Weight: 1.8).
Shadows and highlights driven by scene light sources.
CHARACTER IDENTITY LOCK: Strictly follow reference image character designs. Hair, outfit, and accessories MUST NOT change across panels.
将分镜画面风格变为日式动画截图风格
人物色调需融入场景的光感，融入场景色调，去掉人物厚涂质感
```

Add to negative prompts:
`heavy painting, thick oil texture, painterly brush strokes, impasto, textured canvas, 3D render, CGI, photorealistic, inconsistent character design, wrong outfit, changed hairstyle`

## Example

Output drifts toward 厚涂 / oil-painterly → inject the `designAndAssemble` JSON block BEFORE the panel text, then append the STYLE ENFORCEMENT lines, then add the negative list above.
Result: clean sharp line art, flat cel-shading, scene-driven shadows; [char1]'s twin-tails + sailor uniform stay identical across every panel.
