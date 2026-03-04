# Official Evaluator-Optimizer Pattern — Design Document

**Date:** 2026-03-05
**Status:** Approved
**Problem:** 当前 Pipeline 的校验层有 3 个节点（codeVerify + verifyConsistency + prepareRetry），与 LangGraph 官方 Evaluator-Optimizer 模式不一致，过于复杂。

## Official Pattern (from LangGraph docs)

```
generator → evaluator → conditionalEdge → [accepted: END | rejected+feedback: generator]
```

- **Generator**: 生成内容，如果有 feedback 则参考 feedback 做增量修复
- **Evaluator**: LLM structured output 评估质量，输出 grade + feedback
- **Conditional Edge**: grade 通过 → END，不通过 → 回到 generator（带 feedback）

## Target Architecture

```
selectSkills → [analyzeScene ∥ extractCharacterAnchors ∥ extractStyleAnchor]
  → validateAnalysis
  → designAndAssemble (generator — checks feedback for incremental fix)
  → verifyConsistency (evaluator — LLM grades + feedback)
  → conditionalEdge → [accepted: generateImages | rejected: designAndAssemble]
```

**删除的节点：** `codeVerify`, `prepareRetry`
**保留的节点：** `verifyConsistency`（升级为唯一 evaluator）
**修改的节点：** `designAndAssemble`（已有 feedback 检查逻辑）

## Changes

1. **删除 `codeVerify` 函数和 `codeVerifyNode`**
2. **删除 `routeAfterCodeVerify` 函数**
3. **删除 `prepareRetryFn`** — feedback 构建逻辑合并到 `routeVerify`
4. **修改 `routeVerify`** — 官方模式：score < threshold → 返回 feedback + 路由回 designAndAssemble
5. **修改 graph assembly** — 简化为 `designAndAssemble → verifyConsistency → [generateImages | designAndAssemble]`
6. **更新 UI** — `GenerationProgress.tsx` 中 pass 5 从"快速校验"改为"一致性校验"
7. **更新 pass 编号** — 去掉 codeVerify 的 pass，后续编号前移
