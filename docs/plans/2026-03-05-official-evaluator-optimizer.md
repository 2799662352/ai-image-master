# Official Evaluator-Optimizer Pattern (Pure 2-Node) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge `buildFeedback` node into `verifyConsistencyFn` so the evaluator directly writes `retryFeedback` + `retryCount` to state, achieving a pure 2-node Evaluator-Optimizer loop (generator + evaluator). Also clean up the dead `codeVerify` case from `formatSummary`.

**Architecture:** Align with the official LangGraph Evaluator-Optimizer pattern where the evaluator node writes both the evaluation result AND feedback to state, and the conditional edge function only reads state to route. No intermediate nodes between evaluator and generator.

**Tech Stack:** TypeScript, LangGraph StateGraph, Vitest

**Design Doc:** `docs/plans/2026-03-05-official-evaluator-optimizer-design.md`

**Official Reference (LangGraph docs 2026):**
```python
# Evaluator writes grade + feedback to state
def llm_call_evaluator(state):
    grade = evaluator.invoke(...)
    return {"funny_or_not": grade.grade, "feedback": grade.feedback}

# Router only reads state
def route_joke(state):
    if state["funny_or_not"] == "funny": return "Accepted"
    return "Rejected + Feedback"
```

---

### Current Graph (BEFORE — 3-node with buildFeedback):
```
designAndAssemble → [skipVerify: generateImages | verifyConsistency]
  verifyConsistency → [accepted: generateImages | rejected: buildFeedback → designAndAssemble]
```

### Target Graph (AFTER — pure 2-node):
```
designAndAssemble → [skipVerify: generateImages | verifyConsistency]
  verifyConsistency → [accepted: generateImages | rejected: designAndAssemble]
```
No intermediate `buildFeedback` node. The evaluator writes `retryFeedback` + `retryCount` directly to state inside `verifyConsistencyFn`.

### Pass Numbers (unchanged):
```
Pass 0: selectSkills
Pass 1: analyzeScene (parallel)
Pass 2: extractCharacterAnchors (parallel)
Pass 3: extractStyleAnchor (parallel)
Pass 4: designAndAssemble (generator)
Pass 5: verifyConsistency (evaluator — also writes feedback)
Pass 6: generateImages
```

---

### Task 1: Merge buildFeedback into verifyConsistencyFn

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Modify `verifyConsistencyFn` return logic**

Find `verifyConsistencyFn` (around line 1152). Replace the return block (lines ~1180-1191):

BEFORE:
```typescript
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('verifyConsistency', { pass: 5, label: '一致性校验' }, { report: result }, elapsed, appliedSkills)
        writer(config)?.({
          type: 'pass_complete', pass: 5,
          label: `一致性校验完成 (score: ${result.score}, ${(elapsed / 1000).toFixed(1)}s)`,
          elapsed, passData,
        })
        return { report: result }
      } catch (err: unknown) {
        emitError(config, 5, '一致性校验', 'verifyConsistency', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { report: null }
      }
```

AFTER:
```typescript
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('verifyConsistency', { pass: 5, label: '一致性校验' }, { report: result }, elapsed, appliedSkills)

        const threshold = Number.isFinite(state.scoreThreshold)
          ? Math.max(0, Math.min(10, Math.round(state.scoreThreshold)))
          : SCORE_THRESHOLD
        const hasLowSubScore = pickLowItems(result as VerifyReportLike, threshold).length > 0
        const shouldReject = result.score < threshold || hasLowSubScore

        if (shouldReject && state.retryCount < MAX_RETRIES) {
          const feedback = buildRetryFeedback(result as VerifyReportLike, threshold)
          writer(config)?.({
            type: 'pass_complete', pass: 5,
            label: `一致性校验不通过 (score: ${result.score}, 将重试) (${(elapsed / 1000).toFixed(1)}s)`,
            elapsed, passData,
          })
          return {
            report: result,
            retryFeedback: feedback,
            retryCount: state.retryCount + 1,
          }
        }

        writer(config)?.({
          type: 'pass_complete', pass: 5,
          label: `一致性校验完成 (score: ${result.score}, ${(elapsed / 1000).toFixed(1)}s)`,
          elapsed, passData,
        })
        return { report: result, retryFeedback: '' }
      } catch (err: unknown) {
        emitError(config, 5, '一致性校验', 'verifyConsistency', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { report: null, retryFeedback: '' }
      }
```

