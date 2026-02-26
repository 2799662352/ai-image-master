# SCHEMA Prompt Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply SCHEMA modular label architecture and Gemini-specific prompt best practices to improve character consistency and grid quality across all 4 prompt generation paths.

**Architecture:** Restructure all prompt output methods to follow a consistent 7-segment SCHEMA order (SUBJECT > COMPOSITION > STYLE > LIGHTING > CAMERA > QUALITY > CONSTRAINTS), and refine character reference wording based on Nano Banana best practices. All changes are in prompt text only — no API or type system changes.

**Tech Stack:** TypeScript, electron-vite, Gemini 3 Pro Image (via apiyi.com)

---

## Background

The SCHEMA methodology (arXiv:2602.18903) achieved 91% compliance on Gemini 3 Pro Image using 7 core structured labels. Google's official Gemini 3 prompting guide recommends placing constraints at the END. Nano Banana character consistency best practices recommend specific phrases like "maintain exact facial proportions and outfit from reference" rather than generic "same character".

Current prompt issues:
1. Prompt segments are not in consistent SCHEMA order across 4 paths
2. Character reference wording is generic ("same character as anchor")
3. cinematic suffix repeats layout info already in template
4. Gem AI shot descriptions may still embed verbose character text

---

### Task 1: Define SCHEMA segment constants

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts:387-399` (cinematicGridPromptTemplate)

**Step 1: Rewrite `cinematicGridPromptTemplate` in SCHEMA order**

Replace lines 387-399 with:

```typescript
private cinematicGridPromptTemplate = `[COMPOSITION] Cinematic Contact Sheet, ONE single master image, 3x3 storyboard grid.
Aspect ratio: entire image {RATIO}, each panel also {RATIO}. Symmetrical grid, hard borders, clean white dividing lines.

[SUBJECT] {CHARACTER_DESCRIPTION}

[STORY] {STORY_DESCRIPTION}

[PANELS]
{PANEL_DESCRIPTIONS}

[STYLE] Cinematic lighting, photorealistic, sequence photography, 8K resolution.
[CONSTRAINTS] Do NOT change character appearance between panels. Maintain exact facial proportions, hairstyle, hair color, eye color, skin tone, and outfit from reference across ALL 9 panels.`
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "refactor: apply SCHEMA label order to cinematicGridPromptTemplate"
```

---

### Task 2: Apply SCHEMA order to `generateGeneric9GridPrompt`

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts:2268-2302` (generateGeneric9GridPrompt)

**Step 1: Rewrite the prompt assembly**

Replace the prompt template string with SCHEMA-ordered segments:

```typescript
let prompt = `${templatePrefix}[COMPOSITION] 3x3 grid storyboard, 9 equal panels.
Aspect ratio: entire image ${ratio}, each panel also ${ratio}. Symmetrical grid, hard borders, clean dividing lines.

[SUBJECT] ${characterDescription}

[STYLE] ${this.getArtStyleDescription()}

[STORY] ${storyDescription}

[PANELS]
${panelDescriptions}

[CONSTRAINTS] Maintain exact facial proportions, hairstyle, hair color, and outfit from reference across ALL panels.${templateSuffix}`
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "refactor: apply SCHEMA label order to generateGeneric9GridPrompt"
```

---

### Task 3: Apply SCHEMA order to `convertJsonShotsToPrompt` (non-9grid path)

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts:2199-2211` (comicPrompt assembly)

**Step 1: Rewrite the prompt template**

```typescript
let comicPrompt = `${templatePrefix}[COMPOSITION] Single comic page, ${panelCount} panels in ${layout.rows}x${layout.cols} grid layout. Clear panel borders.

[SUBJECT] ${characterDescription}

[STYLE] ${this.getArtStyleDescription()}

[PANELS]
${panelPrompts}

[CONSTRAINTS] Each panel labeled '分镜X' top-left. No speech bubbles, no dialogue, no timecode. Maintain exact character appearance across all panels.${templateSuffix}`
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "refactor: apply SCHEMA label order to convertJsonShotsToPrompt"
```

---

### Task 4: Apply SCHEMA order to `generateTemplatePrompt` (fallback path)

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts:2416-2429` (comicPrompt assembly)

**Step 1: Rewrite the prompt template**

```typescript
let comicPrompt = `${templatePrefix}[COMPOSITION] Single comic page, ${panelCount} panels in ${layout.rows}x${layout.cols} grid.

[SUBJECT]${characterLine}

[STYLE] ${this.getArtStyleDescription()}

[STORY] ${sceneDescription || imageAnalysis || 'Based on reference image'}

[PANELS]
${panelPrompts.join('\n')}

[CONSTRAINTS] Each panel labeled '分镜{i+1}' top-left. No speech bubbles, no dialogue. Maintain exact character appearance from reference.${templateSuffix}`
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "refactor: apply SCHEMA label order to generateTemplatePrompt"
```

---

### Task 5: Optimize cinematic suffix — remove redundant layout info

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts:341` (cinematic suffix)

**Step 1: Trim the suffix**

The cinematic suffix currently contains layout info ("Same characters, same wardrobe...") that duplicates the [CONSTRAINTS] section. Simplify to quality-only tags:

```typescript
suffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field, deeper DoF in wides shallower in close-ups with natural bokeh'
```

Character consistency and layout constraints are now in [CONSTRAINTS] inside the template — no need to repeat in suffix.

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "refactor: trim cinematic suffix to quality tags only, remove redundant constraints"
```

---

### Task 6: Enhance character reference wording (Nano Banana best practice)

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — `extractCharacterDescription` method (~line 2311)

**Step 1: Update the anchor return format**

When `lastCharacterAnchor` exists, return with Nano Banana-specific consistency phrasing:

```typescript
if (this.lastCharacterAnchor) {
  return `${this.lastCharacterAnchor}. Maintain exact facial proportions, hairstyle, hair color, eye color, skin tone, and outfit from reference in every panel.`
}
```

**Step 2: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Commit**

```
git add -A && git commit -m "feat: use Nano Banana best practice phrasing for character consistency"
```

---

### Task 7: Update Gem AI shot instruction — use specific consistency phrase

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` — cinematicGemSystemPrompt (~line 444) and userInput (~line 2081)

**Step 1: Update shot pattern in cinematicGemSystemPrompt**

Change shot pattern from:
```
"same character as anchor"
```
to:
```
"same character — maintain exact facial proportions and outfit from reference"
```

**Step 2: Update shot pattern in userInput JSON example**

Same change at line 2081.

**Step 3: Build and verify**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 4: Commit**

```
git add -A && git commit -m "feat: update Gem AI shot instruction with specific consistency phrase"
```

---

### Task 8: Final build + lint + push

**Step 1: Lint check**

Run: `ReadLints` on DirectorPage.ts
Expected: 0 errors

**Step 2: Full build**

Run: `npx electron-vite build`
Expected: exit code 0

**Step 3: Push**

```
git push origin main
```
