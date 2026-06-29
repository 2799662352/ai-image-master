# Seedance 批量视频任务「立即出进度卡片」修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个 `generate_video` 调用在被触发的瞬间就在聊天里出现一张「进行中」卡片，不再被前置的 COS 中转 + 人像库导入压在后面——批量提交时也立刻能看到 N 张卡片。

**Architecture:** 根因是「进度卡片只在 `taskManager.submit()` 内、`createTask` 成功后才广播」，而 `submit` 之前还排着 `buildContent`(大图逐张 relay COS)+ `importImagesToPortraitLibrary`(逐张 COS relay + 上游导入)两段重活。修法：引入一个**客户端临时 id（clientId）**，在 `generate_video` 主处理器里**先于**重活广播一条 `queued` 预备卡片；之后真实任务的所有广播都带同一个 `clientId`，渲染端以 `clientId` 为气泡身份做对齐，复用同一张卡片（不重复建气泡）。前置阶段抛错时广播一条 `failed`，避免卡片永远转圈。

**Tech Stack:** TypeScript / Electron 主进程 / Zustand chat store / Vitest。改动集中在 4 个文件 + 2 个测试文件，零新增依赖。

---

## 背景：根因证据（来自 systematic-debugging）

- 卡片创建点：`SeedanceTaskListener.handleSeedanceTaskUpdate` 收到首条 `seedance:task-update` 才 `chat.beginImageGeneration(...)`。
- 首条广播点：`SeedanceTaskManager.submit()` 在 `await client.createTask()` **之后**才 `broadcast`。
- 前置重活：`runtime.ts` 的 `generate_video` 主处理器 = `buildContent` → `importImagesToPortraitLibrary` → `submit`，前两步对大图逐张走 COS（每次上传 SDK 超时 120s）。
- 表现：批量并发时前置上传打满网络，`createTask` 迟迟不发 → 无广播 → 无卡片（用户看到一堆 MCP 工具 running 但没有图 2 的卡片）。不是死锁（120s 超时保证最终推进），是「反馈被耦合在重活之后」的架构问题。

## File Structure

- **Modify** `src/types/seedance.ts` — 给 `SeedanceTaskState` 增加可选 `clientId`（三端共享载荷字段）。
- **Modify** `src/main/services/seedance/taskManager.ts` — 新增 `announcePreparing` / `announceFailed`，`submit` 把 `clientId` 写进状态；新增私有 `baseUpdate` 拼装合成广播。
- **Modify** `src/main/services/seedance/runtime.ts` — `generate_video` 主处理器先 `announcePreparing`，前置阶段抛错 `announceFailed`。
- **Modify** `src/renderer/src/features/agent-chat/SeedanceTaskListener.ts` — 气泡身份键从 `taskId` 改为 `clientId ?? taskId`，并复用同键删除。
- **Test** `src/main/services/seedance/__tests__/taskManager.test.ts` — 覆盖 `announcePreparing` / `announceFailed` / `submit` 带 clientId。
- **Test** `src/renderer/src/features/agent-chat/__tests__/seedanceTaskListener.test.ts` — 覆盖「预备卡片 + 真实 taskId 复用同一气泡」。

---

### Task 1: 给共享载荷加 `clientId` 字段（类型先行）

**Files:**
- Modify: `src/types/seedance.ts:14-38`

纯类型改动，无运行时测试；由 `npm run typecheck` 验证。`SeedanceTaskUpdate = SeedanceTaskState` 是别名，加在 `SeedanceTaskState` 上即三端通用。

- [ ] **Step 1: 在 `SeedanceTaskState` 末尾加 `clientId`**

把 `error?: string` 之后（`}` 之前）的字段块改成：

```typescript
  persistence: SeedancePersistence
  /** failed 时的上游错误（code: message）。 */
  error?: string
  /**
   * 渲染端用的「气泡身份」。generate_video 在真正 createTask 之前先用一个临时
   * clientId 广播一张「准备中」卡片；createTask 成功后真实任务的每条广播都带
   * 同一个 clientId，渲染端据此复用同一张卡片（见 SeedanceTaskListener）。
   * 缺省时（手动 MCP 调用等）渲染端回退用 taskId。
   */
  clientId?: string
}
```

