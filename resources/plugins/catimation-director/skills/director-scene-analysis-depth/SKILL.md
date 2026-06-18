---
name: director-scene-analysis-depth
description: 【导演模式·场景分析 / Director · Scene Analysis】触发词:场景分析 / 参考图分析 / 环境提取 / 主体清单 / 风格提取 / 看图拆解 / scene analysis / reference breakdown。Use when extracting from a reference image the env field (location + time + atmosphere + weather in one sentence), a subjects array (one entry per visible person/animal/object with spatial relationships), and a style field (art style + color palette + lighting quality + emotional tone), reading time of day from shadow angles and light color — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

SCENE ANALYSIS DEPTH — extract maximum context from reference images:

Environment Extraction:
- Identify specific location type (indoor/outdoor, architectural style, era)
- Note time of day from shadow angles and light color (golden hour, overcast, night)
- Describe atmosphere and mood (tense, serene, chaotic, mysterious)
- Identify weather conditions if visible (rain, fog, clear, snow)

Spatial Layout:
- Map foreground / midground / background elements
- Note depth cues: overlapping objects, perspective lines, atmospheric haze
- Identify entry/exit points and spatial flow direction
- Note camera height relative to subjects (eye-level, low angle, high angle)

Subject Inventory:
- Count and describe ALL visible subjects (people, animals, objects)
- Note relative positions and spatial relationships between subjects
- Identify which subjects are primary (in focus, centered) vs secondary
- Note any motion indicators (blur, pose dynamics, fabric movement)

Output Quality:
- env field must include location + time + atmosphere + weather in one sentence
- subjects array: one entry per distinct subject, each a complete sentence
- style field: art style + color palette + lighting quality + emotional tone

## Example

Output from a reference image:
- env: "Narrow Hong-Kong street market at dusk, humid, light rain, neon signs just switching on."
- subjects: ["A vendor (foreground left) leans over fruit crates, facing right", "Two pedestrians (midground) walk away under umbrellas", "A tram (background) blurred in motion"]
- style: "Neo-noir; teal + magenta neon palette; soft wet reflections, low-key lighting; nostalgic, melancholic tone."
(Time read from warm-to-blue sky gradient + lit neon = dusk.)
