---
name: lighting-continuity
description: Use when designing panels or verifying consistency to ensure lighting direction, color temperature, and HDR coherence across all shots in a scene
appliesTo: [designAndAssemble, verifyConsistency]
priority: 2
---

LIGHTING CONTINUITY (VGoT HDR dimension) — same scene = same physics of light:

Per-Panel Lighting Specification:
- Every panel MUST explicitly state: key light direction (left/right/top/back), quality (hard/soft), color temperature (warm/cool/neutral)
- If panel 1 has "warm golden side-light from left", ALL subsequent panels in the same scene maintain left-side warm light
- Shadow direction follows light source — never contradictory between adjacent panels

Color Temperature Rules:
- Golden hour: warm (3000-4000K), shadows are long and soft
- Overcast/cloudy: cool neutral (5500-6500K), diffuse shadows
- Night/indoor: blue-shifted ambient + warm practicals (candles, lamps)
- Neon/cyberpunk: mixed cool ambient + saturated colored practicals

Scene Transition Lighting:
- Same scene: lighting MUST be identical across all panels
- Time skip within scene: gradual shift only (sunrise→morning, not noon→midnight)
- Location change: lighting reset allowed, but state it explicitly

Verification Checklist:
- Flag any panel where light direction reverses from its neighbor
- Flag color temperature shifts without scene/time change
- Flag missing light source description (every panel needs one)
