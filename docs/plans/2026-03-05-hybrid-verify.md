# Hybrid Verify — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the slow LLM+vision verification pass with a hybrid approach: instant code-level verification as default, with optional text-only LLM deep verification as fallback.

**Architecture:** New `codeVerify` pure function + new `codeVerifyNode` in LangGraph + modified routing: codeVerify passes → skip LLM verify; codeVerify fails → LLM verify (text-only, no vision images). Existing `verifyConsistencyFn` is optimized to remove vision image sending.

**Tech Stack:** TypeScript, Zod, LangGraph, Vitest

**Design Doc:** `docs/plans/2026-03-05-hybrid-verify-design.md`

---

### Task 1: Add `codeVerify` Pure Function

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`

**Step 1: Write the failing test**

Create file `src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { codeVerify } from '../DirectorPipeline'

describe('codeVerify', () => {
  const makeState = (overrides: Record<string, unknown> = {}) => ({
    characters: { characters: [
      { name: 'Alice', anchor: 'blonde hair, blue dress' },
      { name: 'Bob', anchor: 'tall man, black suit' },
    ]},
    prompts: [
      { id: 1, prompt: 'Alice in blue dress walking, photorealistic', negativePrompt: 'blurry' },
      { id: 2, prompt: 'Bob in black suit running, photorealistic', negativePrompt: 'blurry' },
      { id: 3, prompt: 'Alice and Bob together, photorealistic', negativePrompt: 'blurry' },
    ],
    layout: { rows: 1, cols: 3, panelCount: 3 },
    template: 'cinematic',
    styleInstructions: 'photorealistic, 8K',
    styleAnchor: { medium: 'photorealistic', palette: [], paletteRatio: '', lightSource: '', shadowDepth: '', texture: '', colorTemperature: '', contrastLevel: '' },
    styleConflicts: [],
    ...overrides,
  })

  it('should return score 10 when all checks pass', () => {
    const result = codeVerify(makeState() as any)
    expect(result.score).toBe(10)
    expect(result.ok).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('should deduct points for panel count mismatch', () => {
    const result = codeVerify(makeState({ layout: { rows: 2, cols: 3, panelCount: 6 } }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('panels'))).toBe(true)
  })

  it('should deduct points for missing character in prompts', () => {
    const result = codeVerify(makeState({
      prompts: [
        { id: 1, prompt: 'a person walking, photorealistic', negativePrompt: 'blurry' },
        { id: 2, prompt: 'another person, photorealistic', negativePrompt: 'blurry' },
        { id: 3, prompt: 'empty scene, photorealistic', negativePrompt: 'blurry' },
      ],
    }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('Alice'))).toBe(true)
  })

  it('should deduct points for missing style token', () => {
    const result = codeVerify(makeState({
      prompts: [
        { id: 1, prompt: 'Alice in blue dress walking, anime style', negativePrompt: 'blurry' },
        { id: 2, prompt: 'Bob in black suit, anime cel', negativePrompt: 'blurry' },
        { id: 3, prompt: 'Alice and Bob together, anime', negativePrompt: 'blurry' },
      ],
    }) as any)
    expect(result.issues.some(i => i.includes('Style') || i.includes('style'))).toBe(true)
  })

  it('should deduct points for empty prompts', () => {
    const result = codeVerify(makeState({
      prompts: [
        { id: 1, prompt: '', negativePrompt: 'blurry' },
        { id: 2, prompt: 'Bob in black suit', negativePrompt: 'blurry' },
        { id: 3, prompt: 'Alice and Bob', negativePrompt: 'blurry' },
      ],
    }) as any)
    expect(result.score).toBeLessThan(8)
    expect(result.issues.some(i => i.includes('empty'))).toBe(true)
  })

  it('should handle null characters gracefully', () => {
    const result = codeVerify(makeState({ characters: null }) as any)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('should handle null prompts gracefully', () => {
    const result = codeVerify(makeState({ prompts: null }) as any)
    expect(result.ok).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`
Expected: FAIL — `codeVerify` not exported

**Step 3: Write minimal implementation**

Add to `src/renderer/src/services/pipeline/DirectorPipeline.ts` (after `buildAdaptiveNegativePrompt` function):

```typescript
export function codeVerify(state: DirectorState): z.infer<typeof VerifySchema> {
  let score = 10
  const issues: string[] = []
  const anchors = state.characters?.characters || []
  const prompts = state.prompts || []
  const stylePrefix = resolveStylePrefix(
    (state as any).styleAnchor || null,
    state.template,
    state.styleInstructions,
  )

  if (prompts.length === 0) {
    return { score: 0, ok: false, issues: ['No prompts generated'] }
  }

  if (prompts.length !== state.layout.panelCount) {
    issues.push(`Expected ${state.layout.panelCount} panels, got ${prompts.length}`)
    score -= 3
  }

  for (const anchor of anchors) {
    const name = anchor.name.toLowerCase()
    const missingPanels = prompts.filter(p => !p.prompt.toLowerCase().includes(name))
    if (missingPanels.length > prompts.length / 2) {
      issues.push(`Character "${anchor.name}" missing from ${missingPanels.length}/${prompts.length} panels`)
      score -= 2
    }
  }

  if (stylePrefix) {
    const firstToken = stylePrefix.split(',')[0].trim().toLowerCase()
    if (firstToken) {
      const missingStyle = prompts.filter(p => !p.prompt.toLowerCase().includes(firstToken))
      if (missingStyle.length > 0) {
        issues.push(`Style token "${firstToken}" missing from ${missingStyle.length} panel(s)`)
        score -= 1
      }
    }
  }

  const emptyPrompts = prompts.filter(p => !p.prompt.trim())
  if (emptyPrompts.length > 0) {
    issues.push(`${emptyPrompts.length} panel(s) have empty prompts`)
    score -= 3
  }

  score = Math.max(0, score)
  return {
    score,
    ok: score >= 6,
    issues,
    characterConsistency: !issues.some(i => i.includes('Character')),
    lightingContinuity: true,
    narrativeFlow: true,
    spatialCoherence: true,
    styleConsistency: stylePrefix ? (issues.some(i => i.toLowerCase().includes('style')) ? 5 : 10) : undefined,
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts
git commit -m "feat: add codeVerify pure function for instant consistency checking"
```

---

### Task 2: Add `codeVerifyNode` and Modify Graph Routing

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (buildGraph method)
- Modify: `src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`

**Step 1: Write the failing test**

Append to `hybrid-verify.test.ts`:

```typescript
describe('routeAfterCodeVerify', () => {
  // We test the exported routing function
  const { routeAfterCodeVerify } = require('../DirectorPipeline')

  it('should route to generate when code verify passes', () => {
    const state = { report: { score: 8, ok: true, issues: [] }, skipVerify: false, retryCount: 0 }
    expect(routeAfterCodeVerify(state as any)).toBe('generate')
  })

  it('should route to deepVerify when code verify fails and skipVerify is false', () => {
    const state = { report: { score: 4, ok: false, issues: ['problem'] }, skipVerify: false, retryCount: 0 }
    expect(routeAfterCodeVerify(state as any)).toBe('deepVerify')
  })

  it('should route to generate when code verify fails but skipVerify is true', () => {
    const state = { report: { score: 4, ok: false, issues: ['problem'] }, skipVerify: true, retryCount: 0 }
    expect(routeAfterCodeVerify(state as any)).toBe('generate')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`
Expected: FAIL — `routeAfterCodeVerify` not exported

**Step 3: Write minimal implementation**

3a. Add the routing function (after `codeVerify`):

```typescript
export function routeAfterCodeVerify(state: DirectorState): 'generate' | 'deepVerify' {
  const report = state.report
  if (!report) return 'generate'
  const threshold = Number.isFinite(state.scoreThreshold)
    ? Math.max(0, Math.min(10, Math.round(state.scoreThreshold)))
    : SCORE_THRESHOLD
  if (report.score >= threshold && report.ok) return 'generate'
  if (state.skipVerify) return 'generate'
  return 'deepVerify'
}
```

3b. Add `codeVerifyNode` inside `buildGraph()` (after `verifyConsistencyFn`, before routing):

```typescript
    const codeVerifyNode = (state: DirectorState, config: any) => {
      const t0 = Date.now()
      const result = codeVerify(state)
      const elapsed = Date.now() - t0
      const passData = DirectorPipeline.buildPassCardData('codeVerify', { pass: 4, label: '快速校验' }, { report: result }, elapsed)
      writer(config)?.({
        type: 'pass_complete', pass: 4,
        label: `快速校验完成 (score: ${result.score}, ${elapsed}ms)`,
        elapsed, passData,
      })
      return { report: result }
    }
```

3c. Modify `verifyConsistencyFn` to **not send reference images** (remove lines 1148-1155 that push `buildImageContent`):

Replace:
```typescript
        const userContent: Array<any> = []
        if (state.inputImages.length > 0) {
          userContent.push(
            ...BasePipeline.buildImageContent(
              state.inputImages,
              resolveVisionDetailByPass(state, 'verifyConsistency'),
            ),
          )
        }
```

With:
```typescript
        const userContent: Array<any> = []
```

3d. Modify Graph Assembly — replace the current `designAndAssemble → verify/generate` routing with:

```typescript
      .addNode('codeVerify', codeVerifyNode)
      // ... keep existing verifyConsistency node ...
      .addConditionalEdges('designAndAssemble', () => 'codeVerify' as const, {
        codeVerify: 'codeVerify',
      })
      .addConditionalEdges('codeVerify', (state: DirectorState) => routeAfterCodeVerify(state), {
        generate: 'generateImages',
        deepVerify: 'verifyConsistency',
      })
      .addConditionalEdges('verifyConsistency', routeVerify, {
        retry: 'prepareRetry',
        generate: 'generateImages',
      })
```

This replaces the old `routeAfterDesign` conditional edges from `designAndAssemble`.

3e. Add `formatSummary` case for `codeVerify`:

```typescript
      case 'codeVerify': {
        const r = output?.report
        if (!r) return '(empty)'
        return `快检 ${r.score}/10，${r.issues?.length || 0} 个问题`
      }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts
git commit -m "feat: add codeVerifyNode and hybrid routing — fast-path skips LLM verify"
```

---

### Task 3: Update Existing Tests

**Files:**
- Modify: `src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts` (if any routing tests break)

**Step 1: Check and fix existing tests**

The `shouldRetryAnalysis` tests should be unaffected. The `routeAfterDesign` function is being replaced — any tests referencing it need updating.

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: PASS (fix any broken tests)

**Step 3: Commit (if fixes needed)**

```bash
git add -A
git commit -m "fix: update existing tests for hybrid verify routing changes"
```

---

### Task 4: Integration Verification

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
git commit -m "fix: resolve any build/type issues from hybrid verify integration"
```