**CRITICAL (P1 fix):** Both the accepted path AND the error path MUST return `retryFeedback: ''` to clear any stale feedback from a previous rejection. Otherwise the router would see old feedback and loop forever.

**Step 2: Delete `buildFeedbackFn`**

Delete the entire block (around line 1194-1205):

```typescript
    // ===== Evaluator-Optimizer: build feedback when rejecting =====
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

**Step 3: Simplify `routeAfterEvaluator`**

Replace (around line 1356-1364):

BEFORE:
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

AFTER (P4 fix — defensive MAX_RETRIES safety net):
```typescript
    const routeAfterEvaluator = (state: DirectorState): 'generate' | 'designAndAssemble' => {
      if (!state.report) return 'generate'
      if (state.retryFeedback && state.retryCount <= MAX_RETRIES) return 'designAndAssemble'
      return 'generate'
    }
```

This is the official pattern: router only reads state, never computes. The evaluator already decided. The `retryCount <= MAX_RETRIES` is a safety net — should never trigger since the evaluator already caps retries, but prevents infinite loops if there's a bug.

**Step 4: Update graph assembly**

In graph assembly (around line 1366-1405), make these changes:

1. Remove `.addNode('buildFeedback', buildFeedbackFn)`
2. Change the verifyConsistency conditional edge mapping:

BEFORE:
```typescript
      .addNode('buildFeedback', buildFeedbackFn)
      // ...
      .addConditionalEdges('verifyConsistency', routeAfterEvaluator, {
        generate: 'generateImages',
        designAndAssemble: 'buildFeedback',
      })
      .addEdge('buildFeedback', 'designAndAssemble')
```

AFTER:
```typescript
      .addConditionalEdges('verifyConsistency', routeAfterEvaluator, {
        generate: 'generateImages',
        designAndAssemble: 'designAndAssemble',
      })
```

**Step 5: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: No new type errors

**Step 7: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "refactor: merge buildFeedback into verifyConsistencyFn — pure 2-node evaluator-optimizer"
```

---

### Task 2: Remove dead codeVerify case from formatSummary

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Delete the codeVerify case**

Find and remove (around line 652-656):
```typescript
      case 'codeVerify': {
        const r = output?.report
        if (!r) return '(empty)'
        return `快检 ${r.score}/10，${r.issues?.length || 0} 个问题`
      }
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "cleanup: remove dead codeVerify case from formatSummary"
```

---

### Task 3: Integration Verification

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
git commit -m "fix: resolve any remaining issues from pure 2-node evaluator-optimizer refactor"
```

---

## Code Review Fixes Applied

| ID | Issue | Fix |
|---|---|---|
| P1 | 及格路径不清空 `retryFeedback` 导致无限重试 | 及格和异常路径都返回 `retryFeedback: ''` |
| P4 | Router 缺乏防御性 MAX_RETRIES 检查 | 加 `state.retryCount <= MAX_RETRIES` 安全网 |

## Key Design Decisions

1. **Evaluator 决定一切**: `verifyConsistencyFn` 判断分数、计算 feedback、递增 retryCount。Router 只读 state 做路由。
2. **`retryFeedback` 清空机制**: 及格/异常时必须返回 `retryFeedback: ''`，防止残留。
3. **`report` 不再清空**: 旧 `buildFeedbackFn` 设 `report: null`。现在保留 report（`designAndAssembleFn` 不读 report，不影响行为，且利于调试）。
4. **双重 MAX_RETRIES 保护**: Evaluator 里检查 `retryCount < MAX_RETRIES`（主保护），Router 里检查 `retryCount <= MAX_RETRIES`（安全网）。
