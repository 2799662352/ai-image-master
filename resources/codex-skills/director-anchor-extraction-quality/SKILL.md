---
name: director-anchor-extraction-quality
description: Use when extracting character anchors from reference images to ensure completeness and cross-panel reproducibility
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
