# Style Anchor Extraction & User Intent Priority — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix style inconsistency in Director mode by adding an `extractStyleAnchor` pipeline node that runs in parallel with scene/character analysis, enforcing a three-tier user intent priority chain across all downstream passes.

**Architecture:** New parallel LangGraph node `extractStyleAnchor` produces structured style data. A merge function resolves conflicts between user Template choice and image analysis. The resolved style anchor is injected into `designAndAssemble`, `verifyConsistency`, and `generateImages` prompts. A new `director-style-consistency` skill is added.

**Tech Stack:** LangGraph (StateGraph parallel nodes), Zod schemas, Vitest, TypeScript

**Design Doc:** `docs/plans/2026-03-04-style-anchor-consistency-design.md`

---

### Task 1: Add StyleAnchor Schema

**Files:**
- Create: `src/renderer/src/services/pipeline/schemas/style-anchor-schema.ts`
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/style-anchor-schema.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/services/pipeline/__tests__/style-anchor-schema.test.ts
import { describe, expect, it } from 'vitest'
import { StyleAnchorSchema, StyleConflictSchema } from '../schemas/style-anchor-schema'

describe('StyleAnchorSchema', () => {
  it('should parse a valid style anchor', () => {
    const result = StyleAnchorSchema.safeParse({
      medium: 'photorealistic',
      palette: ['#1a1a2e', '#16213e', '#e94560'],
      paletteRatio: '7:2:1',
      lightSource: 'rim light, 45° top-left, 70%',
      shadowDepth: '30%',
      texture: 'film grain, subtle noise',
      colorTemperature: 'warm, ~3500K',
      contrastLevel: 'high',
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing required fields', () => {
    const result = StyleAnchorSchema.safeParse({ medium: 'anime' })
    expect(result.success).toBe(false)
  })
})

describe('StyleConflictSchema', () => {
  it('should parse a valid conflict entry', () => {
    const result = StyleConflictSchema.safeParse({
      field: 'medium',
      userWants: 'photorealistic',
      imageShows: 'anime cel',
    })
    expect(result.success).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/style-anchor-schema.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/renderer/src/services/pipeline/schemas/style-anchor-schema.ts
import { z } from 'zod'

export const StyleAnchorSchema = z.object({
  medium: z.string().describe('Rendering medium: photorealistic, anime cel, 3D CGI, watercolor, etc.'),
  palette: z.array(z.string()).describe('Dominant color hex codes, 2-5 colors'),
  paletteRatio: z.string().describe('Color ratio, e.g. "7:2:1"'),
  lightSource: z.string().describe('Light type + angle + intensity, e.g. "rim light, 45° top-left, 70%"'),
  shadowDepth: z.string().describe('% of frame in shadow, e.g. "30%"'),
  texture: z.string().describe('Surface quality: film grain, cel shading, painterly strokes, etc.'),
  colorTemperature: z.string().describe('Warm/cool + Kelvin estimate, e.g. "warm, ~3500K"'),
  contrastLevel: z.string().describe('Contrast: high / medium / low'),
})

export type StyleAnchor = z.infer<typeof StyleAnchorSchema>

export const StyleConflictSchema = z.object({
  field: z.string(),
  userWants: z.string(),
  imageShows: z.string(),
})

export type StyleConflict = z.infer<typeof StyleConflictSchema>
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/style-anchor-schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/schemas/style-anchor-schema.ts src/renderer/src/services/pipeline/__tests__/style-anchor-schema.test.ts
git commit -m "feat: add StyleAnchor and StyleConflict Zod schemas"
```

---

### Task 2: Add Style Anchor State to Pipeline

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (lines 35-87, stateSchema)
- Test: `src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts` (add style anchor tests)

**Step 1: Write the failing test**

Append to `src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`:

```typescript
import { extractVarsForDesignAndAssemble, extractVarsForContactSheet } from '../DirectorPipeline'

describe('style anchor in extractVarsForDesignAndAssemble', () => {
  it('should include style_authority_chain when styleAnchor is present', () => {
    const state = {
      scene: { env: 'test', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      sceneDescription: '',
      styleInstructions: '',
      layout: { rows: 2, cols: 3, panelCount: 6 },
      retryFeedback: '',
      prompts: null,
      styleAnchor: {
        medium: 'photorealistic',
        palette: ['#000', '#fff'],
        paletteRatio: '1:1',
        lightSource: 'key light, front, 80%',
        shadowDepth: '20%',
        texture: 'film grain',
        colorTemperature: 'neutral, ~5500K',
        contrastLevel: 'medium',
      },
      styleConflicts: [],
    }
    const vars = extractVarsForDesignAndAssemble(state as any)
    expect(vars.style_authority_chain).toContain('photorealistic')
    expect(vars.style_authority_chain).toContain('film grain')
  })

  it('should return empty style_authority_chain when styleAnchor is null', () => {
    const state = {
      scene: { env: 'test', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      sceneDescription: '',
      styleInstructions: '',
      layout: { rows: 2, cols: 3, panelCount: 6 },
      retryFeedback: '',
      prompts: null,
      styleAnchor: null,
      styleConflicts: [],
    }
    const vars = extractVarsForDesignAndAssemble(state as any)
    expect(vars.style_authority_chain).toBe('')
  })
})

describe('style anchor in extractVarsForContactSheet', () => {
  it('should include style_anchor_section when styleAnchor is present', () => {
    const state = {
      scene: { env: 'test', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      sceneDescription: '',
      styleInstructions: '',
      layout: { rows: 2, cols: 3, panelCount: 6 },
      prompts: [],
      ratio: '16:9',
      semanticOrientation: 'landscape',
      inputImages: [],
      styleAnchor: {
        medium: 'anime cel',
        palette: ['#ff0000'],
        paletteRatio: '1',
        lightSource: 'fill, even, 50%',
        shadowDepth: '10%',
        texture: 'cel shading',
        colorTemperature: 'cool, ~7000K',
        contrastLevel: 'low',
      },
      styleConflicts: [],
    }
    const vars = extractVarsForContactSheet(state as any)
    expect(vars.style_anchor_section).toContain('anime cel')
    expect(vars.style_anchor_section).toContain('cel shading')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: FAIL — `style_authority_chain` is undefined

**Step 3: Write minimal implementation**

In `src/renderer/src/services/pipeline/DirectorPipeline.ts`:

3a. Add import at top (after existing imports):
```typescript
import { StyleAnchorSchema, StyleConflictSchema } from './schemas/style-anchor-schema'
import type { StyleAnchor, StyleConflict } from './schemas/style-anchor-schema'
```

3b. Add two new fields to `stateSchema` (after line 84, `skipCharacterAnchors`):
```typescript
  styleAnchor: StyleAnchorSchema.nullable().default(null),
  styleConflicts: z.array(StyleConflictSchema).default([]),
```

3c. Modify `extractVarsForDesignAndAssemble` (line 180) — add style authority chain at the end of the returned object:
```typescript
    style_authority_chain: (() => {
      const anchor = state.styleAnchor
      if (!anchor) return ''
      const conflicts = (state as any).styleConflicts || []
      const conflictsLog = conflicts.length > 0
        ? conflicts.map((c: StyleConflict) => `  - ${c.field}: user wants "${c.userWants}" but image shows "${c.imageShows}" → using user choice`).join('\n')
        : '  (none)'
      return [
        '## Style Authority Chain (BINDING)',
        '',
        '1. USER EXPLICIT STYLE (from Template/sceneDescription):',
        `   ${state.styleInstructions || '(no template selected)'}`,
        '',
        '2. STYLE ANCHOR (from reference image analysis):',
        `   Medium: ${anchor.medium}`,
        `   Palette: ${anchor.palette.join(', ')} at ratio ${anchor.paletteRatio}`,
        `   Lighting: ${anchor.lightSource}, shadow depth ${anchor.shadowDepth}`,
        `   Texture: ${anchor.texture}`,
        `   Color temperature: ${anchor.colorTemperature}`,
        `   Contrast: ${anchor.contrastLevel}`,
        '',
        '3. CONFLICTS RESOLVED:',
        conflictsLog,
        '',
        'EVERY panel prompt MUST include these style tokens for cross-panel consistency.',
        'User explicit style takes priority over image analysis on conflicting fields.',
      ].join('\n')
    })(),
```

3d. Modify `extractVarsForContactSheet` (line 310) — add `style_anchor_section` to returned object:
```typescript
    style_anchor_section: (() => {
      const anchor = (state as any).styleAnchor
      if (!anchor) return ''
      return [
        'STYLE ANCHOR (apply to ALL panels uniformly):',
        `Medium: ${anchor.medium}`,
        `Palette: ${anchor.palette?.join(', ')} at ratio ${anchor.paletteRatio}`,
        `Lighting: ${anchor.lightSource}, shadow depth ${anchor.shadowDepth}`,
        `Texture: ${anchor.texture}`,
        `Color temperature: ${anchor.colorTemperature}`,
        'DO NOT deviate from this style in any panel.',
      ].join('\n')
    })(),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts
git commit -m "feat: add styleAnchor + styleConflicts to pipeline state and template extractors"
```

---

### Task 3: Create `extractStyleAnchor` Node Function

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (add node function inside `buildGraph()`)

**Step 1: Write the failing test**

Add to `director-skip-stages.test.ts`:

```typescript
describe('buildStyleAuthorityPrompt', () => {
  it('should produce a prompt with user template priority when template is set', () => {
    // This tests the exported helper; the actual node test is integration-level
    const { buildStyleAuthorityPrompt } = require('../DirectorPipeline')
    const result = buildStyleAuthorityPrompt(
      'cinematic',
      'Cinematic Contact Sheet, award-winning...',
      'cyberpunk rain chase scene',
    )
    expect(result).toContain('cinematic')
    expect(result).toContain('USER EXPLICIT')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: FAIL — `buildStyleAuthorityPrompt` not exported

**Step 3: Write minimal implementation**

In `src/renderer/src/services/pipeline/DirectorPipeline.ts`:

3a. Add exported helper function (after `buildRetryFeedback`, around line 294):

```typescript
export function buildStyleAuthorityPrompt(
  templateKey: string,
  styleInstructions: string,
  sceneDescription: string,
): string {
  const hasTemplate = templateKey && templateKey !== 'default' && styleInstructions
  const lines: string[] = []

  if (hasTemplate) {
    lines.push(
      `USER EXPLICIT STYLE (Priority 1 — NON-NEGOTIABLE):`,
      `Template: "${templateKey}"`,
      `Style directive: ${styleInstructions}`,
      `These style fields are locked by the user. Do NOT override with reference image analysis.`,
    )
  }

  if (sceneDescription) {
    const styleHints = extractStyleHintsFromDescription(sceneDescription)
    if (styleHints.length > 0) {
      lines.push(
        '',
        `USER NARRATIVE STYLE HINTS (Priority 2):`,
        ...styleHints.map(h => `  - ${h}`),
        `These hints complement the template but do not override it.`,
      )
    }
  }

  return lines.join('\n')
}

const STYLE_KEYWORDS = [
  'photorealistic', 'anime', 'watercolor', 'oil painting', 'sketch',
  'cyberpunk', 'steampunk', 'noir', 'neon', 'pastel', 'vintage',
  'monochrome', 'sepia', '3D', 'CGI', 'pixel art', 'cel shading',
  'impressionist', 'minimalist', 'retro', 'futuristic',
  '写实', '动漫', '水彩', '赛博朋克', '蒸汽朋克', '黑白', '复古',
]

function extractStyleHintsFromDescription(desc: string): string[] {
  const lower = desc.toLowerCase()
  return STYLE_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()))
}
```

3b. Add the `extractStyleAnchorFn` node inside `buildGraph()` (after `extractCharacterAnchorsFn`, before `selectSkillsFn`):

```typescript
    // ===== Pass 1.5: 风格锚点提取 (parallel with Pass 1+2) =====
    const extractStyleAnchorFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()

      if (state.inputImages.length === 0) {
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('extractStyleAnchor', { pass: 1, label: '风格锚点' }, { styleAnchor: null, skipped: true }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: 1, label: '风格锚点（无参考图，已跳过）', elapsed, passData })
        return { styleAnchor: null, styleConflicts: [] }
      }

      try {
        const appliedSkills = self.getSkillsForPhase('extractStyleAnchor', state as Record<string, unknown>)
        const structuredWithRaw = self.createStructuredLLMWithRaw(
          z.object({
            styleAnchor: StyleAnchorSchema,
            conflicts: z.array(StyleConflictSchema).default([]),
          })
        )

        const userStyleContext = buildStyleAuthorityPrompt(
          state.template,
          state.styleInstructions,
          state.sceneDescription,
        )

        const systemPrompt = self.resolveSystemPrompt(
          'extractStyleAnchor', {},
          state as Record<string, unknown>,
          [
            'You are a visual style analyst. Extract the VISUAL STYLE (not content) from the reference images.',
            '',
            'Output a structured style anchor covering: medium, palette (2-5 hex codes), paletteRatio, lightSource, shadowDepth, texture, colorTemperature, contrastLevel.',
            '',
            'IMPORTANT — User Style Authority:',
            userStyleContext || '(No user style directive provided. Derive all fields from image analysis.)',
            '',
            'If the reference images show a DIFFERENT medium/style than what the user selected:',
            '- Report the conflict in the "conflicts" array',
            '- The final "medium" field MUST reflect the USER\'S choice, NOT the reference image',
            '- Use the reference image ONLY for fields the user did NOT explicitly specify',
          ].join('\n'),
        )

        const response = await structuredWithRaw.invoke([
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              ...BasePipeline.buildImageContent(
                state.inputImages,
                resolveVisionDetailByPass(state, 'analyzeScene'),
              ),
              { type: 'text' as const, text: 'Extract the visual style anchor from these reference images. Focus on style attributes only, not content.' },
            ],
          },
        ])

        let parsed = (response as any)?.parsed
        if (!parsed?.styleAnchor?.medium) {
          const rawText = typeof (response as any)?.raw?.content === 'string'
            ? (response as any).raw.content : ''
          try {
            const match = rawText.match(/\{[\s\S]*"medium"\s*:[\s\S]*\}/)
            if (match) {
              const fallback = JSON.parse(match[0])
              if (fallback?.medium) parsed = { styleAnchor: fallback, conflicts: [] }
              else if (fallback?.styleAnchor?.medium) parsed = fallback
            }
          } catch { /* fallback below */ }
        }

        if (!parsed?.styleAnchor?.medium) {
          console.warn('[DirectorPipeline] extractStyleAnchor: extraction failed, skipping')
          const elapsed = Date.now() - t0
          writer(config)?.({ type: 'pass_complete', pass: 1, label: '风格锚点（提取失败，已跳过）', elapsed, passData: null })
          return { styleAnchor: null, styleConflicts: [] }
        }

        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData(
          'extractStyleAnchor', { pass: 1, label: '风格锚点' },
          { styleAnchor: parsed.styleAnchor, conflicts: parsed.conflicts },
          elapsed, appliedSkills,
        )
        writer(config)?.({
          type: 'pass_complete', pass: 1,
          label: `风格锚点提取完成 (${(elapsed / 1000).toFixed(1)}s)`,
          elapsed, passData,
        })

        return {
          styleAnchor: parsed.styleAnchor,
          styleConflicts: parsed.conflicts || [],
        }
      } catch (err: unknown) {
        console.warn('[DirectorPipeline] extractStyleAnchor failed:', err instanceof Error ? err.message : String(err))
        const elapsed = Date.now() - t0
        writer(config)?.({ type: 'pass_complete', pass: 1, label: '风格锚点（异常，已跳过）', elapsed, passData: null })
        return { styleAnchor: null, styleConflicts: [] }
      }
    }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts
git commit -m "feat: add extractStyleAnchor node function and buildStyleAuthorityPrompt helper"
```

---

### Task 4: Wire `extractStyleAnchor` into LangGraph

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (graph assembly section, lines 1020-1057)

**Step 1: Modify graph assembly**

In the `buildGraph()` method, change the graph assembly to add the new node and wire it in parallel:

Replace the existing graph assembly (lines 1022-1057):

```typescript
    const graph = new StateGraph(stateSchema)
      .addNode('selectSkills', selectSkillsFn)
      .addNode('analyzeScene', analyzeSceneFn, { retryPolicy: retryLLM })
      .addNode('extractCharacterAnchors', extractCharacterAnchorsFn, { retryPolicy: retryLLM })
      .addNode('extractStyleAnchor', extractStyleAnchorFn, { retryPolicy: retryLLM })
      .addNode('validateAnalysis', validateAnalysisFn)
      .addNode('prepareAnalysisRetry', prepareAnalysisRetryFn)
      .addNode('abortPipeline', abortPipelineFn)
      .addNode('designAndAssemble', designAndAssembleFn)
      .addNode('verifyConsistency', verifyConsistencyFn)
      .addNode('prepareRetry', prepareRetryFn)
      .addNode('generateImages', generateImagesFn)
      .addEdge(START, 'selectSkills')
      .addEdge('selectSkills', 'analyzeScene')
      .addEdge('selectSkills', 'extractCharacterAnchors')
      .addEdge('selectSkills', 'extractStyleAnchor')
      .addEdge(['analyzeScene', 'extractCharacterAnchors', 'extractStyleAnchor'], 'validateAnalysis')
      .addConditionalEdges('validateAnalysis', routeAfterAnalysis, {
        continue: 'designAndAssemble',
        retry: 'prepareAnalysisRetry',
        abort: 'abortPipeline',
      })
      .addEdge('prepareAnalysisRetry', 'analyzeScene')
      .addEdge('prepareAnalysisRetry', 'extractCharacterAnchors')
      .addEdge('abortPipeline', END)
      .addConditionalEdges('designAndAssemble', routeAfterDesign, {
        verify: 'verifyConsistency',
        generate: 'generateImages',
      })
      .addConditionalEdges('verifyConsistency', routeVerify, {
        retry: 'prepareRetry',
        generate: 'generateImages',
      })
      .addEdge('prepareRetry', 'designAndAssemble')
      .addEdge('generateImages', END)
```

Key changes:
1. Added `.addNode('extractStyleAnchor', extractStyleAnchorFn, { retryPolicy: retryLLM })`
2. Added `.addEdge('selectSkills', 'extractStyleAnchor')` for parallel execution
3. Changed fan-in from `['analyzeScene', 'extractCharacterAnchors']` to `['analyzeScene', 'extractCharacterAnchors', 'extractStyleAnchor']`
4. Note: `prepareAnalysisRetry` does NOT re-run `extractStyleAnchor` (style anchor survives retries)

**Step 2: Update `formatSummary` for the new node**

Add a case in `DirectorPipeline.formatSummary()` (around line 408):

```typescript
      case 'extractStyleAnchor': {
        const a = output?.styleAnchor
        if (!a) return output?.skipped ? '(skipped)' : '(empty)'
        return `Medium: ${a.medium}, ${output?.conflicts?.length || 0} conflicts`
      }
```

**Step 3: Run all tests**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat: wire extractStyleAnchor as parallel node in LangGraph pipeline"
```

---

### Task 5: Inject Style Authority into designAndAssemble Prompt

**Files:**
- Modify: `config/prompts/director/pass34-design-and-assemble.md`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (`designAndAssembleFn` around line 663)

**Step 1: Update prompt template**

Replace the `CRITICAL STYLE RULE` section in `config/prompts/director/pass34-design-and-assemble.md` with:

```markdown
{{style_authority_chain}}

CRITICAL STYLE RULE — MUST FOLLOW:
- If a Style Authority Chain is provided above, follow it strictly.
- User explicit style (Priority 1) overrides all image analysis.
- EVERY panel prompt MUST include the style tokens from the authority chain.
- You MUST match the visual medium consistently across ALL panels.
- If the reference images are REAL PHOTOS / LIVE-ACTION: every prompt MUST include "photorealistic, real person, live-action photography" and MUST NOT use "anime, cartoon, illustration, cel shading, 2D, drawn, painting".
- If the reference images are 2D ANIME / ILLUSTRATION: every prompt MUST include the appropriate anime/illustration style tags.
- If the reference images are 3D CGI: every prompt MUST include "3D render, CGI" style tags.
- NEVER change the visual medium from the style authority chain or reference images. A real photo input MUST produce real photo style prompts.
```

**Step 2: Verify vars are passed**

In `extractVarsForDesignAndAssemble`, `style_authority_chain` is already added by Task 2 and the template engine (`renderTemplate`) will replace `{{style_authority_chain}}`.

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add config/prompts/director/pass34-design-and-assemble.md src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat: inject style authority chain into designAndAssemble prompt"
```

---

### Task 6: Add Style Consistency to verifyConsistency

**Files:**
- Modify: `config/prompts/director/pass5-verify-consistency.md`
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts` (VerifySchema)
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (extractVarsForVerify, pickLowItems)

**Step 1: Write the failing test**

Add to `director-skip-stages.test.ts`:

```typescript
import { pickLowItems } from '../DirectorPipeline'

describe('pickLowItems includes styleConsistency', () => {
  it('should detect low styleConsistency', () => {
    const report = {
      score: 5,
      faceConsistency: 8,
      outfitConsistency: 7,
      weaponConsistency: 9,
      styleContinuity: 8,
      styleConsistency: 3,
    }
    const low = pickLowItems(report as any, 6)
    expect(low).toContain('style consistency')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: FAIL — `styleConsistency` not in pickLowItems pairs

**Step 3: Write minimal implementation**

3a. Add `styleConsistency` to `VerifySchema` in `director-schemas.ts`:
```typescript
  styleConsistency: z.number().optional().describe('All panels share the same rendering medium, color temperature, and texture quality'),
```

3b. Add to `VerifyReportLike` type in `DirectorPipeline.ts`:
```typescript
  styleConsistency?: number
```

3c. Add to `pickLowItems` pairs array:
```typescript
    ['style consistency', report.styleConsistency],
```

3d. Add style dimension to `config/prompts/director/pass5-verify-consistency.md`:

```markdown
### 5. Style Consistency
- All panels must share the same rendering medium (all photorealistic OR all anime, never mixed)
- Color temperature must not shift between panels unless motivated by time-of-day change
- Texture quality (film grain, cel shading, etc.) must remain uniform
- Flag if any panel prompt uses style keywords contradicting the style anchor
- Style inconsistency: -3 per medium mismatch, -1 per color temperature drift
```

3e. Modify `extractVarsForVerify` to include style anchor context:
Add to the returned object:
```typescript
    style_anchor_summary: (() => {
      const anchor = (state as any).styleAnchor
      if (!anchor) return '(no style anchor)'
      return `Medium: ${anchor.medium}, Palette: ${anchor.palette?.join(', ')}, Texture: ${anchor.texture}`
    })(),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add config/prompts/director/pass5-verify-consistency.md src/renderer/src/services/pipeline/schemas/director-schemas.ts src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts
git commit -m "feat: add style consistency dimension to verification pass"
```

---

### Task 7: Inject Style Anchor into generateImages Prompt

**Files:**
- Modify: `config/prompts/director/pass6-contact-sheet.md`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (generateImagesFn, regenerateImages)

**Step 1: Update contact sheet prompt template**

In `config/prompts/director/pass6-contact-sheet.md`, add after `{{style_directive_section}}`:

```markdown
{{style_anchor_section}}
```

**Step 2: Update inline fallback in generateImagesFn**

In the inline prompt fallback (around line 921), add `vars.style_anchor_section` after `vars.style_directive_section`:

```typescript
              vars.style_anchor_section,
```

Also apply the same change in `regenerateImages` method (around line 1205).

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add config/prompts/director/pass6-contact-sheet.md src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat: inject style anchor section into contact sheet generation prompt"
```

---

### Task 8: Add director-style-consistency Skill

**Files:**
- Create: `skills/director-style-consistency/SKILL.md`

**Step 1: Create the skill**

```markdown
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
```

**Step 2: Verify skill is loaded**

The `prompt-loader.ts` uses `import.meta.glob('./../../../../../skills/director-*/SKILL.md')` which will automatically pick up the new skill.

**Step 3: Commit**

```bash
git add skills/director-style-consistency/SKILL.md
git commit -m "feat: add director-style-consistency pipeline skill"
```

---

### Task 9: Update DirectorResult Type

**Files:**
- Modify: `src/renderer/src/services/pipeline/types.ts`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (assembleResult)

**Step 1: Update types**

Add to `DirectorResult` interface in `types.ts`:

```typescript
  styleAnchor: StyleAnchor | null
  styleConflicts: StyleConflict[]
```

Add import:
```typescript
import type { StyleAnchor, StyleConflict } from './schemas/style-anchor-schema'
```

**Step 2: Update assembleResult**

In `DirectorPipeline.assembleResult()`, add:

```typescript
      styleAnchor: state.styleAnchor || null,
      styleConflicts: state.styleConflicts || [],
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/types.ts src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat: expose styleAnchor and styleConflicts in DirectorResult"
```

---

### Task 10: Integration Verification

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
git commit -m "fix: resolve any build/type issues from style anchor integration"
```