- [ ] **Step 2: 运行 typecheck 确认无破坏**

Run: `npm run typecheck`
Expected: PASS（无新增错误；既有基线错误另算）。

- [ ] **Step 3: Commit**

```bash
git add src/types/seedance.ts
git commit -m "feat(seedance): add optional clientId to task state for bubble identity"
```

---

### Task 2: TaskManager 支持预备/失败广播 + submit 透传 clientId

**Files:**
- Modify: `src/main/services/seedance/taskManager.ts:12-21` (imports)
- Modify: `src/main/services/seedance/taskManager.ts:45-50` (`SubmitParams`)
- Modify: `src/main/services/seedance/taskManager.ts:63-100` (`submit`)
- Test: `src/main/services/seedance/__tests__/taskManager.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `taskManager.test.ts` 的 `describe('SeedanceTaskManager', ...)` 内、`it('submit 立即返回 queued 并广播', ...)` 之后插入：

```typescript
  it('announcePreparing 广播 queued 预备卡片并返回 clientId，不创建轮询任务', () => {
    const mgr = makeManager(makeClient([]))
    const clientId = mgr.announcePreparing({ input: INPUT, threadId: 'th-1' })
    expect(clientId).toMatch(/^pending-/)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({
      taskId: clientId,
      clientId,
      status: 'queued',
      threadId: 'th-1',
      prompt: INPUT.prompt,
      persistence: 'idle',
    })
    expect(mgr.get(clientId)).toBeUndefined() // 没有真实任务被登记
    mgr.dispose()
  })

  it('announceFailed 广播 failed 卡片并带错误信息', () => {
    const mgr = makeManager(makeClient([]))
    mgr.announceFailed({ clientId: 'pending-x', input: INPUT, threadId: 'th-1', error: 'boom' })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({
      taskId: 'pending-x',
      clientId: 'pending-x',
      status: 'failed',
      error: 'boom',
    })
    mgr.dispose()
  })

  it('submit 把 clientId 写进任务状态与每条广播', async () => {
    const mgr = makeManager(makeClient([{ id: 'task-1', status: 'running' }]))
    const state = await mgr.submit({ input: INPUT, content: [], threadId: 'th-1', clientId: 'pending-x' })
    expect(state.clientId).toBe('pending-x')
    expect(broadcasts[0]).toMatchObject({ taskId: 'task-1', clientId: 'pending-x', status: 'queued' })
    mgr.dispose()
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/services/seedance/__tests__/taskManager.test.ts`
Expected: FAIL —「mgr.announcePreparing is not a function」/「announceFailed is not a function」/ submit 不接受 clientId。

- [ ] **Step 3: 实现 —— 扩展 imports**

把 `taskManager.ts` 顶部的 import 块改为（新增 `node:crypto` 与 `SeedanceTaskStatus`）：

```typescript
import { randomUUID } from 'node:crypto'

import type { SeedanceClient } from './client'
import type {
  CreateVideoTaskInput,
  SeedanceCreateTaskBody,
  SeedanceContentItem,
  SeedanceModelAlias,
  SeedanceTaskState,
  SeedanceTaskStatus,
  SeedanceTaskUpdate,
} from './types'
import { SEEDANCE_MODEL_IDS } from './types'
```

- [ ] **Step 4: 实现 —— `SubmitParams` 加 clientId**

把 `SubmitParams` 接口改为：

```typescript
export interface SubmitParams {
  input: CreateVideoTaskInput
  /** 已解析好的 content[]（含参考素材 dataURL），由 main handler 组装。 */
  content: SeedanceContentItem[]
  threadId?: string
  /** generate_video 预备卡片的临时 id；真实任务广播会带上它做气泡对齐。 */
  clientId?: string
}
```

- [ ] **Step 5: 实现 —— submit 写入 clientId + 新增 baseUpdate / announcePreparing / announceFailed**

在 `submit` 内构造 `state` 处加入 `clientId`（其余不变）：

```typescript
    const { id } = await this.deps.client.createTask(body, apiKey)
    const state: SeedanceTaskState = {
      taskId: id,
      clientId: params.clientId,
      threadId,
      prompt: input.prompt,
      model,
      resolution,
      ratio,
      duration,
      status: 'queued',
      createdAt: this.now(),
      updatedAt: this.now(),
      persistence: 'idle',
    }
    this.tasks.set(id, state)
    this.deps.broadcast({ ...state })
    void this.pollLoop(id)
    return { ...state }
  }
```

紧接 `submit` 方法之后（`get()` 方法之前）新增：

```typescript
  /**
   * 拼装一条「合成广播」——用于真实任务存在之前的预备/失败卡片。taskId 直接复用
   * clientId（渲染端以 clientId 为气泡键，二者一致即可），不进 tasks Map、不轮询。
   */
  private baseUpdate(
    clientId: string,
    input: CreateVideoTaskInput,
    threadId: string | undefined,
    status: SeedanceTaskStatus,
  ): SeedanceTaskUpdate {
    const now = this.now()
    return {
      taskId: clientId,
      clientId,
      threadId,
      prompt: input.prompt,
      model: input.model ?? '2.0',
      resolution: input.resolution ?? '720p',
      ratio: input.ratio ?? '16:9',
      duration: input.duration ?? 5,
      status,
      createdAt: now,
      updatedAt: now,
      persistence: 'idle',
    }
  }

  /**
   * 在重活（buildContent / 素材库导入 / createTask）开始前立刻广播一张
   * 「准备中（queued）」卡片，并返回 clientId 供 submit 透传。这样无论前置上传
   * 多慢、批量并发多少条，用户都能瞬间看到每条任务的进度气泡。
   */
  announcePreparing(params: { input: CreateVideoTaskInput; threadId?: string }): string {
    const clientId = `pending-${randomUUID()}`
    this.deps.broadcast(this.baseUpdate(clientId, params.input, params.threadId, 'queued'))
    return clientId
  }

  /** 前置阶段（素材解析/导入/createTask）抛错时，把预备卡片落成 failed，避免永远转圈。 */
  announceFailed(params: {
    clientId: string
    input: CreateVideoTaskInput
    threadId?: string
    error: string
  }): void {
    this.deps.broadcast({
      ...this.baseUpdate(params.clientId, params.input, params.threadId, 'failed'),
      error: params.error,
    })
  }
```

- [ ] **Step 6: 运行测试确认通过（含原有用例无回归）**

Run: `npx vitest run src/main/services/seedance/__tests__/taskManager.test.ts`
Expected: PASS（新增 3 个 + 原有 12 个全绿）。

- [ ] **Step 7: Commit**

```bash
git add src/main/services/seedance/taskManager.ts src/main/services/seedance/__tests__/taskManager.test.ts
git commit -m "feat(seedance): announcePreparing/announceFailed + thread clientId through submit"
```

---

### Task 3: 渲染端以 clientId 为气泡身份（复用同一张卡片）

**Files:**
- Modify: `src/renderer/src/features/agent-chat/SeedanceTaskListener.ts:113-177`
- Test: `src/renderer/src/features/agent-chat/__tests__/seedanceTaskListener.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `seedanceTaskListener.test.ts` 的 `describe('seedance task-update → artifact bubble', ...)` 内追加：

```typescript
  it('预备卡片(clientId) 与随后的真实 taskId 复用同一张气泡（不重复建）', () => {
    const clientId = `pending-${taskSeq}`
    // 1) generate_video 在重活前广播：taskId === clientId
    handleSeedanceTaskUpdate(makeUpdate({ taskId: clientId, clientId, status: 'queued' }))
    // 2) submit 之后真实任务的广播：真实 taskId + 同一 clientId
    handleSeedanceTaskUpdate(makeUpdate({ taskId: 'real-1', clientId, status: 'queued' }))
    handleSeedanceTaskUpdate(
      makeUpdate({ taskId: 'real-1', clientId, status: 'running', createdAt: Date.now() - 5_000 }),
    )

    // 始终只有一张气泡
    expect(useAgentChatStore.getState().messages).toHaveLength(1)
    const item = lastArtifact()
    expect(item.status).toBe('generating')
    expect(item.progressText).toMatch(/正在生成视频 · \d+s/)
  })

  it('预备卡片(clientId) 在前置失败时落为 error（同一张气泡）', () => {
    const clientId = `pending-${taskSeq}-f`
    handleSeedanceTaskUpdate(makeUpdate({ taskId: clientId, clientId, status: 'queued' }))
    handleSeedanceTaskUpdate(
      makeUpdate({ taskId: clientId, clientId, status: 'failed', error: 'LOCAL_ASSET_IMPORT_FAILED: boom' }),
    )

    expect(useAgentChatStore.getState().messages).toHaveLength(1)
    const item = lastArtifact()
    expect(item.status).toBe('error')
    expect(item.error).toContain('LOCAL_ASSET_IMPORT_FAILED')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/seedanceTaskListener.test.ts`
Expected: FAIL —「预备卡片 + 真实 taskId」会建出 2 张气泡（`messages` 长度为 2），断言长度 1 失败。

- [ ] **Step 3: 实现 —— 用 `clientId ?? taskId` 作气泡键**

把 `handleSeedanceTaskUpdate` 开头改为：

```typescript
export function handleSeedanceTaskUpdate(update: SeedanceTaskUpdate): void {
  const chat = useAgentChatStore.getState()

  // 气泡身份优先用稳定的 clientId：generate_video 的「预备卡片」与之后真实
  // taskId 的广播带同一个 clientId，于是驱动同一张气泡（不重复建）；缺省回退 taskId。
  const key = update.clientId ?? update.taskId
  let task = tracked.get(key)
  if (!task) {
    const itemId = chat.beginImageGeneration(update.prompt, update.threadId, 'video')
    task = { itemId, threadId: update.threadId, historyRecorded: false }
    tracked.set(key, task)
  }
```

- [ ] **Step 4: 实现 —— 三处删除改用同一个 `key`**

把 `failed` 分支、`persistence: 'failed'` 分支、`persistence: 'done'` 分支里的 `tracked.delete(update.taskId)` 全部改为 `tracked.delete(key)`：

```typescript
    case 'failed':
      chat.failImageGeneration(task.itemId, update.error ?? '视频生成失败', task.threadId)
      tracked.delete(key)
      return
```

```typescript
        case 'failed':
          chat.annotateImageGeneration(task.itemId, { status: 'failed' }, task.threadId)
          tracked.delete(key)
          return
```

```typescript
          void persistHistory(update, task).finally(() => tracked.delete(key))
```

- [ ] **Step 5: 运行测试确认通过（含原有用例无回归）**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/seedanceTaskListener.test.ts`
Expected: PASS（新增 2 个 + 原有 8 个全绿；原用例不带 clientId，`key` 回退 taskId，行为不变）。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-chat/SeedanceTaskListener.ts src/renderer/src/features/agent-chat/__tests__/seedanceTaskListener.test.ts
git commit -m "feat(seedance): key chat bubble by clientId so preparing card reuses the same bubble"
```

---

### Task 4: generate_video 主处理器先出预备卡片，失败也可见

**Files:**
- Modify: `src/main/services/seedance/runtime.ts:265-270`

说明：这一步是把已被单测覆盖的原语（`announcePreparing` / `announceFailed` / `submit`）粘起来的 3 行胶水。`runtime.ts` 顶部 `import { ipcMain, net } from 'electron'` 使其难以在 Vitest（node 环境）单测，因此本任务**不新增单测**，由 `npm run typecheck` + 全量 seedance 套件无回归 + 手动冒烟验证。`clientId` 在 `announcePreparing` 内生成，无需 runtime 新增 import。

- [ ] **Step 1: 改写 `generate_video` 主处理器**

把：

```typescript
  router.registerMain('generate_video', async (params, threadId) => {
    const input = params as unknown as CreateVideoTaskInput
    const content = await buildContent(input)
    await importImagesToPortraitLibrary(content)
    return taskManager.submit({ input, content, threadId })
  })
```

改为：

```typescript
  router.registerMain('generate_video', async (params, threadId) => {
    const input = params as unknown as CreateVideoTaskInput
    // 关键：在任何 COS 中转 / 人像库导入 / createTask 之前，先广播一张「准备中」
    // 卡片。批量并发时每条任务都能瞬间出气泡，不再被前置大图上传压住（根因修复）。
    const clientId = taskManager.announcePreparing({ input, threadId })
    try {
      const content = await buildContent(input)
      await importImagesToPortraitLibrary(content)
      return await taskManager.submit({ input, content, threadId, clientId })
    } catch (e) {
      // 前置阶段（素材解析/导入/createTask，如 LOCAL_ASSET_IMPORT_FAILED）抛错时，
      // 把预备卡片落成 failed，避免气泡永远转圈；随后照旧把错误抛给工具层出横幅。
      taskManager.announceFailed({
        clientId,
        input,
        threadId,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  })
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS（无新增错误）。

- [ ] **Step 3: 全量 seedance + 视频套件无回归**

Run: `npx vitest run src/main/services/seedance src/renderer/src/features/agent-chat/__tests__/seedanceTaskListener.test.ts`
Expected: PASS（taskManager + listener + client + assets 全绿）。

- [ ] **Step 4: lint 改动文件**

Run: `npx eslint src/types/seedance.ts src/main/services/seedance/taskManager.ts src/main/services/seedance/runtime.ts src/renderer/src/features/agent-chat/SeedanceTaskListener.ts`
Expected: 0 新增告警。

- [ ] **Step 5: 手动冒烟（dev 跑应用）**

Run: `npm run dev:vite`
验证：在 Agent 里一次性让模型批量提交 3+ 条 `generate_video`（全能参考 + 大图）。Expected：每条调用触发瞬间，聊天里**立刻**出现「正在生成视频 · 排队中」卡片（不再是一堆 running 工具无卡片）；若某条参考图尺寸超限，对应卡片落为 error（而非永久转圈）。

- [ ] **Step 6: Commit**

```bash
git add src/main/services/seedance/runtime.ts
git commit -m "fix(seedance): emit progress card before pre-submit uploads so batch video shows in-progress bubbles"
```

---

## Follow-ups / 明确不在本计划范围

- **越界图「真·提前校验/自动缩放」**：本计划已让上游 `LOCAL_ASSET_IMPORT_FAILED`（如「Width must be between 300px and 6000px」）显示在实时卡片上（Task 4 的 `announceFailed`），但**未**在提交前解码图片尺寸做拦截/缩放。要做到「提交前就提示尺寸超限」需引入图片尺寸读取（image-size/sharp）并决定是拒绝还是自动缩放——属独立子系统，建议单独立计划。
- **前置上传并发上限**：批量并发时 N 条任务 × 多张大图同时打 COS 仍会拖慢整体（卡片已先出，体验可接受）。如需进一步稳，可给 `resolveMediaUrl` / `importImagesToPortraitLibrary` 的上传加并发闸（如 p-limit），属优化非缺陷修复。

## Self-Review

- **Spec coverage**：用户诉求「批量提交看不到进行中卡片」→ Task 1–4（预备卡片即时广播 + 渲染端 clientId 对齐）直接覆盖；「越界图提示」→ Task 4 让失败上卡片，深度校验列入 Follow-ups 并说明理由。✓
- **Placeholder scan**：所有代码步骤均为完整可粘贴代码，无 TODO/“类似上文”。✓
- **Type consistency**：`clientId`（Task 1 定义）→ `SubmitParams.clientId` / `state.clientId` / `baseUpdate`/`announcePreparing`/`announceFailed`（Task 2）→ `update.clientId`（Task 3）命名一致；`announcePreparing` 返回 `string`（clientId），Task 4 直接接收使用，一致。✓
- **测试键值**：listener 测试用 `taskId === clientId` 模拟预备广播、`taskId='real-1' + 同 clientId` 模拟真实广播；原有用例不带 clientId、`key` 回退 taskId，零回归。✓
