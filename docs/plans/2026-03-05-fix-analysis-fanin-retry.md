# Fix Analysis Fan-in Retry Hang Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix pipeline hang when analysis retry path triggers only 2 of 3 fan-in predecessors, causing `validateAnalysis` to wait forever for `extractStyleAnchor`.

**Architecture:** Replace the strict 3-way `addEdge([A,B,C], D)` fan-in with individual `addEdge` calls so `validateAnalysis` triggers when any triggered predecessor completes, matching the LangGraph official conditional branching pattern. Also add `shouldRetryAnalysis` unit tests covering the retry/abort/continue routing.

**Tech Stack:** LangGraph JS (`@langchain/langgraph`), Vitest

**Root Cause (verified via LangGraph JS official docs 2026-03-05):**
- `addEdge(['analyzeScene', 'extractCharacterAnchors', 'extractStyleAnchor'], 'validateAnalysis')` creates a strict join that waits for ALL 3 nodes in the current superstep.
- `prepareAnalysisRetry` only fans out to `analyzeScene` + `extractCharacterAnchors` (not `extractStyleAnchor`).
- On retry, `extractStyleAnchor` is never re-triggered → `validateAnalysis` waits forever → pipeline hangs.
- Official pattern uses individual edges (`b→e`, `c→e`, `d→e`) so the join node triggers once all *scheduled* predecessors complete.

---

### Task 1: Add failing test for `shouldRetryAnalysis` routing

**Files:**
- Modify: `src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts`

**Step 1: Write failing tests**

```typescript
import { shouldRetryAnalysis } from '../DirectorPipeline'

describe('shouldRetryAnalysis routing', () => {
  it('returns "continue" when scene is valid', () => {
    const result = shouldRetryAnalysis({
      scene: { env: 'forest clearing' },
      characters: null,
      analysisRetryCount: 0,
    })
    expect(result).toBe('continue')
  })

  it('returns "continue" when characters are valid', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: { characters: [{ name: 'Hero' }] },
      analysisRetryCount: 0,
    })
    expect(result).toBe('continue')
  })

  it('returns "retry" when both null and retries < max', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: null,
      analysisRetryCount: 0,
    })
    expect(result).toBe('retry')
  })

  it('returns "abort" when both null and retries >= max', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: null,
      analysisRetryCount: 2,
    })
    expect(result).toBe('abort')
  })

  it('returns "continue" when scene skipped via flag', () => {
    const result = shouldRetryAnalysis({
      scene: null,
      characters: null,
      analysisRetryCount: 0,
      skipAnalyzeScene: true,
    })
    expect(result).toBe('continue')
  })
})
```

**Step 2: Run tests to verify they pass (these test existing logic, should pass immediately)**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts --reporter=verbose`
Expected: ALL PASS (these are testing existing exported function, not the graph fix yet)

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts
git commit -m "test: add shouldRetryAnalysis routing tests"
```

---

### Task 2: Fix fan-in edge — replace strict 3-way join with individual edges

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:1387`

**Step 1: Replace the single line**

Change line 1387 from:
```typescript
.addEdge(['analyzeScene', 'extractCharacterAnchors', 'extractStyleAnchor'], 'validateAnalysis')
```

To three individual edges:
```typescript
.addEdge('analyzeScene', 'validateAnalysis')
.addEdge('extractCharacterAnchors', 'validateAnalysis')
.addEdge('extractStyleAnchor', 'validateAnalysis')
```

**Step 2: Run all pipeline tests**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`
Expected: ALL PASS (89+ tests)

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix: replace strict 3-way fan-in with individual edges to prevent retry hang"
```

---

### Task 3: Verify the full test suite still passes

**Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

**Step 2: Push to remote**

```bash
git push origin main
```

---

## Summary of Changes

| File | Change | Lines |
|------|--------|-------|
| `DirectorPipeline.ts:1387` | Replace `addEdge([A,B,C], D)` with 3 individual `addEdge(X, D)` | 1 line → 3 lines |
| `evaluator-optimizer.test.ts` | Add 5 tests for `shouldRetryAnalysis` | +30 lines |

## Risk Assessment

- **Low risk**: Individual edges are the official LangGraph pattern for conditional fan-in
- **No behavior change on happy path**: When all 3 nodes run (first pass), all 3 complete before `validateAnalysis` — same as before
- **Fixes retry path**: On retry, only 2 nodes are triggered → `validateAnalysis` no longer waits for the missing 3rd node
