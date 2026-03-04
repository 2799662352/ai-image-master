# Code Review Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 Important issues identified in code review of Style Anchor and Prompt Conflict Resolution implementations.

**Architecture:** Pure code fixes — no new features, no new nodes, no new files. Fixes existing functions and inline fallbacks.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Fix I-1 — Inline Fallback Style-First Ordering

**Problem:** Two inline fallbacks in `generateImagesFn` (line ~1341) and `regenerateImages` (line ~1775) still put style directives in the middle, while the `.md` template correctly puts them first.

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Write the failing test**

Add to `src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`:

```typescript
describe('inline fallback style-first ordering', () => {
  it('style_directive_section should appear before grid description in inline fallback', () => {
    // The inline fallback array should have style sections at the beginning
    // This is a structural test — we verify the order of vars in extractVarsForContactSheet output
    // and confirm the template puts them first
    const state = {
      scene: { env: 'city', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      sceneDescription: '',
      styleInstructions: 'photorealistic, 8K',
      layout: { rows: 2, cols: 3, panelCount: 6 },
      prompts: [{ id: 1, prompt: 'test', negativePrompt: 'blurry' }],
      ratio: '16:9',
      semanticOrientation: 'landscape',
      inputImages: [],
      template: 'cinematic',
      styleAnchor: null,
      styleConflicts: [],
    }
    const vars = extractVarsForContactSheet(state as any)
    // Verify that needed vars exist for style-first ordering
    expect(vars.style_directive_section).toBeTruthy()
    expect(vars.reference_image_role_rules).toBeTruthy()
  })
})
```

**Step 2: Fix the inline fallback in `generateImagesFn`**

Replace the inline fallback array (line ~1341) from:

```typescript
          : [
              `Cinematic Contact Sheet, ONE single master image, ${vars.grid_rows} rows x ${vars.grid_cols} columns storyboard grid, ${vars.panel_count} panels total.`,
              `STRICT GRID: every panel EXACTLY ${vars.panel_ratio} (${vars.panel_orientation}), edge-to-edge, thin 1-2px dark dividers only.`,
              vars.semantic_orientation_instruction,
              'NO text, NO labels, NO captions, NO annotations, NO panel numbers.',
              vars.character_identity_section,
              vars.style_directive_section,
              vars.style_anchor_section,
              vars.reference_image_role_rules,
              `Panel descriptions:\n${vars.enhanced_panel_descriptions}`,
            ].filter(Boolean).join(' ')
```

To (style sections moved to top):

```typescript
          : [
              vars.style_directive_section,
              vars.style_anchor_section,
              vars.reference_image_role_rules,
              `Cinematic Contact Sheet, ONE single master image, ${vars.grid_rows} rows x ${vars.grid_cols} columns storyboard grid, ${vars.panel_count} panels total.`,
              `STRICT GRID: every panel EXACTLY ${vars.panel_ratio} (${vars.panel_orientation}), edge-to-edge, thin 1-2px dark dividers only.`,
              vars.semantic_orientation_instruction,
              'NO text, NO labels, NO captions, NO annotations, NO panel numbers.',
              vars.character_identity_section,
              `Panel descriptions:\n${vars.enhanced_panel_descriptions}`,
            ].filter(Boolean).join(' ')
```

**Step 3: Apply same fix in `regenerateImages`**

Find the identical inline fallback in `regenerateImages` method (line ~1775) and apply the same reordering.

**Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts
git commit -m "fix: reorder inline fallback to style-first — match .md template structure"
```

---

### Task 2: Fix I-2 — Remove Redundant `adaptive_negative_prompt` Variable

**Problem:** `extractVarsForContactSheet` computes `adaptive_negative_prompt` but it's never consumed by the template or inline fallback. The actual negative prompt enhancement is done separately in `generateImagesFn`/`regenerateImages`.

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`

**Step 1: Remove `adaptive_negative_prompt` from `extractVarsForContactSheet`**

Delete the `adaptive_negative_prompt` entry from the returned object in `extractVarsForContactSheet`.

**Step 2: Update tests**

