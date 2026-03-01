---
name: audio-score-design
description: Use when designing audio, music, sound effects, or voice/dialogue for video storyboards, AI video generation pipelines, film scoring, or any project requiring per-shot synchronized sound design with three layers (score, SFX, voice). Triggers include "audio design", "film score", "sound design", "voice acting", "BGM", "soundtrack", "配乐", "音效", "配音", "声音设计".
metadata:
  version: "1.0"
  author: tecx
---

# Audio Score Design

Three-layer audio design methodology for video storyboard pipelines. Every shot gets synchronized score, SFX, and voice — anchored to real film scores, physical parameters, and emotion tension values.

## When to Use

- Designing audio for storyboard shots (any genre/culture)
- Writing `audio` field descriptions for AI video generation prompts
- Choosing reference film scores for a scene's emotional tone
- Parameterizing voice/dialogue delivery for TTS or voice direction
- Fixing audio-visual desync in generated video

## Core Rule: One Composer Per Shot

Select exactly ONE reference work per shot. Match via: scene emotion tension (0-10) → tension dimension in `references/emotion-tension-map.md` → pick ONE composer whose sound DNA fits the cultural context.

Do NOT stack 2-3 composers. One precise reference > three vague ones.

## Three-Layer Template

```
audio: {
  score: "ref:{Composer}/{Work} → {instruments}, {dynamics}(pp-ff), {tempo}bpm, tension:{0-10}",
  sfx: "{material}+{action}+{freq Hz}+{decay s}+{spatial L/C/R, distance m}",
  voice: "{character}:'{line}' → pitch:{Hz}, breathiness:{%}, rate:{chars/s}, {physical}, reverb RT60:{s}"
}
```

## Audio-Action Sync Formulas

```
score_bpm = body_motion_frequency_Hz × 60
volume_dB = tension × 6 - 40        (tension 0 = -40dB floor, 10 = +20dB peak)
pitch_shift = tension_delta × 50 cents
breath_interval_ms = 2000 / tension  (tension 5 = 400ms, 10 = 200ms)
```

## Five-Phase Rhythm Arc

| Phase | Name | Tension | Audio Behavior |
|-------|------|---------|---------------|
| 1 | Establish | 1-3 | Ambient + single instrument, pp |
| 2 | Build | 3-5 | Rhythm pattern enters, layers add, mp→mf |
| 3 | Focus | 5-7 | Detail SFX amplified, space narrows |
| 4 | Peak | 8-9 | All layers stacked, ff, rhythm max |
| 5 | Resolve | fallback | Layers exit, return to ambient, pp |

Map your shot sequence onto this arc. Not every scene uses all 5 phases.

## Voice Parameterization

| Dimension | Parameter | Range |
|-----------|-----------|-------|
| Pitch | Fundamental freq | Male 100-180Hz / Female 180-350Hz / Child 300-500Hz |
| Texture | Descriptor | sandpaper / velvet / crystal / metallic / hollow |
| Breathiness | Air ratio | 0% pure phonation → 100% pure breath |
| Dynamics | Force | pp whisper → mp conversation → mf declaration → f shout → ff scream |
| Emotion externalization | Physical only | vocal tremor Hz / pitch drift cents / breath gap ms |

Do NOT use emotion adjectives (sexy/angry/sad). Use physical parameters.

## Audio Dodge (D7 Extension)

| Forbidden | Safe Replacement |
|-----------|-----------------|
| moaning/groaning | vocal tremor / breath acceleration |
| screaming | frequency spike >3kHz / vocal overload |
| panting/gasping | breath rate increase to 40bpm |
| celebrity voice imitation | physical parameters (pitch+texture+breathiness) |

`audio.sfx` and `audio.score` do NOT need dodge — instrument/foley terms are safe.

## Quick Reference

See `references/emotion-tension-map.md` for the full 9-dimension tension → composer lookup.

See `references/composer-reference-library.md` for 45+ works across 30+ composers.

See `references/instrument-palettes.md` for cultural instrument groups.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Stacking 2-3 composers per shot | Pick ONE. Match tension dimension + cultural context. |
| Using emotion words for voice | Replace with Hz/bpm/%/cents physical params |
| Ignoring sync formula | bpm must = motion_freq × 60 ± 10% |
| Same composer across all shots | Each shot picks independently from tension map |
| No five-phase arc consideration | Map shots to establish→build→focus→peak→resolve |
| Audio volume unrelated to tension | Use formula: dB = tension × 6 - 40 |
