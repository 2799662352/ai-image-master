# Director Stream Termination Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复导演模式“图片成功后按钮仍显示生成中”的卡住问题，并用回归测试锁定。

**Architecture:** 基于 LangGraph 官方 streaming 语义，消费者不应只依赖单一事件源（`custom`）判定完成；应同时识别终局 `updates`（`generateImages`）并可安全退出。通过先写失败测试复现“仅 updates 且 stream 不关闭”的场景，再最小修改 `DirectorPipeline.execute()` 的退出条件实现修复。最后补跑现有回归，确保无副作用。

**Tech Stack:** TypeScript, Vitest, React, Zustand, LangGraphJS (`@langchain/langgraph`)

---

### Task 1: 增加仅 updates 终局的失败回归测试（RED）

**Files:**
- Modify: `src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`

**Step 1: 写失败测试**

在同一测试文件新增用例，模拟 stream 只发 `updates` 且包含 `generateImages`，随后迭代器永不结束；期望 `execute()` 仍能及时 resolve。

```ts
it('仅 updates 包含 generateImages 且 stream 挂起时，execute 应返回', async () => {
  const pipeline = new DirectorPipeline({
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'http://localhost',
  } satisfies PipelineConfig)

  const updatesOnlyHangingStream = async function* () {
    yield ['updates', { generateImages: { images: [{ id: 1, url: 'u', prompt: 'p' }] } }]
    await new Promise(() => {})
  }

  ;(pipeline as any)._graph = { stream: vi.fn(updatesOnlyHangingStream) }

  const executePromise = pipeline.execute({})
  const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 120))
  const winner = await Promise.race([executePromise.then(() => 'done' as const), timeoutPromise])
  expect(winner).toBe('done')
})
```

**Step 2: 运行测试验证失败**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`
Expected: FAIL（新用例超时，得到 `timeout`）

**Step 3: 最小实现（留到 Task 2）**

该步骤故意不实现，保持 RED。

**Step 4: 再次确认 RED**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`
Expected: 仍 FAIL（确认测试有效）

**Step 5: Commit**

暂不提交，待 Task 2/3 一并通过后再由用户决定。

---

### Task 2: 修改 execute 终止策略（GREEN）

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`

**Step 1: 写最小实现**

在 `mode === 'updates'` 分支里，如果 `updatesData` 含有 `generateImages`，立即合并到 `finalState` 并 `break`。保留现有 custom 分支逻辑，形成“双通道终局判定”。

```ts
const updatesData = data && typeof data === 'object' ? data : {}
const entries = Object.entries(updatesData)
if (entries.length > 0) {
  const [, output] = entries[0] as [string, any]
  finalState = { ...finalState, ...output }
}

const hasGenerateImagesOutput = Object.prototype.hasOwnProperty.call(updatesData, 'generateImages')
if (hasGenerateImagesOutput) {
  const generateImagesOutput = (updatesData as any).generateImages
  if (generateImagesOutput && typeof generateImagesOutput === 'object') {
    finalState = { ...finalState, ...generateImagesOutput }
  }
  break
}
```

**Step 2: 运行目标测试验证通过**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`
Expected: PASS

**Step 3: 代码检查**

确保不会因 `custom` 缺失导致无法退出；确保 `finalState.images` 在 break 前可被保留。

**Step 4: 保持变更最小化**

不改 UI 层按钮逻辑、不改 graph 拓扑，避免引入新变量。

**Step 5: Commit**

暂不提交，待 Task 3 完整验证后再由用户决定。

---

### Task 3: 关联回归与质量验证（REFACTOR/VERIFY）

**Files:**
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts`
- Test: `src/renderer/src/react-app/__tests__/useDirectorGeneration.nonblocking-history.test.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
- Check: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 跑 pipeline 相关回归**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts`
Expected: PASS

**Step 2: 跑 UI/Hook 相关回归**

Run: `npm test -- src/renderer/src/react-app/__tests__/useDirectorGeneration.nonblocking-history.test.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
Expected: PASS

**Step 3: 检查 lints（仅变更文件）**

