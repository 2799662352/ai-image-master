---
name: visual-continuity
description: Use when verifying lighting, color, and spatial consistency across storyboard panels
appliesTo: [verifyConsistency, designAndAssemble]
priority: 2
---

VISUAL CONTINUITY — same scene = same visual physics:

Lighting:
- See lighting-continuity skill for detailed rules. Key principle: same scene = same light direction and color temperature.

Color & Tone:
- Establish a scene color palette (2-3 dominant colors) and maintain it
- Color temperature stays consistent: don't mix warm and cool lighting in the same scene
- Time of day determines palette — golden hour is warm, overcast is cool, night is blue-shifted

Scale & Proportion:
- Object sizes relative to characters must stay constant
- If a table reaches waist height in panel 2, it cannot reach chest height in panel 5
- Architecture and environment landmarks must maintain spatial relationships

Verification:
- Flag any panel where light direction reverses from its neighbor
- Flag color temperature shifts without scene/time change
- Flag object scale inconsistencies > 20% between panels
