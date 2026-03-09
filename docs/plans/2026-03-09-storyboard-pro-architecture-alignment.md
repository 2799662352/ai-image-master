# StoryboardProPipeline 架构对齐 (DirectorPipeline 模式) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 StoryboardProPipeline 的 Pass 1 (sceneDecompose) 和 Pass 2 (characterExtract) 对齐 DirectorPipeline 的 "L1 withRaw + raw regex fallback + graceful degradation" 单次 LLM 调用模式，消除 L2 retry 的第二次完整 LLM+Vision 调用。

**Architecture:** 当前 StoryboardProPipeline 的 Pass 1 和 Pass 2 都用 "L1 full schema → L2 simple schema retry" 模式，一旦 L1 失败（如 `ERR_CONNECTION_CLOSED`）就发起第二次完整 LLM+Vision 调用（~5-8s）。DirectorPipeline 已经优化为 "L1 withRaw + raw regex fallback（免费）+ graceful degradation"。本计划将同一模式迁移到 StoryboardProPipeline。同时精简 Pass 2 的 L1 schema 从 11 字段降至 4 字段（与 SimpleObjArraySchema 对齐），因为多余字段下游未使用。

**Tech Stack:** TypeScript, Zod, LangGraph StateGraph, Vitest

---

## 现状 vs 目标

| Pass | 现状 | 目标 |
|------|------|------|
| Pass 1 sceneDecompose | L1 FlatSceneSchema → raw regex → **L2 SimpleSceneSchema (第2次LLM)** → fail | L1 FlatSceneSchema → raw regex → graceful degradation (无L2) |
| Pass 2 characterExtract | L1 ObjArraySchema(11字段) → raw regex → **L2 SimpleObjArraySchema (第2次LLM)** → fail | L1 SimpleObjArraySchema(4字段) → raw regex → `{objs:[]}` (无L2) |
| Pass 3 shotDesign | L1 → raw regex → L2 → L3 (保留，镜头设计需要更强恢复) | 不改 |

---

