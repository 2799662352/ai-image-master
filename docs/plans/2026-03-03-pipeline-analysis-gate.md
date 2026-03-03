# Pipeline Analysis Gate — 空数据拦截 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 当场景分析/角色锚点返回空时，拦截并重试这两个 pass，而不是带着空数据继续往下走浪费 API 调用。

**Architecture:** 在 LangGraph 图中，在 `[analyzeScene, extractCharacterAnchors]` fan-in 之后、`designAndAssemble` 之前，插入一个 `validateAnalysis` 门控节点。该节点检查 scene/characters 是否为空，若空则将 `analysisRetryCount` +1 并路由回 `analyzeScene`+`extractCharacterAnchors` 重试；若超过最大重试次数则提前终止管线并给出明确错误。参考 [LangGraph conditional edges](https://docs.langchain.com/oss/javascript/langgraph/overview) 的 `addConditionalEdges` 模式。

**Tech Stack:** LangGraph StateGraph, Zod, TypeScript, Vitest

**Context7 依据：**
1. LangGraph `retryPolicy: { maxAttempts: N }` 处理节点内部重试（网络错误级别）。
2. LangGraph `addConditionalEdges` 可实现基于 state 的路由回退到早期节点。
3. Fan-in join (`addEdge([nodeA, nodeB], nodeC)`) 确保多个并行节点完成后再进入下一步。

---

### Task 1: 扩展 stateSchema 新增 analysisRetryCount

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:26-70`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

**Step 1: Write the failing test**

```typescript
it('stateSchema should include analysisRetryCount with default 0', () => {
  const parsed = stateSchema.parse({})
  expect(parsed.analysisRetryCount).toBe(0)
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: FAIL — `analysisRetryCount` 不存在

**Step 3: Write minimal implementation**

在 `stateSchema` 中 `retryCount` 之后新增：

```typescript
analysisRetryCount: z.number().default(0),
```

同时在文件顶部新增常量：

```typescript
const MAX_ANALYSIS_RETRIES = 2
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts
git commit -m "feat(pipeline): add analysisRetryCount to stateSchema for analysis gate"
```

---

### Task 2: 实现 validateAnalysis 门控节点 + 路由函数

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (buildGraph 方法内)
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

**Step 1: Write the failing test**

```typescript
import { DirectorPipeline, getSemanticOrientationInstruction } from '../DirectorPipeline'

it('validateAnalysis should return retry when scene and characters are null', () => {
  const state = {
    scene: null,
    characters: null,
    analysisRetryCount: 0,
  }
  // 我们测试导出的辅助函数
  const { shouldRetryAnalysis } = require('../DirectorPipeline')
  expect(shouldRetryAnalysis(state)).toBe('retry')
})

it('validateAnalysis should return continue when scene has data', () => {
  const state = {
    scene: { env: 'forest', subjects: [], style: '', story: '' },
    characters: { characters: [] },
    analysisRetryCount: 0,
  }
  const { shouldRetryAnalysis } = require('../DirectorPipeline')
  expect(shouldRetryAnalysis(state)).toBe('continue')
})

it('validateAnalysis should return abort when max retries exceeded', () => {
  const state = {
    scene: null,
    characters: null,
    analysisRetryCount: 2,
  }
  const { shouldRetryAnalysis } = require('../DirectorPipeline')
  expect(shouldRetryAnalysis(state)).toBe('abort')
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: FAIL — `shouldRetryAnalysis` 不存在

**Step 3: Write minimal implementation**

在 `DirectorPipeline.ts` 中 `getSemanticOrientationInstruction` 之后新增导出函数：

```typescript
export function shouldRetryAnalysis(state: { scene: any; characters: any; analysisRetryCount: number }): 'retry' | 'continue' | 'abort' {
  const sceneOk = state.scene && state.scene.env && state.scene.env !== '(analysis failed)'
  const charsOk = state.characters && Array.isArray(state.characters.characters)
  if (sceneOk || charsOk) return 'continue'
  if (state.analysisRetryCount >= MAX_ANALYSIS_RETRIES) return 'abort'
  return 'retry'
}
```

在 `buildGraph()` 方法内新增 `validateAnalysisFn` 和 `prepareAnalysisRetryFn`：

```typescript
const validateAnalysisFn = (state: DirectorState) => {
  return {}
}

const prepareAnalysisRetryFn = (state: DirectorState, config: any) => {
  const count = state.analysisRetryCount + 1
  console.warn(`[DirectorPipeline] Analysis data empty, retrying (${count}/${MAX_ANALYSIS_RETRIES})...`)
  writer(config)?.({
    type: 'pass_complete',
    pass: 1,
    label: `场景/角色数据为空，重试中 (${count}/${MAX_ANALYSIS_RETRIES})...`,
    elapsed: 0,
    passData: null,
  })
  return {
    analysisRetryCount: count,
    scene: null,
    characters: null,
  }
}

const abortPipelineFn = (state: DirectorState, config: any) => {
  const msg = '场景分析和角色锚点均失败（可能是网络问题），管线终止。请检查网络后重试。'
  console.error(`[DirectorPipeline] ${msg}`)
  writer(config)?.({
    type: 'pass_complete',
    pass: 1,
    label: msg,
    elapsed: 0,
    passData: null,
  })
  return { images: [] }
}

const routeAfterAnalysis = (state: DirectorState): 'continue' | 'retry' | 'abort' => {
  return shouldRetryAnalysis(state as any)
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts
git commit -m "feat(pipeline): add validateAnalysis gate node and routing function"
```

---

### Task 3: 重新布线 LangGraph 图，插入门控节点

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:780-807` (buildGraph 的 Graph Assembly 部分)
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

**Step 1: Run existing tests as baseline**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: ALL PASS

**Step 2: Modify Graph Assembly**

将当前的：

```typescript
const graph = new StateGraph(stateSchema)
  .addNode('selectSkills', selectSkillsFn)
  .addNode('analyzeScene', analyzeSceneFn, { retryPolicy: retryLLM })
  .addNode('extractCharacterAnchors', extractCharacterAnchorsFn, { retryPolicy: retryLLM })
  .addNode('designAndAssemble', designAndAssembleFn)
  .addNode('verifyConsistency', verifyConsistencyFn)
  .addNode('prepareRetry', prepareRetryFn)
  .addNode('generateImages', generateImagesFn)
  .addEdge(START, 'selectSkills')
  .addEdge('selectSkills', 'analyzeScene')
  .addEdge('selectSkills', 'extractCharacterAnchors')
  .addEdge(['analyzeScene', 'extractCharacterAnchors'], 'designAndAssemble')
  // ...rest
```

改为：

```typescript
const graph = new StateGraph(stateSchema)
  .addNode('selectSkills', selectSkillsFn)
  .addNode('analyzeScene', analyzeSceneFn, { retryPolicy: retryLLM })
  .addNode('extractCharacterAnchors', extractCharacterAnchorsFn, { retryPolicy: retryLLM })
  .addNode('validateAnalysis', validateAnalysisFn)
  .addNode('prepareAnalysisRetry', prepareAnalysisRetryFn)
  .addNode('abortPipeline', abortPipelineFn)
  .addNode('designAndAssemble', designAndAssembleFn)
  .addNode('verifyConsistency', verifyConsistencyFn)
  .addNode('prepareRetry', prepareRetryFn)
  .addNode('generateImages', generateImagesFn)
  .addEdge(START, 'selectSkills')
  .addEdge('selectSkills', 'analyzeScene')
  .addEdge('selectSkills', 'extractCharacterAnchors')
  .addEdge(['analyzeScene', 'extractCharacterAnchors'], 'validateAnalysis')
  .addConditionalEdges('validateAnalysis', routeAfterAnalysis, {
    continue: 'designAndAssemble',
    retry: 'prepareAnalysisRetry',
    abort: 'abortPipeline',
  })
  .addEdge('prepareAnalysisRetry', 'analyzeScene')
  .addEdge('prepareAnalysisRetry', 'extractCharacterAnchors')
  .addEdge('abortPipeline', END)
  .addConditionalEdges('designAndAssemble', routeAfterDesign, {
    verify: 'verifyConsistency',
    generate: 'generateImages',
  })
  .addConditionalEdges('verifyConsistency', routeVerify, {
    retry: 'prepareRetry',
    generate: 'generateImages',
  })
  .addEdge('prepareRetry', 'designAndAssemble')
  .addEdge('generateImages', END)
```

新的流程图：

```
selectSkills
  ├── analyzeScene ──┐
  └── extractCharacterAnchors ──┤
                                ▼
                         validateAnalysis
                        /      |       \
                   continue   retry    abort
                      |        |         |
               designAndAssemble  prepareAnalysisRetry  abortPipeline → END
                      |               |
                  (原有流程)    → analyzeScene + extractCharacterAnchors (循环)
```

**Step 3: Run tests to verify**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: ALL PASS

**Step 4: Run all related tests**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts
git commit -m "feat(pipeline): wire validateAnalysis gate into graph — abort on empty scene/characters instead of proceeding with garbage data"
```
