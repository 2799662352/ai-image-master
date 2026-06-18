---
name: storyboard-visual
description: 【分镜模式·视觉 / Storyboard · Visual】触发词:视觉 / 打光 / 色彩层次 / 镜头规格 / 焦段光圈 / Z轴 / 前中后景 / 阴影占比 / lighting / color / lens / Z-axis / shadow。Use when a shot needs physical lighting (shadow 10-40% day / 60-90% night, rim / candle / natural / fill), color hierarchy ([key hex] dominant + faint [accent hex], never equal warm + cool), explicit lens spec [mm] f/[stop] instead of "8k masterpiece", and a mandatory Z-axis (fg occluder / mg subject / bg environment) — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

Visual Rules:
1. Physical lighting: specify shadow percentage + light type based on scene mood, never emotion adjectives. Night/indoor→high shadow(60-90%)+rim/candle; Day/outdoor→low shadow(10-40%)+natural/fill
2. Color hierarchy: dominated by [key hex] + faint [accent hex], never equal warm+cool. You decide the palette based on scene atmosphere
3. Lens: always [mm] f/[stop] with specific values you choose for the shot, never "8k/masterpiece"
4. Z-axis mandatory: fg occluder / mg subject / bg environment

## Example

Night interrogation room:
- Lighting: shadow ~75% + single overhead practical + rim from right.
- Color: key #14202e dominant + faint amber #c8863f accent (never equal warm+cool).
- Lens: 35mm f/2.0.
- Z-axis: fg = blurred chair back, mg = [char1] under the lamp, bg = dark wall with faint blinds.
