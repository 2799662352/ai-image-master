# Official Evaluator-Optimizer Pattern — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the Director Pipeline's verify/retry logic to match the official LangGraph Evaluator-Optimizer pattern: generator → evaluator → conditional edge → [accepted | rejected+feedback → generator]. Remove codeVerify and prepareRetry nodes, simplify to 2-node pattern.

**Architecture:** Delete codeVerify + prepareRetry. Keep verifyConsistency as the sole LLM evaluator. Modify routeVerify to build feedback and route rejected directly back to designAndAssemble. Update pass numbering and UI.

**Tech Stack:** TypeScript, LangGraph StateGraph, Vitest

**Design Doc:** `docs/plans/2026-03-05-official-evaluator-optimizer-design.md`

---

### Current Graph (BEFORE):
```
designAndAssemble → codeVerify → [generateImages | verifyConsistency → [prepareRetry → designAndAssemble | generateImages]]
```

### Target Graph (AFTER — pure 2-node official pattern):
```
designAndAssemble (generator) → verifyConsistency (evaluator, writes feedback to state)
  → [accepted: generateImages | rejected: designAndAssemble (reads feedback from state)]
```
No intermediate buildFeedback node. Evaluator writes retryFeedback + retryCount directly to state.

### Pass Numbers (AFTER):
```
Pass 0: selectSkills
Pass 1: analyzeScene (parallel)
Pass 2: extractCharacterAnchors (parallel)
Pass 3: extractStyleAnchor (parallel)
Pass 4: designAndAssemble
Pass 5: verifyConsistency (evaluator)
Pass 6: generateImages
```
(Same as before — codeVerify was also pass 5, so removing it doesn't change numbering)

---

### Task 1: Merge prepareRetry into routeVerify

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Modify `routeVerify` to build feedback when rejecting**

Replace the current `routeVerify` function:

```typescript
    const routeVerify = (state: DirectorState): 'retry' | 'generate' => {
      if (!state.report || state.retryCount >= MAX_RETRIES) return 'generate'
      const threshold = Number.isFinite(state.scoreThreshold)
        ? Math.max(0, Math.min(10, Math.round(state.scoreThreshold)))
        : SCORE_THRESHOLD
      const hasLowSubScore = pickLowItems(state.report as VerifyReportLike, threshold).length > 0
      if (state.report.score < threshold || hasLowSubScore) return 'retry'
      return 'generate'
    }
```

With a new version that also prepares feedback (merging prepareRetryFn logic):

```typescript
    const routeAfterEvaluator = (state: DirectorState): 'generate' | 'designAndAssemble' => {
      if (!state.report || state.retryCount >= MAX_RETRIES) return 'generate'
      const threshold = Number.isFinite(state.scoreThreshold)
        ? Math.max(0, Math.min(10, Math.round(state.scoreThreshold)))
        : SCORE_THRESHOLD
      const hasLowSubScore = pickLowItems(state.report as VerifyReportLike, threshold).length > 0
      if (state.report.score < threshold || hasLowSubScore) return 'designAndAssemble'
      return 'generate'
    }
```

**Step 2: Add a feedback preparation node that runs before routing back**

Actually, LangGraph conditional edges can't modify state — they only route. We need a small node to prepare feedback. Replace `prepareRetryFn` with `buildFeedbackFn`:

```typescript
    const buildFeedbackFn = (state: DirectorState) => {
      const threshold = Number.isFinite(state.scoreThreshold)
        ? Math.max(0, Math.min(10, Math.round(state.scoreThreshold)))
        : SCORE_THRESHOLD
      const feedback = buildRetryFeedback(state.report as VerifyReportLike, threshold)
      return {
        retryFeedback: feedback,
        retryCount: state.retryCount + 1,
        report: null,
      }
    }
```

This is essentially the same as `prepareRetryFn` but renamed for clarity and without clearing prompts/panels (already fixed earlier).

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS (or fix affected tests)

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "refactor: rename prepareRetry to buildFeedback, rename routeVerify to routeAfterEvaluator"
```

---

### Task 2: Remove codeVerify and Simplify Graph

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (graph assembly)

**Step 1: Remove codeVerifyNode from graph**

In graph assembly, remove:
- `.addNode('codeVerify', codeVerifyNode)`
- The conditional edges from `designAndAssemble` → `codeVerify`
- The conditional edges from `codeVerify` → `[generateImages | verifyConsistency]`

**Step 2: Add direct edge: designAndAssemble → verifyConsistency**

Replace the complex codeVerify routing with:

```typescript
      // When skipVerify is true, go directly to generateImages
      // When skipVerify is false, go to evaluator (verifyConsistency)
      .addConditionalEdges('designAndAssemble', (state: DirectorState) => {
        if (state.skipVerify) return 'generate'
        return 'evaluate'
      }, {
        generate: 'generateImages',
        evaluate: 'verifyConsistency',
      })
      // Evaluator routes: accepted → generate, rejected → buildFeedback → designAndAssemble
      .addConditionalEdges('verifyConsistency', routeAfterEvaluator, {
        generate: 'generateImages',
        designAndAssemble: 'buildFeedback',
      })
      .addEdge('buildFeedback', 'designAndAssemble')
```

**Step 3: Remove codeVerify-related exports**

Remove or keep as dead code (safer to remove):
- `export function codeVerify(...)` 
- `export function routeAfterCodeVerify(...)`
- `codeVerifyNode` variable inside buildGraph

Note: Keep the codeVerify TEST FILE for now (can delete in Task 4) since removing exports will cause import errors in tests.

**Step 4: Run tests**

Run: `npx vitest run`
Expected: Some test files may fail due to removed exports. Fix in Task 3.

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "refactor: remove codeVerify node, simplify to official evaluator-optimizer pattern"
```

---

### Task 3: Update Tests

**Files:**
- Modify: `src/renderer/src/services/pipeline/__tests__/hybrid-verify.test.ts`
- Modify: Any other test files importing `codeVerify` or `routeAfterCodeVerify`

**Step 1: Remove or update tests**

Option A: Delete `hybrid-verify.test.ts` entirely (codeVerify no longer exists)
Option B: Rename to `evaluator-optimizer.test.ts` and test the new `routeAfterEvaluator` + `buildRetryFeedback`

Recommended: Option A (delete) since `routeAfterEvaluator` is an inline function inside `buildGraph` and can't be exported for unit testing. The behavior is tested via integration.

**Step 2: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 3: Commit**

```bash
git add -A
git commit -m "test: remove codeVerify tests, update for evaluator-optimizer pattern"
```

---

### Task 4: Update UI Pass Definitions

**Files:**
- Modify: `src/renderer/src/react-app/components/GenerationProgress.tsx`

**Step 1: Update PASS_DEFS**

The pass numbering stays the same (pass 5 was shared between codeVerify and verifyConsistency). Just update the label:

In `PASS_DEFS_FULL`, pass 5 label was '快速校验' for codeVerify. Now it should be '一致性校验' since only LLM verify remains:

```typescript
const PASS_DEFS_FULL = [
  { label: '技能选择',     icon: 'fa-brain' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '风格锚点',     icon: 'fa-palette' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '一致性校验',   icon: 'fa-check-double' },
  { label: '图像生成',     icon: 'fa-image' },
]
```

For `PASS_DEFS_FAST` (skipVerify mode), remove the verify entry since it's skipped:

```typescript
const PASS_DEFS_FAST = [
  { label: '技能选择',     icon: 'fa-brain' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '风格锚点',     icon: 'fa-palette' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '图像生成',     icon: 'fa-image' },
]
```

**Step 2: Remove `formatSummary` case for 'codeVerify'**

In `DirectorPipeline.ts`, remove the `case 'codeVerify':` from `formatSummary`.

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/components/GenerationProgress.tsx src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "refactor: update UI pass labels for evaluator-optimizer pattern"
```

---

### Task 5: Integration Verification

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
git commit -m "fix: resolve any remaining issues from evaluator-optimizer refactor"
```
