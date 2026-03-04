---
name: director-style-consistency
description: Use when verifying or enforcing cross-panel style uniformity in contact sheets
appliesTo: [extractStyleAnchor, verifyConsistency, designAndAssemble]
priority: 5
---

Style Consistency Rules:
- All panels in a contact sheet MUST share a single rendering medium (photorealistic, anime cel, 3D CGI, etc.) — never mix.
- Color temperature shifts between panels are only allowed when explicitly motivated by time-of-day changes within the narrative.
- Texture quality (film grain density, cel shading weight, brush stroke style) must remain uniform across all panels.
- If a user Template is selected, the Template's implied medium is the authoritative source. Do not infer a different medium from reference images.
- Style keywords in panel prompts must not contradict the resolved style anchor.
- When conflicts exist between user intent and image analysis, always favor user intent.
- For verification: deduct 3 points per medium mismatch, 1 point per color temperature drift.
