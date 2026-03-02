# Pipeline Tech Debt Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 4 tech debt items in the Director Pipeline: error handling, type safety, dead code, test coverage.

**Architecture:** Each task is independent and atomic. Error handling wraps each pass function in try/catch with structured error reporting. Type safety replaces `as any` with proper interfaces. Dead schemas are removed. Tests use Vitest with mocked LLM/API.

**Tech Stack:** TypeScript, Zod, LangGraph, Vitest, vi.mock

---

### Task 1: Remove dead schemas (PanelDesignSchema, AssembledPromptsSchema)

**Files:**
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`
- Modify: `src/renderer/src/services/pipeline/types.ts`

**Step 1: Check no remaining imports of old schemas**

Run: `cd d:\tecx\text\temp-ai-image-master-source && rg "PanelDesignSchema|AssembledPromptsSchema" src/ --type ts`

Expected: Only hits in `director-schemas.ts` and `types.ts` (definition sites), zero usage sites in pipeline code.

**Step 2: Remove dead schemas from director-schemas.ts**

Remove these blocks from `director-schemas.ts`:

```typescript
// DELETE: PanelDesignSchema (lines 21-29) — replaced by DesignAndAssembleSchema
// DELETE: AssembledPromptsSchema (lines 31-39) — replaced by DesignAndAssembleSchema
```

Keep: `SceneAnalysisSchema`, `CharacterAnchorSchema`, `DesignAndAssembleSchema`, `VerifySchema`

**Step 3: Update types.ts imports**

In `types.ts` line 1, change:
```typescript
import type { SceneAnalysis, CharacterAnchors, PanelDesign, VerifyReport } from './schemas/director-schemas'
```
to:
```typescript
import type { SceneAnalysis, CharacterAnchors, DesignAndAssemble, VerifyReport } from './schemas/director-schemas'
```

Update `DirectorResult.panels` type from `PanelDesign | null` to `DesignAndAssemble | null`.

**Step 4: Build and verify**

Run: `npx electron-vite build 2>&1 | Select-String "error|Error|built in"`

Expected: 3x "built in", zero errors.

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/schemas/director-schemas.ts src/renderer/src/services/pipeline/types.ts
git commit -m "refactor: remove dead PanelDesignSchema and AssembledPromptsSchema"
```

---

### Task 2: Fix `as any` type assertions in DirectorPipeline.ts

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Replace `state as any` in resolveSystemPrompt calls**

The issue: `resolveSystemPrompt` takes `context: Record<string, unknown>`, but `state` is `DirectorState`. Since `DirectorState` is a Zod-inferred type with known keys, spreading it to `Record<string, unknown>` is safe.

Replace all 4 occurrences of `state as any` (lines 219, 244, 308, and the spread on 270):

```typescript
// Before:
self.resolveSystemPrompt('analyzeScene', {}, state as any, ...)

// After:
self.resolveSystemPrompt('analyzeScene', {}, state as Record<string, unknown>, ...)
```

For line 270:
```typescript
// Before:
{ ...state, retryFeedback: state.retryFeedback } as any

// After:
{ ...state, retryFeedback: state.retryFeedback } as Record<string, unknown>
```

**Step 2: Fix `(input as any).skipVerify` on line 467**

Replace:
```typescript
const skipVerify = (input as any).skipVerify ?? false
```
with:
```typescript
const skipVerify = (input as Partial<DirectorState>).skipVerify ?? false
```

**Step 3: Type the graph instance**

Replace line 124:
```typescript
private _graph: any = null
```
with:
```typescript
private _graph: ReturnType<StateGraph<typeof stateSchema>['compile']> | null = null
```

If that causes complex type issues, use a simpler typed version:
```typescript
private _graph: { stream: (input: any, config: any) => AsyncIterable<any> } | null = null
```

**Step 4: Build and verify**

Run: `npx electron-vite build 2>&1 | Select-String "error|Error|built in"`

Expected: zero errors.

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "refactor: replace as-any with proper type assertions in DirectorPipeline"
```

---

### Task 3: Add try/catch error handling to each Pass

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/services/pipeline/types.ts`

**Step 1: Add `error` status to PipelineProgress**

In `types.ts`, the status union `'running' | 'completed' | 'retrying' | 'failed'` already includes `'failed'`. No change needed.

**Step 2: Wrap each pass function in try/catch**

Pattern for every pass (analyzeScene, extractCharacterAnchors, designAndAssemble, verifyConsistency, generateImages):

