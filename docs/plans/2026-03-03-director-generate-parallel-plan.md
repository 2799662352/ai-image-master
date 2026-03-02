# Director Parallel Generate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将导演模式最后一步“图像生成”从串行改为默认 3 并发，提升速度并保持现有进度事件与稳定性。

**Architecture:** 在 `DirectorPipeline.generateImagesFn` 内引入“并发池 + allSettled”执行器，限制并发为 3，避免全并发导致限流。每个任务完成后继续发送 `image_generated` 流式事件，最终统一汇总 `results` 并发送 `pass_complete`。实现前先写失败测试验证“并发确实发生”和“部分失败不拖垮整体”。

**Tech Stack:** TypeScript, Vitest, LangGraph.js, existing `ApiService.generateImage`

---

### Task 1: 为并发行为写失败测试（RED）

**Files:**
- Modify: `src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`
- Create: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

**Step 1: 写“并发速度”失败测试**

```ts
it('imageCount=3 时应并发执行（总耗时明显小于串行）', async () => {
  // mock generateImage: 每次固定等待 100ms 后返回
  // 若串行约 300ms；并发=3 应接近 100~160ms
  // 断言 elapsed < 220ms
})
```

**Step 2: 写“部分失败可恢复”失败测试**

```ts
it('并发任务中部分失败时，仍应返回成功图片并完成 pass', async () => {
  // mock: 3 个任务中 1 个失败
  // 断言返回数组长度=3，且至少2个有效 url
})
```

**Step 3: 运行单测确认 RED**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`  
Expected: FAIL（当前串行实现无法满足并发时延断言）

**Step 4: 校验旧回归不受影响**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`  
Expected: PASS

**Step 5: 暂不提交**

保持 RED 状态进入 Task 2。

---

### Task 2: 最小实现 3 并发池（GREEN）

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

**Step 1: 新增并发常量与任务函数**

```ts
const GENERATE_CONCURRENCY = 3

const runOne = async (i: number) => {
  const result = await apiService.generateImage(...)
  // 组装单条结果并 emit image_generated
  return oneResult
}
```

**Step 2: 用并发池替代串行 for-loop**

```ts
const queue = Array.from({ length: imageCount }, (_, i) => i)
const workers = Array.from(
  { length: Math.min(GENERATE_CONCURRENCY, imageCount) },
  async () => {
    while (queue.length > 0) {
      const i = queue.shift()
      if (i === undefined) break
      results[i] = await runOne(i)
    }
  }
)
await Promise.allSettled(workers)
```

**Step 3: 保持事件协议不变**

- 每个任务完成时发送 `image_generated`  
- 全部完成后发送 `pass_complete`  
- `passNum`、`label`、`total` 字段格式保持现状

**Step 4: 运行目标测试验证 GREEN**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`  
Expected: PASS

**Step 5: 运行原回归**

Run: `npm test -- src/renderer/src/services/pipeline/__tests__/director-pipeline-stream-termination.test.ts`  
Expected: PASS

---

### Task 3: 文档依据与完整验证（VERIFY）

**Files:**
- Modify: `docs/plans/2026-03-03-director-generate-parallel-plan.md`
- Check: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/react-app/__tests__/useDirectorGeneration.nonblocking-history.test.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`

**Step 1: 查询 Context7 文档并记录依据**

调用 Context7（LangGraph）确认：
- streaming 事件处理建议
- 节点内异步任务并发执行的稳定模式
- 部分失败容错实践（allSettled 风格）

将结论写入本计划“验证记录”小节（简要 3-5 条）。

**Step 2: 跑导演模式相关回归**

Run: `npm test -- src/renderer/src/react-app/__tests__/useDirectorGeneration.nonblocking-history.test.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: PASS

**Step 3: 读取 lints（仅改动文件）**

检查：
- `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

Expected: 无新增 lint/type 错误

**Step 4: 交付结果摘要**

记录：
- 串行 vs 并发耗时对比
- 失败容错结果（成功/失败数量）
- UI 侧“步骤 4/5”是否更快推进

**Step 5: Commit（按用户指令执行）**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts docs/plans/2026-03-03-director-generate-parallel-plan.md
git commit -m "feat(director): parallelize final image generation with bounded concurrency"
```

