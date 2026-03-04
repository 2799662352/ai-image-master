# Prompt-Image Conflict Resolution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix reference image / prompt text conflicts in Director mode's multi-modal image generation by restructuring the compositePrompt, adding explicit reference image role rules, injecting style tokens into panel prompts, and auto-enhancing negative prompts — all without any extra LLM calls.

**Architecture:** Pure prompt template and code-level modifications within existing `extractVarsForContactSheet()`, `generateImagesFn`, and `regenerateImages`. Three components: (A) reference image role separation, (B) prompt structure inversion + style token injection, (C) adaptive negative prompt.

**Tech Stack:** TypeScript, Vitest, prompt template (.md)

**Design Doc:** `docs/plans/2026-03-05-prompt-conflict-resolution-design.md`

---

### Task 1: Add `resolveStylePrefix` and `buildAdaptiveNegativePrompt` Helpers

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`

**Step 1: Write the failing test**

Create file `src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { resolveStylePrefix, buildAdaptiveNegativePrompt } from '../DirectorPipeline'

describe('resolveStylePrefix', () => {
  it('should return styleAnchor medium when available', () => {
    const anchor = {
      medium: 'photorealistic',
      palette: ['#000'], paletteRatio: '1', lightSource: '', shadowDepth: '',
      texture: '', colorTemperature: '', contrastLevel: '',
    }
    expect(resolveStylePrefix(anchor, 'cinematic', '')).toBe('photorealistic')
  })

  it('should fallback to template medium map when no styleAnchor', () => {
    expect(resolveStylePrefix(null, 'cinematic', '')).toBe('photorealistic, cinematic photography')
  })

  it('should fallback to template medium map for anime', () => {
    expect(resolveStylePrefix(null, 'anime', '')).toBe('anime screencap, TV anime')
  })

  it('should return empty string for unknown template without styleAnchor', () => {
    expect(resolveStylePrefix(null, 'unknown-template', '')).toBe('')
  })

  it('should return empty string when no template and no anchor', () => {
    expect(resolveStylePrefix(null, '', '')).toBe('')
  })
})

