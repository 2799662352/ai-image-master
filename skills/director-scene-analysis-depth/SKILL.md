---
name: scene-analysis-depth
description: 【导演模式·场景分析 / Director · Scene Analysis】触发词:场景分析 / 参考图分析 / 环境提取 / 主体清单 / 风格提取 / 看图拆解 / scene analysis / reference breakdown。Use when 拿到参考图要做反推 / 复刻的前置拆解时:提取 env 字段(地点+时刻+氛围+天气一句话)、主体清单(逐个可见人物含空间关系)、style 字段(美术+色板+光质+情绪),时刻由阴影角与光色读出。
appliesTo: [taskPlanning, analyzeScene]
priority: 1
---

# 导演模式 · 场景分析

<!-- skill-budget: fast -->

## Overview

从参考图榨取最大上下文:环境(地点+时刻+氛围+天气一句话)、主体清单(每个可见人/物一条,含空间关系)、风格(美术+色板+光质+情绪),时刻由阴影角与光色读出。

## When to Use

- 用:拿到参考图要拆解环境/主体/风格,做反推或复刻的前置分析。
- 不用:只提取角色锚点(→ `director-anchor-extraction-quality`);已确定场景、只写构图/光照。

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

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 漏数次要主体 | 列全所有可见主体 |
| 时刻靠猜 | 由阴影角+光色推断 |
| 风格只写一句"好看" | 给美术+色板+光质+情绪 |
