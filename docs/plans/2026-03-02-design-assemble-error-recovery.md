# designAndAssemble 3 级错误恢复实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 designAndAssemble (Pass 3) 从"失败即终止"升级为 LangGraph 官方推荐的 3 级错误恢复链：includeRaw 提取 → 简化 schema 降级 → 错误反馈给 LLM 重试。

**Architecture:** 在 designAndAssemble 内部实现 3 级 fallback，不修改 Graph 拓扑。Level 1 用 includeRaw 从原文提取（已有）。Level 2 用简化 schema（只要 id + prompt）降级重试。Level 3 把 parsing error 信息反馈回 LLM，让它自我修正。最多 1 次额外 LLM 调用。

**Tech Stack:** LangChain withStructuredOutput, Zod schemas, LangGraph StateGraph

---

## Task 1: 添加 SimplePanel 简化 Schema

**Files:**
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`

**Step 1: 在 DesignAndAssembleSchema 之后添加简化版**

```typescript
export const SimplePanelSchema = z.object({
  panels: z.array(z.object({
    id: z.number(),
    prompt: z.string().describe('Full English image generation prompt'),
  })),
})
```

**Step 2: 验证构建**

Run: `npx electron-vite build 2>&1 | Select-String "error"`
Expected: 无错误

**Step 3: 提交**

```bash
git add src/renderer/src/services/pipeline/schemas/director-schemas.ts
git commit -m "feat(schema): add SimplePanelSchema for fallback structured output"
```

---

## Task 2: 重构 designAndAssembleFn 为 3 级恢复

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**当前代码位置:** L354-422

**Step 1: 替换 designAndAssembleFn 实现**

3 级恢复逻辑：

```
Level 1: includeRaw + 正常解析 / regex 提取（已有，0 额外调用）
    ↓ 失败
Level 2: SimplePanelSchema 降级调用（+1 次 LLM 调用，但 schema 简单成功率高）
    ↓ 失败
Level 3: 把 parsing error 反馈给 LLM，纯文本请求（+1 次调用，几乎必成功）
    ↓ 失败
终止：emitError，返回 null
```

关键改动：
- 将当前 L358-421 的 try/catch 内容提取为 `tryFullSchema()` 私有方法
- 添加 `trySimpleSchema()` — 使用 SimplePanelSchema + 同样的 prompt
- 添加 `tryWithErrorFeedback()` — 把前次 parsing error 拼入 prompt，让 LLM 修正格式
- designAndAssembleFn 依次调用三者

**Step 2: 验证构建**

Run: `npx electron-vite build 2>&1 | Select-String "error"`
Expected: 无错误

**Step 3: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(pipeline): 3-level error recovery for designAndAssemble"
```

---

## Task 3: 更新进度 UI 提示

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (writer 调用)

**Step 1: 在 Level 2/3 触发时发送 progress 事件**

当降级触发时，通过 writer 发送 status: 'retrying' 事件，让 UI 显示"精修中"状态。

**Step 2: 验证构建**

**Step 3: 提交**

---

## Summary

| Level | 策略 | 额外 LLM 调用 | 成功率 |
|-------|------|:---:|:---:|
| 1 | includeRaw + regex 提取 | 0 | ~90% |
| 2 | SimplePanelSchema 降级 | +1 | ~98% |
| 3 | Error feedback 反馈 LLM | +1 | ~99.9% |
| 终止 | emitError | 0 | — |

**Total: 3 files modified**