```typescript
const analyzeSceneFn = async (state: DirectorState, config: any) => {
  const t0 = Date.now()
  try {
    // ... existing logic ...
    return { scene: result }
  } catch (err: unknown) {
    const elapsed = Date.now() - t0
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[DirectorPipeline] Pass 1 (analyzeScene) failed: ${message}`)
    writer(config)?.({
      type: 'pass_complete',
      pass: 1,
      label: `场景分析失败: ${message.slice(0, 80)}`,
      elapsed,
      passData: DirectorPipeline.buildPassCardData(
        'analyzeScene',
        { pass: 1, label: '场景分析' },
        { error: message },
        elapsed,
      ),
    })
    return { scene: null }
  }
}
```

Apply this pattern to all 5 pass functions. On error, return the default null/empty value so the pipeline can continue or gracefully degrade.

**Step 3: Build and verify**

Run: `npx electron-vite build 2>&1 | Select-String "error|Error|built in"`

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix: add try/catch error handling to all pipeline passes"
```

---

### Task 4: Add unit tests for prompt-loader and BasePipeline

**Files:**
- Create: `src/renderer/src/services/pipeline/__tests__/prompt-loader.test.ts`
- Create: `src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts`

**Step 1: Write prompt-loader tests**

```typescript
import { describe, it, expect } from 'vitest'
import { renderTemplate } from '../prompt-loader'

describe('renderTemplate', () => {
  it('replaces {{var}} placeholders with values', () => {
    const tpl = 'Scene: {{scene_env}}, Panels: {{panel_count}}'
    const result = renderTemplate(tpl, { scene_env: 'forest', panel_count: '6' })
    expect(result).toBe('Scene: forest, Panels: 6')
  })

  it('replaces missing vars with empty string', () => {
    const tpl = 'Hello {{name}}, your role is {{role}}'
    const result = renderTemplate(tpl, { name: 'Alice' })
    expect(result).toBe('Hello Alice, your role is ')
  })

  it('leaves non-matching patterns untouched', () => {
    const tpl = 'No vars here, just {text} and [brackets]'
    const result = renderTemplate(tpl, {})
    expect(result).toBe('No vars here, just {text} and [brackets]')
  })
})
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/prompt-loader.test.ts`

Expected: 3 tests PASS

**Step 3: Write BasePipeline tests**

```typescript
import { describe, it, expect, vi } from 'vitest'
import '../__tests__/setup'
import { BasePipeline } from '../BasePipeline'
import type { PipelineConfig, PipelineSkill } from '../types'

class TestPipeline extends BasePipeline<any, any> {
  get pipelineSkills(): PipelineSkill[] { return [] }
  buildGraph() { return null }
  assembleResult(s: any) { return s }
  postProcess(r: any) { return r }
}

const config: PipelineConfig = {
  model: 'test-model',
  apiKey: 'test-key',
  baseURL: 'http://localhost:8080',
}

describe('BasePipeline', () => {
  it('buildSystemPrompt returns base prompt when no skills match', () => {
    const pipeline = new TestPipeline(config)
    const result = pipeline.buildSystemPrompt('unknownPhase', 'base prompt', {})
    expect(result).toBe('base prompt')
  })

  it('buildSystemPrompt appends matching skills', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'test-skill',
      rules: 'Rule A\nRule B',
      appliesTo: ['myPhase'],
      priority: 1,
    })
    const result = pipeline.buildSystemPrompt('myPhase', 'base', {})
    expect(result).toContain('base')
    expect(result).toContain('[Skill:test-skill]')
    expect(result).toContain('Rule A')
  })

  it('buildSystemPrompt respects condition', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'conditional',
      rules: 'Dark mode rules',
      appliesTo: ['myPhase'],
      priority: 1,
      condition: (ctx) => ctx.dark === true,
    })
    expect(pipeline.buildSystemPrompt('myPhase', 'base', { dark: false })).toBe('base')
    expect(pipeline.buildSystemPrompt('myPhase', 'base', { dark: true })).toContain('Dark mode rules')
  })

  it('buildImageContent returns correct format', () => {
    const content = BasePipeline.buildImageContent(
      [{ data: 'abc123', mimeType: 'image/png' }],
      'high',
    )
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('image_url')
    expect(content[0].image_url.url).toBe('data:image/png;base64,abc123')
    expect(content[0].image_url.detail).toBe('high')
  })
})
```

**Step 4: Run tests**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts`

Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/__tests__/
git commit -m "test: add unit tests for prompt-loader renderTemplate and BasePipeline"
```

---

## Summary

| Task | Lines Changed | Risk | Time |
|------|--------------|------|------|
| 1. Dead schemas | ~20 deleted | Low | 3 min |
| 2. Type safety | ~10 changed | Low | 5 min |
| 3. Error handling | ~60 added | Medium | 10 min |
| 4. Tests | ~80 created | Low | 8 min |

Total: ~26 min, 4 commits.