### Task 1: Pass 1 sceneDecompose — 移除 L2 retry

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts:238-339`
- Test: `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts`

**Step 1: Write the failing test**

在 `storyboard-extraction-fallback.test.ts` 中添加测试，验证 sceneDecompose 在 L1 parsed 为空且 raw regex 也失败时，直接返回 fallback scene 而不发起 L2 调用。

```typescript
describe('sceneDecompose single-call architecture', () => {
  it('should NOT make a second LLM call when L1 structured parse fails', () => {
    // This test verifies the architecture: after L1 withRaw fails both
    // structured parse and raw regex, the function should graceful-degrade
    // to { d: '(analysis failed)', ... } without calling L2 SimpleSceneSchema.
    //
    // Evidence: the L2 code block (lines 296-324) should not exist.
    // We verify by checking the source code does not contain 'SimpleSceneSchema'
    // in the sceneDecompose function.

    const fs = require('fs')
    const source = fs.readFileSync(
      require.resolve('../StoryboardProPipeline'),
      'utf-8',
    )
    // The L2 block references SimpleSceneSchema — should be removed
    const sceneDecomposeMatch = source.match(
      /sceneDecomposeFn[\s\S]*?(?=characterExtractFn)/,
    )
    expect(sceneDecomposeMatch).toBeTruthy()
    expect(sceneDecomposeMatch![0]).not.toContain('SimpleSceneSchema')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts --reporter=verbose`

Expected: FAIL — source still contains `SimpleSceneSchema` in sceneDecomposeFn

**Step 3: Implement — remove L2 block from sceneDecomposeFn**

In `StoryboardProPipeline.ts`, delete the entire L2 block (lines 296-324):

```typescript
// REMOVE this entire block:
        // --- L2: Simplified schema fallback with raw unwrap ---
        if (!scene?.d) {
          console.warn('[StoryboardProPipeline] sceneDecompose L1 failed, trying L2 SimpleSceneSchema')
          try {
            const simpleWithRaw = self.createStructuredLLMWithRaw(SimpleSceneSchema)
            const simpleResponse = await simpleWithRaw.invoke(userMessages, { signal: config?.signal })
            // ... entire L2 block ...
          } catch (e: unknown) {
            console.warn('[StoryboardProPipeline] sceneDecompose L2 error:', e instanceof Error ? e.message : String(e))
          }
        }
```

The flow becomes:
```
L1 FlatSceneSchema withRaw → parsed? → done
                           → raw regex fallback → found? → done
                           → { d: '(analysis failed)', ... } → done
```

**Step 4: Run test to verify it passes**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts --reporter=verbose`

Expected: PASS

**Step 5: Run full storyboard test suite**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/ --reporter=verbose`

Expected: All tests pass

---

### Task 2: Pass 2 characterExtract — 精简 schema + 移除 L2 retry

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts:341-425`
- Test: `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts`

**Step 1: Write the failing test**

```typescript
describe('characterExtract single-call architecture', () => {
  it('should use SimpleObjArraySchema as L1 (not full 11-field ObjArraySchema)', () => {
    const fs = require('fs')
    const source = fs.readFileSync(
      require.resolve('../StoryboardProPipeline'),
      'utf-8',
    )
    const charExtractMatch = source.match(
      /characterExtractFn[\s\S]*?(?=shotDesignFn|Pass 3)/,
    )
    expect(charExtractMatch).toBeTruthy()
    // Should NOT reference StoryboardObjSchema (full 11-field) in L1
    expect(charExtractMatch![0]).not.toContain('StoryboardObjSchema')
    // Should NOT have L2 SimpleObjArraySchema retry (second LLM call)
    expect(charExtractMatch![0]).not.toContain('L2')
    expect(charExtractMatch![0]).not.toContain('trying L2')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts --reporter=verbose`

Expected: FAIL — source still uses StoryboardObjSchema in L1 and has L2 block

**Step 3: Implement — simplify characterExtractFn**

Replace the entire L1+L2 body of `characterExtractFn` (lines 369-415) with:

```typescript
        // --- L1: SimpleObjArraySchema (4 fields) + includeRaw + greedy regex ---
        let parsed: any = null
        try {
          const structuredWithRaw = self.createStructuredLLMWithRaw(SimpleObjArraySchema)
          const response = await structuredWithRaw.invoke(userMessages, { signal: config?.signal })
          parsed = (response as any)?.parsed
          if (!parsed?.objs?.length) {
            const rawText = typeof (response as any)?.raw?.content === 'string'
              ? (response as any).raw.content : ''
            try {
              const match = rawText.match(/\{[\s\S]*"objs"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
              if (match) {
                const fallback = JSON.parse(match[0])
                if (fallback?.objs?.length) {
                  parsed = fallback
                  console.log(`[StoryboardProPipeline] characterExtract: recovered ${parsed.objs.length} objs via raw extraction`)
                }
              }
            } catch { /* regex fallback failed */ }
          }
        } catch (e: unknown) {
          console.warn('[StoryboardProPipeline] characterExtract L1 error:', e instanceof Error ? e.message : String(e))
        }

        if (!parsed?.objs?.length) {
          parsed = { objs: [] }
          console.warn('[StoryboardProPipeline] characterExtract: extraction failed, continuing with empty')
        }
```

Also update the `assembleResult` method — since we now use `SimpleObjArraySchema` which returns `{n, f, t, act}`, we need to pad the missing fields for backward compatibility:

```typescript
        // After parsed is resolved, pad missing fields for downstream
        const paddedObjs = (parsed.objs || []).map((o: any) => ({
          n: o.n || '', f: o.f || '', t: o.t || '', act: o.act || '',
          s: o.s || 'fg|center|Z1', p: o.p || 'artic', tc: o.tc || '',
          fx: o.fx ?? null, motive: o.motive || '', a: o.a || '', m: o.m || '',
        }))
```

**Step 4: Run test to verify it passes**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts --reporter=verbose`

Expected: PASS

**Step 5: Run full storyboard test suite**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/ --reporter=verbose`

Expected: All tests pass

---

### Task 3: 清理未使用的 Schema 引用

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` (imports at top)

**Step 1: Check if StoryboardObjSchema import is still needed**

After Task 2, `characterExtractFn` no longer uses `StoryboardObjSchema`. Check if `assembleResult` or other code still references it.

Grep for `StoryboardObjSchema` in the file. If only the import line remains, remove it.

**Step 2: Check if SimpleSceneSchema is still needed**

After Task 1, `sceneDecomposeFn` no longer uses `SimpleSceneSchema`. Check if any other code references it.

If only the definition (lines 49-53) remains with no callers, remove it.

**Step 3: Verify clean compile**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/ --reporter=verbose`

Expected: All tests pass, no unused import warnings

---

## 架构对齐总结

| 维度 | 改前 | 改后 |
|------|------|------|
| Pass 1 sceneDecompose LLM 调用 | 1-2 次 | **1 次** |
| Pass 2 characterExtract LLM 调用 | 1-2 次 | **1 次** |
| Pass 2 L1 schema 字段数 | 11 字段/角色 | **4 字段/角色** |
| ERR_CONNECTION_CLOSED 恢复 | 发起 L2 全新调用 | raw regex fallback（免费）|
| Pass 3 shotDesign | 不变（保留 L1/L2/L3） | 不变 |

## 下游兼容性

- `assembleResult()` 中已有字段 padding 逻辑，`SimpleObjArraySchema` 的 4 字段会被扩展为完整 11 字段格式
- `shotDesignFn` 只使用 `o.n`, `o.t`, `o.act` — 与 SimpleObjArraySchema 完全对齐
- 深度校验 (`deepVerifyFn`) 只使用 `o.n`, `o.t` — 也完全对齐
