# Hybrid Verify — Design Document

**Date:** 2026-03-05
**Status:** Approved
**Problem:** `verifyConsistency`（一致性校验）是 Pipeline 最大的性能瓶颈。它发送参考图给 LLM（vision 模式，10-30s），不通过触发 retry 循环（designAndAssemble + 再校验），多场景模式下 N 个场景 × 校验时间 = 严重延迟。

---

## 1. Problem Analysis

### 1.1 Current Flow

```
designAndAssemble → verifyConsistency (LLM + vision, 10-30s)
  → score < threshold → prepareRetry → designAndAssemble (again) → verifyConsistency (again)
  → score >= threshold → generateImages
```

**最差路径**：designAndAssemble (15s) + verify (20s) + retry designAndAssemble (15s) + retry verify (20s) = **70s** 仅在 Pass 3-4。

### 1.2 Root Cause

1. `verifyConsistencyFn` 发送全部参考图（`buildImageContent`），vision 延迟是最大瓶颈
2. 校验内容实际上是 **文本比对**（panel prompts vs character anchors），不需要看图
3. 重试循环 = 2 倍延迟放大
4. 多场景模式 = N 倍延迟放大

---

## 2. Design: Hybrid Verify

### 2.1 Architecture

两层校验替代单层 LLM 校验：

```
designAndAssemble → codeVerify (instant, <10ms)
  → score >= threshold → generateImages（默认快速路径）
  → score < threshold → [if deepVerify enabled] → LLM verifyConsistency (text-only, no vision)
                         [if deepVerify disabled] → generateImages with warning
```

### 2.2 Code-Level Verify (`codeVerify`)

纯 TypeScript 函数，不调用 LLM，检查硬性规则：

```typescript
export function codeVerify(state: DirectorState): z.infer<typeof VerifySchema> {
  let score = 10
  const issues: string[] = []
  const anchors = state.characters?.characters || []
  const prompts = state.prompts || []
  const stylePrefix = resolveStylePrefix(state.styleAnchor, state.template, state.styleInstructions)

  // Rule 1: Panel count matches layout
  if (prompts.length !== state.layout.panelCount) {
    issues.push(`Expected ${state.layout.panelCount} panels, got ${prompts.length}`)
    score -= 3
  }

  // Rule 2: Character name presence in panel prompts
  for (const anchor of anchors) {
    const name = anchor.name.toLowerCase()
    const missingPanels = prompts.filter(p => !p.prompt.toLowerCase().includes(name))
    if (missingPanels.length > prompts.length / 2) {
      issues.push(`Character "${anchor.name}" missing from ${missingPanels.length}/${prompts.length} panels`)
      score -= 2
    }
  }

  // Rule 3: Style token consistency
  if (stylePrefix) {
    const firstToken = stylePrefix.split(',')[0].trim().toLowerCase()
    const missingStyle = prompts.filter(p => !p.prompt.toLowerCase().includes(firstToken))
    if (missingStyle.length > 0) {
      issues.push(`Style token "${firstToken}" missing from ${missingStyle.length} panels`)
      score -= 1
    }
  }

  // Rule 4: Empty prompts
  const emptyPrompts = prompts.filter(p => !p.prompt.trim())
  if (emptyPrompts.length > 0) {
    issues.push(`${emptyPrompts.length} panels have empty prompts`)
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
    styleConsistency: stylePrefix ? (issues.some(i => i.includes('Style')) ? 5 : 10) : undefined,
  }
}
```

### 2.3 LLM Deep Verify（优化版）

保留现有 `verifyConsistencyFn`，但做两项优化：
1. **去掉参考图** — 不发送 `buildImageContent`，纯文本模式
2. **仅在 codeVerify 不通过时触发** — 或用户显式选择深度模式

### 2.4 Graph Routing 变更

```
designAndAssemble
  → [new] codeVerifyNode (instant)
    → codeScore >= threshold → generateImages
    → codeScore < threshold && !skipVerify → verifyConsistency (LLM, text-only)
    → codeScore < threshold && skipVerify → generateImages (with warning)
```

新增 `codeVerifyNode`，修改路由逻辑。

### 2.5 State Schema 变更

无新增字段 — `report` 字段同时承载 codeVerify 和 LLM verify 的结果。

---

## 3. Affected Files

| 文件 | 改动 |
|------|------|
| `DirectorPipeline.ts` | 新增 `codeVerify` 函数 + `codeVerifyNode` + 修改路由 + LLM verify 去掉 vision |
| `director-skip-stages.test.ts` | 新增 `codeVerify` 测试 |

---

## 4. Performance Impact

| 场景 | 当前 | 优化后 |
|------|------|--------|
| 单次生成（校验通过） | ~20s verify | <10ms codeVerify |
| 单次生成（需要重试） | ~40s (verify + retry + verify) | <10ms codeVerify → ~5s text-only LLM |
| 4 场景多场景模式 | ~80s verify | <40ms codeVerify |

---

## 5. Scope

**In scope:**
- `codeVerify` 纯函数
- 新 graph 节点 + 路由
- LLM verify 去掉 vision（不再发参考图）
- 测试

**Not in scope:**
- UI 变更（已有 `skipVerify` 开关足够）
- Store 变更
- 新增用户设置