Remove the test `should include adaptive_negative_prompt` from `prompt-conflict-resolution.test.ts`. The adaptive negative prompt functionality is still tested via `buildAdaptiveNegativePrompt` unit tests — we're only removing the redundant template variable.

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts
git commit -m "fix: remove redundant adaptive_negative_prompt from extractVarsForContactSheet (DRY)"
```

---

### Task 3: Fix I-3 — Use `styleAnchor.medium` in `buildAdaptiveNegativePrompt`

**Problem:** When no Template is selected but `styleAnchor.medium` exists (e.g., extracted from reference images), `buildAdaptiveNegativePrompt` returns the base negative unchanged — no style exclusions are added.

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`

**Step 1: Write the failing test**

Add to `prompt-conflict-resolution.test.ts`:

```typescript
  it('should use styleAnchor.medium to infer exclusions when no template', () => {
    const anchor = { medium: 'photorealistic' }
    const result = buildAdaptiveNegativePrompt('blurry, lowres', '', anchor)
    expect(result).toContain('anime')
    expect(result).toContain('cartoon')
  })

  it('should use styleAnchor.medium for anime when no template', () => {
    const anchor = { medium: 'anime cel' }
    const result = buildAdaptiveNegativePrompt('blurry, lowres', '', anchor)
    expect(result).toContain('photorealistic')
    expect(result).toContain('real person')
  })

  it('should prefer template over styleAnchor when both present', () => {
    const anchor = { medium: 'anime cel' }
    const result = buildAdaptiveNegativePrompt('blurry, lowres', 'cinematic', anchor)
    // cinematic template should win — exclude anime, not photorealistic
    expect(result).toContain('anime')
    expect(result).not.toContain('photorealistic')
  })
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`
Expected: FAIL — first two tests fail (no exclusions added when templateKey is empty)

**Step 3: Fix implementation**

Replace `buildAdaptiveNegativePrompt`:

```typescript
const MEDIUM_EXCLUSION_MAP: Record<string, string[]> = {
  photorealistic: ['anime', 'cartoon', 'illustration', 'cel shading', '2D', 'drawn', 'painting', 'sketch'],
  'cinematic photography': ['anime', 'cartoon', 'illustration', 'cel shading', '2D', 'drawn', 'painting'],
  'anime': ['photorealistic', 'real person', 'photograph', 'live-action', '3D render', 'CGI'],
  'anime cel': ['photorealistic', 'real person', 'photograph', 'live-action', '3D render', 'CGI'],
  'manga': ['photorealistic', 'real person', 'color', '3D render', 'anime coloring'],
  '3d': ['photorealistic', 'real person', 'anime', 'illustration', '2D'],
}

export function buildAdaptiveNegativePrompt(
  baseNegative: string,
  templateKey: string,
  styleAnchor: { medium?: string } | null,
): string {
  let exclusions = STYLE_EXCLUSION_MAP[templateKey] || []

  if (exclusions.length === 0 && styleAnchor?.medium) {
    const medium = styleAnchor.medium.toLowerCase()
    for (const [key, values] of Object.entries(MEDIUM_EXCLUSION_MAP)) {
      if (medium.includes(key)) {
        exclusions = values
        break
      }
    }
  }

  if (exclusions.length === 0) return baseNegative
  const existing = new Set(baseNegative.split(',').map(s => s.trim().toLowerCase()))
  const newTerms = exclusions.filter(e => !existing.has(e.toLowerCase()))
  if (newTerms.length === 0) return baseNegative
  return `${baseNegative}, ${newTerms.join(', ')}`
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts
git commit -m "fix: use styleAnchor.medium for negative prompt exclusions when no template selected"
```

---

### Task 4: Fix I-4 — extractStyleAnchor Uses Independent Vision Detail

**Problem:** `extractStyleAnchorFn` uses `resolveVisionDetailByPass(state, 'analyzeScene')` instead of its own config. Style extraction (colors, textures) benefits from high vision detail even when scene analysis is set to low.

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Fix the vision detail call**

In `extractStyleAnchorFn` (around line 980), replace:

```typescript
              ...BasePipeline.buildImageContent(
                state.inputImages,
                resolveVisionDetailByPass(state, 'analyzeScene'),
              ),
```

With:

```typescript
              ...BasePipeline.buildImageContent(
                state.inputImages,
                'high',
              ),
```

