---
name: scene-analysis-depth
description: Use when analyzing reference images to extract scene environment, atmosphere, lighting conditions, and spatial layout
appliesTo: [taskPlanning, analyzeScene]
priority: 1
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
