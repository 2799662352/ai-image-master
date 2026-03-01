# Pipeline Review Fixes 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Code Review 中 3 个 Important 级别问题：retryPolicy 节点级重试、RunnableConfig 传递、finalState 类型安全。

**Architecture:** 仅修改 `StoryboardPipelineService.ts`，不改其他文件。所有修复基于 context7 LangGraphJS 最佳实践。

**Tech Stack:** `@langchain/langgraph@1.2.0`, `@langchain/core/runnables` (RunnableConfig), TypeScript

---

### Task 1: 添加 RunnableConfig 到所有 node 函数 (C2)

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 添加 RunnableConfig import**

在文件顶部 import 中添加:

```typescript
import type { RunnableConfig } from '@langchain/core/runnables'
```

**Step 2: 修改 4 个 LLM node 函数签名，接受 config 并传递给 invoke**

每个 LLM node 函数改为:

```typescript
async function analyzeScene(_state: typeof PipelineState.State, config?: RunnableConfig) {
  // ...
  const result = await sceneLlm.invoke([systemMsg, buildImageMsg(userText)], config)
  return { scene: result }
}

async function extractCharacters(state: typeof PipelineState.State, config?: RunnableConfig) {
  // ...
  const result = await characterLlm.invoke([systemMsg, buildImageMsg(userText)], config)
  return { characters: result.characters }
}

async function generateShots(state: typeof PipelineState.State, config?: RunnableConfig) {
  // ...
  const result = await shotLlm.invoke([systemMsg, buildTextMsg(userText)], config)
  return { shots: result.shots }
}

async function verifyConsistency(state: typeof PipelineState.State, config?: RunnableConfig) {
  // ...
  const result = await reportLlm.invoke([systemMsg, buildTextMsg(...)], config)
  return { report: result }
}
```

注意: `prepareRetry` 是纯逻辑函数，不调 LLM，不需要 config。

**Step 3: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 4: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "fix: pass RunnableConfig through pipeline nodes for tracing support"
```

---

### Task 2: 添加 retryPolicy 到 LLM nodes (C3)

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 在 addNode 调用中添加 retryPolicy**

```typescript
const graph = new StateGraph(PipelineState)
  .addNode('analyzeScene', analyzeScene, { retryPolicy: { maxAttempts: 3 } })
  .addNode('extractCharacters', extractCharacters, { retryPolicy: { maxAttempts: 3 } })
  .addNode('generateShots', generateShots, { retryPolicy: { maxAttempts: 3 } })
  .addNode('verifyConsistency', verifyConsistency, { retryPolicy: { maxAttempts: 2 } })
  .addNode('prepareRetry', prepareRetry)
  // edges 保持不变...
```

Pass 1-3 用 maxAttempts: 3（LLM 调用可能偶尔失败）
Pass 4 用 maxAttempts: 2（校验逻辑更稳定）
prepareRetry 无 retryPolicy（纯函数不会失败）

**Step 2: Build 验证**

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "feat: add node-level retryPolicy for LLM call resilience"
```

---

### Task 3: 修复 finalState 类型安全 (C4)

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 定义 pipeline result 收集类型，替换 `as any`**

在 `analyze()` 方法内，将:

```typescript
let finalState: typeof PipelineState.State | null = null
// ...
finalState = { ...(finalState || {}), ...nodeOutput } as any
```

替换为:

```typescript
const collected: {
  scene?: SceneAnalysis
  characters?: CharacterAnchor[]
  shots?: ShotData[]
  report?: ConsistencyReport
} = {}

// ... 在 stream loop 中:
if (nodeName === 'analyzeScene') {
  collected.scene = nodeOutput.scene
  // onProgress...
} else if (nodeName === 'extractCharacters') {
  collected.characters = nodeOutput.characters
  // onProgress...
} else if (nodeName === 'generateShots') {
  collected.shots = nodeOutput.shots
  // onProgress...
} else if (nodeName === 'verifyConsistency') {
  collected.report = nodeOutput.report
  // onProgress...
}

// ... 最终检查:
if (!collected.scene || !collected.characters || !collected.shots || !collected.report) {
  throw new Error('Pipeline incomplete: missing pass results')
}

return aggregateToStoryboardResponse(
  collected.scene, collected.characters, collected.shots, collected.report
)
```

**Step 2: Build 验证**

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "fix: replace 'as any' with typed result collection for pipeline state"
```

---

### Task 4: Build + 验证

**Step 1: Full Build**

Run: `npm run build:vite`

**Step 2: 验证改动**

1. 所有 node 函数签名包含 `config?: RunnableConfig`
2. 所有 LLM `.invoke()` 调用传递 `config`
3. 所有 LLM node 有 `retryPolicy`
4. 无 `as any` 类型逃逸
