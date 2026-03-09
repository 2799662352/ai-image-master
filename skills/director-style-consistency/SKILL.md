---
name: director-style-consistency
description: Use when verifying or enforcing cross-panel style uniformity and resolving image-text style conflicts
appliesTo: [taskPlanning, extractStyleAnchor, verifyConsistency, designAndAssemble, generateImages]
priority: 5
---

Style Consistency & Conflict Resolution Rules:

## Cross-Panel Uniformity
- All panels in a contact sheet MUST share a single rendering medium — never mix.
- Color temperature shifts between panels are only allowed when motivated by time-of-day changes.
- Texture quality (film grain density, cel shading weight) must remain uniform.

## Image-Text Conflict Resolution
- When a user Template is selected, the Template's implied medium is the authoritative source.
- Reference images provide CHARACTER IDENTITY only — face, hair, body, outfit, props.
- Reference images do NOT define rendering medium, color grading, or lighting.
- If reference image style contradicts user Template: TEXT WINS. Always.
- Style keywords in panel prompts must not contradict the resolved style anchor.

## Negative Prompt Reinforcement
- When the desired style is photorealistic, negative prompts must include: anime, cartoon, illustration, cel shading.
- When the desired style is anime, negative prompts must include: photorealistic, real person, photograph.
- This prevents the image generation model from drifting toward the reference image's original style.