Run lints for `DirectorPipeline.ts` 与新增/修改测试文件，确保无新增错误。

**Step 4: 输出验证结论**

记录：
- RED -> GREEN 过程（失败截图/输出摘要）
- Context7 + 官方文档对应的设计依据
- 用户手测关注点（按钮是否回到“一键生成漫画分镜”）

**Step 5: Commit**

暂不提交（除非用户明确要求）。

# Director Stream Termination Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复导演模式在图片成功后按钮仍停留“生成中”的问题，确保前端能稳定退出生成态。

**Architecture:** 采用“双保险”方案：先按 LangGraph 官方 fan-in 方式保证图编排正确（Pass 0 只做路由，不提前进入设计）；再在 `execute()` 增加终止-pass 收敛逻辑，避免底层 stream 异常挂起时 UI 永远等待。通过管线级回归测试覆盖“stream 不结束”场景。  
同时引入 Context7 官方文档依据，避免与 LangGraph 执行语义偏离。

**Tech Stack:** TypeScript, Vitest, Zustand, LangGraph.js (`@langchain/langgraph`)

---

### Task 1: 收集官方语义与定位根因

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`
- Docs: `docs/plans/2026-03-03-director-stream-termination-fix.md`

**Step 1: 查 Context7 官方文档（LangGraph overview / graph API / streaming）**

调用 Context7（`resolve-library-id` + `query-docs`）确认：
- Graph 以 super-step 执行
- `stream()` 在图执行完成（无 active node / 无在途消息）后结束
- fan-in 可用多入边实现（`A->D` 与 `B->D`；或数组语法）

**Step 2: 写出根因假设**

假设：
1. `selectSkills` 提前触发后续节点，导致并发时序复杂化；
2. 即便终端 pass 已产生，如果 stream 异常不结束，`startGeneration` 仍 await，按钮保持“生成中”。

**Step 3: 确认验证标准**

验证标准：
- 出现终端 pass 后，`execute()` 可在合理时机返回；
- 现有导演模式测试不回归。

### Task 2: 先红灯测试（stream 不结束也要返回）

**Files:**
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`

**Step 1: 写失败测试（RED）**

```ts
it('stream 不结束时，收到最终 pass 后 execute 也应返回', async () => {
  // mock: custom pass_complete(terminal) + updates，然后永不结束
  // 期望 executePromise 在超时前 resolve
})
```

**Step 2: 运行单测确认失败**

Run: `npm run test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`  
Expected: FAIL（executePromise 卡住，race 命中 timeout）

### Task 3: 最小实现（GREEN）

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 修图编排为 fan-in**

确保设计节点只在两个分析分支之后执行（避免 Pass 0 直连设计）：

```ts
.addEdge('selectSkills', 'analyzeScene')
.addEdge('selectSkills', 'extractCharacterAnchors')
.addEdge(['analyzeScene', 'extractCharacterAnchors'], 'designAndAssemble')
```

**Step 2: 在 execute 中增加终端-pass 收敛**

当收到 `pass_complete` 且 `pass >= totalPasses` 时，标记可退出；  
若该事件已带最终图片，直接结束；否则等待对应 `updates.generateImages` 后结束。

**Step 3: 保持改动最小**

不改 UI 层状态机；仅修复管线收敛逻辑，遵循 DRY/YAGNI。

### Task 4: 全量验证与代码审查

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`
- Test: `src/renderer/src/react-app/__tests__/useDirectorGeneration.nonblocking-history.test.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`

**Step 1: 跑终止测试**

Run: `npm run test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`  
Expected: PASS

**Step 2: 跑导演模式回归测试**

Run: `npm run test -- src/renderer/src/react-app/__tests__/useDirectorGeneration.nonblocking-history.test.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: PASS

**Step 3: 执行 code-reviewer 风格检查**

- 检查早退逻辑是否丢最终 state；
- 检查并发边是否符合 LangGraph 官方语义；
- 检查是否新增副作用与死循环风险。

**Step 4: 记录结果**

将通过的测试命令与输出摘要附在本次交付说明中。