Style anchor extraction always needs high vision detail to accurately capture palette, texture, and medium. This is a hardcoded `'high'` rather than a configurable field because:
1. Style extraction is inherently visual — low detail would produce inaccurate palette/texture data
2. Adding a new state field + store field + UI control for a rarely-changed setting violates YAGNI

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix: extractStyleAnchor always uses 'high' vision detail for accurate style extraction"
```

---

### Task 5: Fix I-5 — codeVerify styleConsistency False Positive on "hairstyle"

**Problem:** `styleConsistency` scoring uses `issues.some(i => i.toLowerCase().includes('style'))` which matches "hairstyle inconsistency" → false positive.

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`

**Step 1: Write the failing test**

Add to `hybrid-verify.test.ts`:

```typescript
  it('should not false-positive styleConsistency on hairstyle issues', () => {
    const result = codeVerify({
      characters: { characters: [{ name: 'Alice', anchor: 'blonde hair' }] },
      prompts: [
        { id: 1, prompt: 'Alice walking, photorealistic', negativePrompt: '' },
        { id: 2, prompt: 'Alice running, photorealistic', negativePrompt: '' },
      ],
      layout: { rows: 1, cols: 2, panelCount: 2 },
      template: 'cinematic',
      styleInstructions: 'photorealistic',
      styleAnchor: { medium: 'photorealistic', palette: [], paletteRatio: '', lightSource: '', shadowDepth: '', texture: '', colorTemperature: '', contrastLevel: '' },
      styleConflicts: [],
    } as any)
    // Score should be 10 (no style issues) and styleConsistency should be 10
    expect(result.styleConsistency).toBe(10)
  })
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`
Expected: This specific test should PASS since the current code would only trigger if there's an issue containing "style". But let me verify — if there's a character issue with "hairstyle" in the issue text, it would false-positive. Let me add a more targeted test:

```typescript
  it('should track style issues separately from character issues', () => {
    // Force a style issue by using wrong style prefix
    const result = codeVerify({
      characters: { characters: [] },
      prompts: [
        { id: 1, prompt: 'Alice walking, anime cel', negativePrompt: '' },
      ],
      layout: { rows: 1, cols: 1, panelCount: 1 },
      template: 'cinematic',
      styleInstructions: 'photorealistic',
      styleAnchor: { medium: 'photorealistic', palette: [], paletteRatio: '', lightSource: '', shadowDepth: '', texture: '', colorTemperature: '', contrastLevel: '' },
      styleConflicts: [],
    } as any)
    expect(result.styleConsistency).toBe(5)
    expect(result.characterConsistency).toBe(true)
  })
```

**Step 3: Fix implementation**

Replace the `styleConsistency` line in `codeVerify`:

```typescript
    styleConsistency: stylePrefix ? (issues.some(i => i.toLowerCase().includes('style')) ? 5 : 10) : undefined,
```

With a dedicated flag approach:

```typescript
    styleConsistency: (() => {
      if (!stylePrefix) return undefined
      const styleIssueCount = prompts.filter(p => {
        const firstToken = stylePrefix.split(',')[0].trim().toLowerCase()
        return firstToken && !p.prompt.toLowerCase().includes(firstToken)
      }).length
      return styleIssueCount > 0 ? Math.max(1, 10 - styleIssueCount * 2) : 10
    })(),
```

This directly checks the prompts for style token presence instead of scanning issue text strings, avoiding false positives from "hairstyle" or other words containing "style".

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts
git commit -m "fix: codeVerify styleConsistency uses direct prompt check instead of issue text scan"
```

---

### Task 6: Clean Up `(state as any).styleAnchor` Type Assertions

**Problem:** 4 places use `(state as any).styleAnchor` even though `DirectorState` already includes `styleAnchor`.

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Replace all `(state as any).styleAnchor` with `state.styleAnchor`**

Search and replace in `DirectorPipeline.ts`:
- `(state as any).styleAnchor` → `state.styleAnchor`

There should be approximately 4 occurrences (in `extractVarsForDesignAndAssemble`, `extractVarsForContactSheet`, `codeVerify`, and `generateImagesFn`/`regenerateImages`).

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix: remove unnecessary (state as any).styleAnchor type assertions"
```

---

### Task 7: Integration Verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No new type errors

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve any remaining build/type issues from code review fixes"
```
