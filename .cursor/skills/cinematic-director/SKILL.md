---
name: cinematic-director
description: Use when generating cinematic storyboard prompts, designing shot sequences, writing AI-video-ready keyframes, reviewing director system prompts for completeness, or enriching visual descriptions with micro-expressions, color grading, and atmospheric detail.
---

# Cinematic Director Knowledge Base

Professional cinematography knowledge for AI-generated storyboard and video prompt engineering.

## Overview

This skill provides modular reference knowledge for building high-quality cinematic prompts. Each reference file covers one domain -- use them individually or combine for comprehensive prompt assembly.

## When to Use

- Generating cinematic shot sequences from reference images
- Writing AI-video-ready keyframe descriptions
- Reviewing or enhancing director system prompts
- Need micro-expression vocabulary beyond basic emotions
- Need data-driven color grading parameters
- Need temporal dynamics (tense-based emotion techniques)
- Need atmospheric/environmental physics vocabulary

## Reference Files

| File | Domain | Use For |
|------|--------|---------|
| `references/micro-expressions.md` | Facial & body expression | CU/MCU emotion descriptions |
| `references/color-grading.md` | Color science | Film stocks, LUTs, color temperature |
| `references/temporal-dynamics.md` | Time-based emotion | Past/present/future tense techniques |
| `references/atmosphere-physics.md` | Environmental detail | Particles, haze, wind, surfaces |
| `references/camera-physics.md` | Optical physics | Lens-DoF consistency, forbidden combos |
| `references/lighting-rules.md` | Light specification | Source, direction, quality, ratio |

## Quick Reference: Shot-to-Expression Mapping

| Shot Type | Expression Tier | Detail Level |
|-----------|----------------|-------------|
| ECU (Extreme Close-up) | Physiological micro-actions | Pupil dilation, skin flush, micro-tremor |
| CU/MCU (Close-up) | Facial muscle groups | Brow furrow, lip compression, jaw clench |
| FS/Cowboy | Body posture + gesture | Shoulder set, weight distribution, hand position |
| WS/EWS | Silhouette + spatial | Body angle to camera, proxemics, gait |

## Integration Pattern

Prompt sections are designed as XML-tagged blocks that can be assembled at runtime:

```
<section_tag>
content from reference file
</section_tag>
```

This allows conditional inclusion based on shot type, template style, or user preference.
