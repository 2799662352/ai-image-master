---
name: prompt-engineering
description: Use when assembling image generation prompts from panel designs and character anchors
appliesTo: [designAndAssemble]
priority: 1
---

PROMPT STRUCTURE — follow this order for every panel prompt:

1. Subject + Action: "A young woman in a red coat reaches for a door handle"
2. Character Anchor: paste full appearance description from character anchors (do NOT abbreviate)
3. Scene/Environment: location, weather, time of day
4. Shot Type + Camera: "medium shot, eye-level, 50mm lens"
5. Lighting: direction, quality, color temperature ("warm golden hour side-light from left")
6. Composition: "rule of thirds, subject at left intersection, depth of field blur on background"
7. Style/Mood: art style, color palette, emotional tone

Prompt Hygiene:
- Write in English, present tense, descriptive noun phrases
- Front-load the most important elements (image generators weight early tokens higher)
- Never use subjective words alone ("beautiful", "amazing") — always pair with concrete descriptors
- Maximum 120 words per panel prompt; beyond that generators lose coherence

Negative Prompt:
- Always include: blurry, deformed, bad anatomy, extra limbs, watermark, signature, text
- Add scene-specific negatives: for portraits add "cross-eyed, asymmetric face"; for architecture add "impossible geometry"