describe('buildAdaptiveNegativePrompt', () => {
  it('should add anime exclusions for cinematic template', () => {
    const result = buildAdaptiveNegativePrompt('blurry, lowres', 'cinematic', null)
    expect(result).toContain('anime')
    expect(result).toContain('cartoon')
    expect(result).toContain('cel shading')
    expect(result).toContain('blurry')
  })

  it('should add photorealistic exclusions for anime template', () => {
    const result = buildAdaptiveNegativePrompt('blurry, lowres', 'anime', null)
    expect(result).toContain('photorealistic')
    expect(result).toContain('real person')
    expect(result).not.toContain('anime')
  })

  it('should not duplicate existing terms', () => {
    const result = buildAdaptiveNegativePrompt('blurry, anime, cartoon', 'cinematic', null)
    const parts = result.split(',').map(s => s.trim().toLowerCase())
    const animeCount = parts.filter(p => p === 'anime').length
    expect(animeCount).toBe(1)
  })

  it('should return base unchanged for unknown template', () => {
    const base = 'blurry, lowres'
    expect(buildAdaptiveNegativePrompt(base, 'unknown', null)).toBe(base)
  })

  it('should return base unchanged for empty template', () => {
    const base = 'blurry, lowres'
    expect(buildAdaptiveNegativePrompt(base, '', null)).toBe(base)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`
Expected: FAIL — `resolveStylePrefix` and `buildAdaptiveNegativePrompt` not exported

**Step 3: Write minimal implementation**

Add to `src/renderer/src/services/pipeline/DirectorPipeline.ts` (after `buildStyleAuthorityPrompt`, around line 378):

```typescript
const TEMPLATE_MEDIUM_MAP: Record<string, string> = {
  cinematic: 'photorealistic, cinematic photography',
  movie: 'cinematic film still',
  anime: 'anime screencap, TV anime',
  manga: 'manga panel, black and white',
  theatrical: 'theatrical anime film screenshot',
  webtoon: 'webtoon style, full color',
  comic: 'american comic style',
  illustration: 'detailed illustration',
}

export function resolveStylePrefix(
  styleAnchor: { medium?: string } | null,
  templateKey: string,
  _styleInstructions: string,
): string {
  if (styleAnchor?.medium) return styleAnchor.medium
  return TEMPLATE_MEDIUM_MAP[templateKey] || ''
}

const STYLE_EXCLUSION_MAP: Record<string, string[]> = {
  cinematic: ['anime', 'cartoon', 'illustration', 'cel shading', '2D', 'drawn', 'painting', 'sketch'],
  movie: ['anime', 'cartoon', 'illustration', 'cel shading', '2D', 'drawn', 'painting'],
  anime: ['photorealistic', 'real person', 'photograph', 'live-action', '3D render', 'CGI'],
  theatrical: ['photorealistic', 'real person', 'photograph', 'live-action', '3D render'],
  manga: ['photorealistic', 'real person', 'color', '3D render', 'anime coloring'],
  webtoon: ['photorealistic', 'real person', 'black and white', 'monochrome', '3D render'],
  comic: ['photorealistic', 'real person', 'anime', 'soft shading', '3D render'],
  illustration: ['photorealistic', 'real person', 'anime screencap', '3D render'],
}

export function buildAdaptiveNegativePrompt(
  baseNegative: string,
  templateKey: string,
  _styleAnchor: { medium?: string } | null,
): string {
  const exclusions = STYLE_EXCLUSION_MAP[templateKey] || []
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
git commit -m "feat: add resolveStylePrefix and buildAdaptiveNegativePrompt helpers"
```

---

### Task 2: Add `buildReferenceImageRoleRules` Helper

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`

**Step 1: Write the failing test**

Append to `prompt-conflict-resolution.test.ts`:

```typescript
import { buildReferenceImageRoleRules } from '../DirectorPipeline'

describe('buildReferenceImageRoleRules', () => {
  it('should return strict rules when template is set', () => {
    const result = buildReferenceImageRoleRules('cinematic', true)
    expect(result).toContain('DO NOT extract')
    expect(result).toContain('TEXT WINS')
    expect(result).toContain('Character identity')
  })

  it('should return relaxed rules when no template', () => {
    const result = buildReferenceImageRoleRules('', false)
    expect(result).toContain('reference images')
    expect(result).not.toContain('TEXT WINS')
  })

  it('should return relaxed rules for default template', () => {
    const result = buildReferenceImageRoleRules('default', false)
    expect(result).not.toContain('TEXT WINS')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`
Expected: FAIL — `buildReferenceImageRoleRules` not exported

**Step 3: Write minimal implementation**

Add to `DirectorPipeline.ts` (after `buildAdaptiveNegativePrompt`):

```typescript
export function buildReferenceImageRoleRules(
  templateKey: string,
  hasStyleAnchor: boolean,
): string {
  const hasExplicitStyle = templateKey && templateKey !== 'default' && templateKey !== ''

  if (!hasExplicitStyle && !hasStyleAnchor) {
    return [
      'REFERENCE IMAGE GUIDELINES:',
      '- Follow the visual style of the reference images and keep stylistic continuity across all panels.',
      '- Maintain character identity consistency from reference images.',
    ].join('\n')
  }

  return [
    'REFERENCE IMAGE USAGE RULES (BINDING):',
    '- From reference images, extract ONLY:',
    '  ✓ Character identity: face structure, hairstyle, body proportions, outfit details',
    '  ✓ Character props: weapons, accessories, distinctive items',
    '  ✓ Scene spatial layout (if applicable to the story)',
    '- From reference images, DO NOT extract:',
    '  ✗ Rendering medium or art style (follow TEXT style directive instead)',
    '  ✗ Color grading or palette (follow style anchor instead)',
    '  ✗ Lighting setup (follow panel-specific lighting in prompts)',
    '- If reference images conflict with the text style directive:',
    '  → TEXT WINS. Always. No exceptions.',
  ].join('\n')
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts
git commit -m "feat: add buildReferenceImageRoleRules for explicit image/text boundary"
```

---

### Task 3: Update `extractVarsForContactSheet` with New Variables

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (function `extractVarsForContactSheet`, line ~394)
- Modify: `src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`

**Step 1: Write the failing test**

Append to `prompt-conflict-resolution.test.ts`:

```typescript
import { extractVarsForContactSheet } from '../DirectorPipeline'

describe('extractVarsForContactSheet conflict resolution vars', () => {
  const makeState = (overrides: Record<string, unknown> = {}) => ({
    scene: { env: 'test city', subjects: [], style: '', story: '' },
    characters: { characters: [] },
    sceneDescription: '',
    styleInstructions: 'photorealistic, 8K, cinematic',
    layout: { rows: 2, cols: 3, panelCount: 6 },
    prompts: [{ id: 1, prompt: 'a person walking', negativePrompt: 'blurry' }],
    ratio: '16:9',
    semanticOrientation: 'landscape',
    inputImages: [],
    template: 'cinematic',
    styleAnchor: null,
    styleConflicts: [],
    ...overrides,
  })

  it('should include reference_image_role_rules with strict rules when template is set', () => {
    const vars = extractVarsForContactSheet(makeState() as any)
    expect(vars.reference_image_role_rules).toContain('TEXT WINS')
  })

  it('should include relaxed rules when no template', () => {
    const vars = extractVarsForContactSheet(makeState({ template: '', styleInstructions: '' }) as any)
    expect(vars.reference_image_role_rules).not.toContain('TEXT WINS')
  })

  it('should include enhanced_panel_descriptions with style prefix', () => {
    const state = makeState({
      prompts: [
        { id: 1, prompt: 'a person walking in rain', negativePrompt: 'blurry' },
        { id: 2, prompt: 'close-up of face', negativePrompt: 'blurry' },
      ],
    })
    const vars = extractVarsForContactSheet(state as any)
    expect(vars.enhanced_panel_descriptions).toContain('photorealistic, cinematic photography')
  })

  it('should include adaptive_negative_prompt', () => {
    const vars = extractVarsForContactSheet(makeState() as any)
    expect(vars.adaptive_negative_prompt).toContain('anime')
    expect(vars.adaptive_negative_prompt).toContain('cartoon')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`
Expected: FAIL — `reference_image_role_rules`, `enhanced_panel_descriptions`, `adaptive_negative_prompt` are undefined

**Step 3: Write minimal implementation**

Modify `extractVarsForContactSheet` in `DirectorPipeline.ts`. Add these new entries to the returned object (after `panel_descriptions`):

```typescript
    reference_image_role_rules: buildReferenceImageRoleRules(
      state.template,
      !!(state as any).styleAnchor,
    ),
    enhanced_panel_descriptions: (() => {
      const stylePrefix = resolveStylePrefix(
        (state as any).styleAnchor,
        state.template,
        state.styleInstructions,
      )
      const enhanced = prompts.map(p => {
        const base = p.prompt
        const prefixed = stylePrefix && !base.toLowerCase().startsWith(stylePrefix.toLowerCase())
          ? `${stylePrefix}, ${base}`
          : base
        return `  Panel ${p.id}: [shot cut] ${prefixed}`
      }).join('\n')
      return `${globalSection}${userDirection}${characterIdentityLockSummary ? `\n\n${characterIdentityLockSummary}` : ''}\n\nSTORYBOARD GRID ${state.layout.rows}x${state.layout.cols}:\n${enhanced}`
    })(),
    adaptive_negative_prompt: buildAdaptiveNegativePrompt(
      prompts[0]?.negativePrompt || 'blurry, deformed, bad anatomy, watermark, signature, text, labels, captions, panel numbers, irregular panels, asymmetric grid, unequal panels',
      state.template,
      (state as any).styleAnchor,
    ),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/prompt-conflict-resolution.test.ts
git commit -m "feat: add reference_image_role_rules, enhanced_panel_descriptions, adaptive_negative_prompt to contact sheet vars"
```

---

### Task 4: Restructure Contact Sheet Prompt Template

**Files:**
- Modify: `config/prompts/director/pass6-contact-sheet.md`

**Step 1: Update the template**

Replace the entire content of `config/prompts/director/pass6-contact-sheet.md`:

```markdown
---
pass: 5
name: generateImages
label: 图像生成
type: image-prompt
---

{{style_directive_section}}
{{style_anchor_section}}
{{reference_image_role_rules}}

Cinematic Contact Sheet, ONE single master image, {{grid_rows}} rows x {{grid_cols}} columns storyboard grid, {{panel_count}} panels total.

STRICT GRID GEOMETRY RULES:
- The entire image uses {{overall_ratio}} aspect ratio.
- The grid is divided into EXACTLY {{grid_rows}} equal rows and {{grid_cols}} equal columns.
- Every panel MUST be EXACTLY the same size — each panel is {{panel_ratio}} ({{panel_orientation}}).
- {{semantic_orientation_instruction}}
- Panels fill the ENTIRE image edge-to-edge with only thin 1-2px dark dividing lines between them.
- NO margins, NO padding, NO header/footer area outside the grid.
- NO text, NO labels, NO captions, NO annotations, NO panel numbers inside or outside the panels.
- Each panel is a distinct camera shot — NO blending between panels.

{{character_identity_section}}
Panel descriptions:
{{enhanced_panel_descriptions}}
```

Key changes from original:
1. Style sections moved to TOP (was after grid rules)
2. `{{reference_image_role_rules}}` injected right after style
3. Removed hardcoded "MATCH the visual style of the reference images exactly" (now handled by role rules)
4. `{{enhanced_panel_descriptions}}` replaces `{{panel_descriptions}}` (includes style prefix per panel)

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add config/prompts/director/pass6-contact-sheet.md
git commit -m "feat: restructure contact sheet prompt — style-first + reference image role separation"
```

---

### Task 5: Update `generateImagesFn` to Use Adaptive Negative Prompt

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (`generateImagesFn` around line 1137, and `regenerateImages` around line 1420)

**Step 1: Modify negativePrompt in `generateImagesFn`**

Replace the existing negativePrompt line (line ~1137):

```typescript
        const negativePrompt = prompts[0]?.negativePrompt ||
          'blurry, deformed, bad anatomy, watermark, signature, text, labels, captions, panel numbers, irregular panels, asymmetric grid, unequal panels'
```

With:

```typescript
        const baseNegative = prompts[0]?.negativePrompt ||
          'blurry, deformed, bad anatomy, watermark, signature, text, labels, captions, panel numbers, irregular panels, asymmetric grid, unequal panels'
        const negativePrompt = buildAdaptiveNegativePrompt(baseNegative, state.template, (state as any).styleAnchor)
```

**Step 2: Apply same change in `regenerateImages`**

Find the negativePrompt line in `regenerateImages` method and apply the same pattern.

**Step 3: Update inline fallback prompt**

In the inline fallback (when no template file exists), replace:

```typescript
              vars.style_directive_section,
              vars.style_anchor_section,
              `Panel descriptions:\n${vars.panel_descriptions}`,
```

With:

```typescript
              vars.style_directive_section,
              vars.style_anchor_section,
              vars.reference_image_role_rules,
              `Panel descriptions:\n${vars.enhanced_panel_descriptions}`,
```

Apply same change in `regenerateImages` method's inline fallback.

**Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat: wire adaptive negative prompt and enhanced panel descriptions into generateImages"
```

---

### Task 6: Update director-style-consistency Skill

**Files:**
- Modify: `skills/director-style-consistency/SKILL.md` (if exists from style-anchor plan, otherwise create)

**Step 1: Update or create the skill**

```markdown
---
name: director-style-consistency
description: Use when verifying or enforcing cross-panel style uniformity and resolving image-text style conflicts
appliesTo: [extractStyleAnchor, verifyConsistency, designAndAssemble, generateImages]
priority: 5
---

Style Consistency & Conflict Resolution Rules:

## Cross-Panel Uniformity
- All panels in a contact sheet MUST share a single rendering medium — never mix.
- Color temperature shifts between panels are only allowed when motivated by time-of-day changes.
- Texture quality (film grain density, cel shading weight) must remain uniform.

## Image-Text Conflict Resolution
- When a user Template is selected, the Template's implied medium is the authoritative source.
- Reference images provide CHARACTER IDENTITY only — face, hair, body, outfit, props.
- Reference images do NOT define rendering medium, color grading, or lighting.
- If reference image style contradicts user Template: TEXT WINS. Always.
- Style keywords in panel prompts must not contradict the resolved style anchor.

## Negative Prompt Reinforcement
- When the desired style is photorealistic, negative prompts must include: anime, cartoon, illustration, cel shading.
- When the desired style is anime, negative prompts must include: photorealistic, real person, photograph.
- This prevents the image generation model from drifting toward the reference image's original style.
```

**Step 2: Commit**

```bash
git add skills/director-style-consistency/SKILL.md
git commit -m "feat: update director-style-consistency skill with conflict resolution rules"
```

---

### Task 7: Integration Verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve any build/type issues from prompt conflict resolution"
```
