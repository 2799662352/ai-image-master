# cinematicGemSystemPrompt Upgrade - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the `cinematicGemSystemPrompt` in DirectorPage.ts with professional cinematic knowledge from 10 reference articles, covering 7 sections: output format, micro-performance, action physics, color grading, atmosphere, composition, and shot-emotion matching.

**Architecture:** Modify the existing prompt string in-place. Each section is a self-contained XML tag block. New sections are added, existing ones are expanded. All changes aligned with the expanded Zod schema fields.

**Tech Stack:** TypeScript string template, Zod schema already extended

---

### Task 1: Simplify `<output_format>` for LangChain compatibility

**File:** `src/renderer/src/pages/DirectorPage.ts` (L447-462)

Replace the detailed JSON format spec with a minimal version. The LangChain `withStructuredOutput` path handles format enforcement; this section only serves the legacy Gem AI fallback.

**Before:** ~15 lines detailing JSON fields
**After:** ~5 lines with minimal guidance

---

### Task 2: Upgrade `<expression_rules>` → `<micro_performance_rules>`

**File:** `src/renderer/src/pages/DirectorPage.ts` (L506-518)

Expand from 5 emotions to 10, add restraint principle, process-over-result rule, and action-driven expression.

**New content:**
- Restraint modifiers: faint, barely, subtle, almost imperceptible
- 5 new emotions: relief, hesitation, suppressed rage, shock, heartbreak
- Process rule: Start→Transition→End micro-arc
- FORBIDDEN: emotion adjectives (sad, happy, angry, scared) in any shot type
- Action-drives-expression: write the physical action first, expression emerges as byproduct

---

### Task 3: Upgrade `<action_rules>` → `<action_physics_rules>`

**File:** `src/renderer/src/pages/DirectorPage.ts` (L520-527)

Add manner word vocabulary, physical resistance/interaction, environment forces.

**New content:**
- Manner word categories: gravity (lean, stumble, brace), rhythm (slowly, abruptly, hesitantly), resistance (against wind, through rain, dragging weight)
- Physical interaction: body angle in degrees, clothing physics, temperature reactions
- FORBIDDEN: bare action verbs without manner context ("walks", "runs", "stands")

---

### Task 4: Expand `<lighting_rules>` with color grading

**File:** `src/renderer/src/pages/DirectorPage.ts` (L496-504)

Add color grading sub-section after existing lighting rules.

**New content:**
- Color hierarchy: 80% dominant + 20% accent, never 50/50
- HEX anchor points encouraged for precision
- Film stock vocabulary: bleach bypass, cross-processed, desaturated, matte
- FORBIDDEN: "cinematic color", "rich colors", "vibrant", "colorful"

---

### Task 5: Expand `<spatial_depth>` with atmosphere/medium

**File:** `src/renderer/src/pages/DirectorPage.ts` (L486-494)

Add atmospheric medium as a fourth depth dimension.

**New content:**
- Physical media: fog, haze, dust motes, god rays, steam, breath vapor, rain streaks
- Density/intensity descriptors: "thin morning mist", "thick dust cloud"
- Depth reinforcement: atmospheric perspective softens background by N stops
- FORBIDDEN: "atmospheric" as standalone word

---

### Task 6: Add new `<composition_rules>` section

**File:** `src/renderer/src/pages/DirectorPage.ts` (after `<spatial_depth>`)

**New section:**
- Leading lines: converge on subject, create visual flow
- Natural framing: doorways, windows, branches create psychological containment
- Negative space: empty areas amplify isolation, anticipation
- Rule of thirds: subject placement at intersection points
- Emotion-composition map: negative space=loneliness, frame-within-frame=entrapment, symmetry=order/control

---

### Task 7: Add new `<shot_emotion_matrix>` section

**File:** `src/renderer/src/pages/DirectorPage.ts` (after `<camera_physics>`)

**New section:**
- EWS/WS → isolation, epic scale, insignificance, fate
- FS/Cowboy → narrative neutrality, daily life, context
- MCU → intimacy, empathy, emotional amplification
- CU → vulnerability, pressure, revelation
- ECU → obsession, detail fetish, micro-tension
- FORBIDDEN pairings: euphoria+EWS, loneliness+ECU, action climax+static CU

---

### Task 8: Build + Test + Verify prompt length

- `npx electron-vite build` exit 0
- `npx vitest run` all pass
- Verify total prompt length stays under 10000 chars (~2500 tokens)
- ReadLints 0 new errors
