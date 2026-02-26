# Director Knowledge Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate professional cinematography knowledge from 8 super-i.cn articles into the cinematic director template, enhancing Gem AI's shot design quality with physics-consistent camera rules, spatial depth, micro-expression guidance, and color hierarchy control.

**Architecture:** All changes target the `cinematicGemSystemPrompt` string in DirectorPage.ts. We expand `<shot_design_vocabulary>` with 5 new sections based on verified professional practices. The final image prompt structure (SCHEMA labels) is NOT changed — only the Gem AI instructions that control how shots are designed.

**Tech Stack:** TypeScript, electron-vite, Gemini 3 Pro (Vision), Gemini 3 Pro Image (via apiyi.com)

---

## Sources

- [镜头情绪匹配](https://www.super-i.cn/info-2652.html) — Shot size × focal length × DoF physics
- [氛围感三底层](https://www.super-i.cn/info-2647.html) — Light/Color/Focus control formulas
- [数据驱动调色](https://www.super-i.cn/info-2611.html) — HEX color values replace adjectives
- [微表情控制](https://www.super-i.cn/info-2637.html) — Physiological micro-actions replace emotion words
- [动作状态流](https://www.super-i.cn/info-2634.html) — Anchor action + manner words, not verb stacking
- [构图原则](https://www.super-i.cn/info-2632.html) — Rule of thirds, leading lines, visual balance
- [导演思维](https://www.super-i.cn/info-2655.html) — Z-axis depth, motivated lighting, parallax
- [角色一致性](https://www.super-i.cn/info-2620.html) — Three-view assets, static-first workflow

---

### Task 1: Add `<camera_physics>` section — shot/lens/DoF consistency rules

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `cinematicGemSystemPrompt` string, insert after `</shot_design_vocabulary>` (line 449)

**Step 1: Add the new section**

Insert this block after the closing `</shot_design_vocabulary>` tag:

```
<camera_physics>
MANDATORY — every shot MUST obey these optical physics rules. Violations produce "fake AI look":

Shot-Lens-DoF Consistency Table:
| Shot Type | Lens | DoF | Emotion |
|-----------|------|-----|---------|
| EWS/WS | 24mm wide | Deep (everything sharp) | Epic, lonely, establishing |
| FS/Cowboy | 35-50mm | Medium | Narrative, daily life |
| MCU/CU | 85mm portrait | Shallow (bokeh background) | Intimacy, emotion amplifier |
| ECU | 105mm+ | Very shallow | Micro-expression, pressure |

FORBIDDEN combinations (physically impossible, will look fake):
- Wide angle (24mm) + shallow DoF → NEVER
- Long shot + shallow DoF → NEVER (unless tilt-shift)
- Telephoto (135mm+) + deep DoF → NEVER
</camera_physics>
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: add camera_physics rules to Gem AI system prompt"
```

---

### Task 2: Add `<spatial_depth>` section — foreground/midground/background

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `cinematicGemSystemPrompt`, insert after `<camera_physics>`

**Step 1: Add the section**

```
<spatial_depth>
Every shot MUST define three spatial layers to avoid flat "cardboard cutout" look:
- Foreground: framing element, partial occlusion, or textured surface (out of focus if shallow DoF)
- Midground: primary subject and action zone (sharp focus)
- Background: environment context, atmosphere, depth cues (bokeh or haze)

Example: "Foreground: rain-streaked window glass (soft focus). Midground: woman sitting at table, sharp. Background: blurred city lights through window."

If a shot has NO foreground element, it MUST compensate with strong atmospheric depth (fog, dust motes, light rays).
</spatial_depth>
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: add spatial_depth layer rules to Gem AI system prompt"
```

---

### Task 3: Add `<lighting_rules>` section — motivated light sources, not adjectives

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `cinematicGemSystemPrompt`, insert after `<spatial_depth>`

**Step 1: Add the section**

```
<lighting_rules>
NEVER write vague lighting words like "cinematic lighting" or "atmospheric". Instead specify:
1. Light SOURCE: where does light physically come from? (window, lamp, neon sign, sunset, screen glow)
2. Light DIRECTION: which side of the subject does it hit? (upper-left key, rim from behind, under-light)
3. Light QUALITY: hard (sharp shadows) or soft (diffused, wrapping)?
4. Light RATIO: key-to-fill ratio (e.g., 4:1 for dramatic, 2:1 for natural, 1:1 for flat/clinical)

Color hierarchy rule:
- Designate ONE dominant color temperature (warm OR cool) covering 80%+ of the frame
- The complementary color appears ONLY in small accent areas (shadows, reflections, edges)
- NEVER split warm/cool 50-50 — that creates muddy, emotionless images
</lighting_rules>
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: add lighting_rules with motivated sources and color hierarchy"
```

---

### Task 4: Add `<expression_rules>` section — micro-actions replace emotion words

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `cinematicGemSystemPrompt`, insert after `<lighting_rules>`

**Step 1: Add the section**

```
<expression_rules>
For close-up and medium close-up shots, NEVER use emotion adjectives (sad, happy, angry).
Instead describe PHYSIOLOGICAL MICRO-ACTIONS that convey the emotion:

| Emotion | Write THIS (physical) | NOT this (abstract) |
|---------|----------------------|---------------------|
| Sadness | eyes glisten, lower lip trembles, gaze drops to floor | "sad expression" |
| Joy | crow's feet crinkle, teeth visible, eyes squint | "happy smile" |
| Fear | pupils dilate, nostrils flare, jaw clenches | "scared look" |
| Tension | swallows hard, jaw tightens, brow furrows | "tense atmosphere" |
| Shyness | averts gaze, chin tucks, bites lower lip | "shy expression" |

For wider shots, express emotion through BODY POSTURE instead:
- Defeat: shoulders slumped, head bowed, arms hanging
- Confidence: chest open, chin slightly raised, steady gaze
- Anxiety: fidgeting hands, weight shifting, hunched shoulders
</expression_rules>
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: add expression_rules with micro-action table for Gem AI"
```

---

### Task 5: Add `<action_rules>` section — anchor action + manner words

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `cinematicGemSystemPrompt`, insert after `<expression_rules>`

**Step 1: Add the section**

```
<action_rules>
Each panel description must follow the ANCHOR METHOD:
1. ONE primary verb (the anchor action that controls body physics: running, sitting, walking)
2. Manner words that modify HOW (speed, weight, tension): "sprinting with a 15-degree forward lean, coat flaring behind"
3. Satellite actions attached to the anchor: head turns, hand gestures, gaze direction

FORBIDDEN: stacking multiple verbs ("runs, jumps, rolls, draws sword")
CORRECT: one anchor verb + rich manner description

For emotional moments, use "Start → Transition → End" micro-arc within a single panel:
"Maintains composure → deep visible breath → faint relieved smile slowly forms"
</action_rules>
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: add action_rules with anchor method for Gem AI shots"
```

---

### Task 6: Update shot prompt_text pattern to include spatial depth

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `cinematicGemSystemPrompt` `<output_format>` section (line 440-441)

**Step 1: Update the pattern**

Change the shot prompt_text pattern from:
```
"[KF Label + Shot Type + Duration], [Camera Setup + Lens + Movement], same character — maintain exact facial proportions and outfit from reference, [Environment + Action + Pose], [Lighting + DoF + Mood]. 'KF{N}' in the top-left corner. No timecode, no subtitles."
```
to:
```
"[KF Label + Shot Type + Duration], [Lens + Camera Movement], same character — maintain exact facial proportions and outfit from reference, [Foreground/Midground/Background spatial layers], [Action with manner words], [Light source + direction + color temperature]. 'KF{N}' in the top-left corner. No timecode, no subtitles."
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: update shot pattern to include spatial layers and motivated lighting"
```

---

### Task 7: Update `[STYLE]` in `cinematicGridPromptTemplate` — replace vague tags

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `cinematicGridPromptTemplate` (line 392)

**Step 1: Replace the [STYLE] line**

Change:
```
[STYLE] Cinematic lighting, photorealistic, sequence photography, 8K resolution.
```
to:
```
[STYLE] Photorealistic, 8K resolution. Each panel has motivated lighting from a specific source, not generic "cinematic lighting". Dominant color temperature must be consistent across panels.
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: replace vague style tags with motivated lighting instruction"
```

---

### Task 8: Final build + lint + push

**Step 1: Lint check**

Run: `ReadLints` on DirectorPage.ts
Expected: 0 errors

**Step 2: Full build**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Push all commits**

```
git push origin main
```
