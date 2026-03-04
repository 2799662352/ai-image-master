# Director Pipeline — Cancel / Pause / Resume 设计文档

**Date:** 2026-03-04
**Status:** Approved (Brainstorming Option C)
**Problem:** 导演模式管线一旦启动不可中断。用户在长时间生成过程（30s–2min）中无法取消或暂停，已完成的中间结果（场景分析、角色锚点）在取消后丢失。

---

## 1. Problem Analysis

### 1.1 Current Flow

```
用户点击"一键生成" → execute() → graph.stream() →
  selectSkills → analyzeScene ∥ extractCharacterAnchors →
  validateAnalysis → designAndAssemble → verifyConsistency → generateImages →
返回结果
```

整个流程是不可中断的 `for await` 循环。无 `AbortController`、无 `signal` 传递、无暂停机制。

### 1.2 Impact

| 场景 | 影响 |
|------|------|
| LLM 卡顿 / 超时 | 用户只能等待 120s timeout |
| 发现参数错误 | 必须等全部完成后重来 |
| 生成不满意想重试 | 等待 + 已完成的场景分析被丢弃 |
| 多场景模式 | 循环中无法中止后续场景 |

---

## 2. Design — Option C: Cancel + Pause / Resume

### 2.1 Architecture

两套机制协同工作：

```
┌──────────────────────────────────────────────────────────┐
│                     AbortController                       │
│  ┌─────────┐    signal    ┌──────────┐    signal         │
│  │  Hook   │ ───────────→ │ Pipeline │ ──────────→ LLM   │
│  │         │              │ execute()│ ──────────→ fetch  │
│  └────┬────┘              └────┬─────┘                   │
│       │ pause()                │ interrupt()              │
│       ▼                        ▼                          │
│  ┌─────────┐              ┌──────────┐                   │
│  │pauseFlag│ ────────────→│MemorySaver│ (checkpoint)     │
│  └─────────┘   checked    └──────────┘                   │
│                at each                                    │
│                node entry                                 │
└──────────────────────────────────────────────────────────┘
```

**Cancel** — `AbortController.abort()` → signal 传播到 `graph.stream()`、LLM `invoke()`、`fetch()` → 全部中止 → 保留已完成阶段数据

**Pause** — 设置 `_pauseRequested` 标志 → 下一个节点入口检测到 → 调用 LangGraph `interrupt()` → MemorySaver 保存检查点 → stream 终止并返回 `paused: true`

**Resume** — 调用 `pipeline.resume()` → `graph.stream(new Command({ resume: true }), config)` → 从中断节点恢复执行

### 2.2 State Machine

```
                       startGeneration()
                 ┌──────────────────────────┐
                 │                          ▼
              ┌──────┐  ──────────────→ ┌─────────┐
              │ idle │                  │ running │
              └──────┘  ←──────────── └────┬────┘
                 ▲    complete/error       │
                 │                    pause│      cancel
                 │                         ▼        │
                 │                   ┌──────────┐   │
                 │  cancel/complete  │  paused  │   │
                 └───────────────────┴──────────┘   │
                 ▲                     │ resume      │
                 │                     ▼             │
                 │               ┌─────────┐        │
                 └───────────────│ running │ ◄──────┘
                   complete      └─────────┘
```

Store 字段: `generationStatus: 'idle' | 'running' | 'paused'`

### 2.3 Signal 传播路径

```
AbortController.signal
  ├→ graph.stream(input, { signal, configurable: { thread_id } })
  │     └→ 每个节点的 config.signal (LangGraph 自动传递)
  │          ├→ llm.invoke(messages, { signal: config.signal })
  │          │     └→ 底层 HTTP 请求被中止
  │          └→ apiService.generateImage({ ..., signal: config.signal })
  │                └→ fetch(url, { signal }) 被中止
  └→ runWithConcurrency: 每个 task 之间检查 signal.aborted
```

### 2.4 Pause 检查点

每个主要节点在入口检查 `self._pauseRequested`：

```typescript
const analyzeSceneFn = async (state, config) => {
  if (self._pauseRequested) {
    writer(config)?.({ type: 'paused', node: 'analyzeScene' })
    interrupt({ reason: 'user_pause', node: 'analyzeScene' })
  }
  // ... 正常逻辑 ...
}
```

暂停语义：**完成当前正在执行的节点，在下一个节点入口暂停**。用户点击暂停后，UI 显示"暂停中..."直到当前节点完成。

### 2.5 Resume 流程

```typescript
async resume(onProgress, options) {
  this._pauseRequested = false
  const config = {
    signal: options?.signal,
    configurable: { thread_id: this._currentThreadId },
    streamMode: ['updates', 'custom'],
  }
  const stream = await this._graph.stream(
    new Command({ resume: true }),
    config
  )
  // ... 与 execute() 相同的事件处理 ...
}
```

LangGraph 自动恢复中断的节点，已完成的节点不会重新执行。

### 2.6 内存管理

`MemorySaver` 在内存中存储检查点。每次新的 `execute()` (非 resume) 创建新的 MemorySaver 并重新编译图，避免旧检查点堆积。

---

## 3. Research References

### 3.1 LangGraph Official Docs (via Context7)

- `interrupt()` + `Command({ resume })` — 人机交互暂停/恢复模式
- `MemorySaver` — 内存检查点存储
- `graph.stream(input, { signal })` — AbortSignal 支持
- RunnableConfig 传播 — signal 自动传递到子节点

### 3.2 LangChain JS (via Context7)

- `ChatOpenAI.invoke(messages, { signal })` — 支持 AbortSignal
- `RunnableConfig.signal` — 标准信号传递接口

### 3.3 HuggingFace Papers — 人物一致性

| Paper | 核心思路 | 与本项目的关联 |
|-------|---------|---------------|
| IP-Adapter (2308.06721) | 解耦跨注意力机制，图像提示适配器 | 参考图身份保持的理论基础 |
| The Chosen One (2311.10093) | 迭代筛选一致角色 | 可启发多轮验证策略 |
| Character-Adapter (2406.16537) | 区域级适配器，提示引导分割 | 角色锚点提取的理论支撑 |
| ConsiStyle (2505.20626) | 免训练注意力操控保持一致性 | 已在 style-anchor-consistency 设计中引用 |
| WithAnyone (2510.14975) | 对比身份损失，平衡保真与变化 | 验证阶段可参考的评分维度 |
| IDAdapter (2403.13535) | 混合特征注入 | 提示工程中的身份描述优化 |

> 上述论文主要涉及模型架构层面的改进，本项目通过外部 API 调用生图，因此在 prompt 工程层面借鉴其原理。Cancel/Pause/Resume 功能与一致性改进正交，可独立实施。

---

## 4. Changes Summary

| 层级 | 文件 | 改动 |
|------|------|------|
| Utility | `PipelineController.ts` (new) | Cancel/Pause 协调器 |
| Store | `useDirectorStore.ts` | `generationStatus` 状态机 |
| Pipeline | `DirectorPipeline.ts` | MemorySaver + signal + interrupt + resume() |
| Pipeline | `BasePipeline.ts` | createLLM 支持 signal |
| API | `ApiService.ts` | fetch 支持 signal |
| Hook | `useDirectorGeneration.ts` | cancel/pause/resume 暴露 |
| UI | `GenerateButton.tsx` | 上下文按钮 |
| UI | `GenerationProgress.tsx` | 暂停状态显示 |

---

## 5. Error Handling

| 场景 | 行为 |
|------|------|
| Cancel 时 LLM 正在请求 | `AbortError` 被捕获，不显示错误提示 |
| Cancel 时图片正在生成 | fetch 中止，已生成的图片保留 |
| Pause 时节点正在执行 | 当前节点完成后暂停，不浪费已完成的工作 |
| Resume 后网络断开 | 正常错误处理流程 |
| 多场景模式 Cancel | 当前场景中止，已完成场景结果保留 |

---

## 6. Scope

**In scope:**
- Cancel: AbortController + signal propagation
- Pause: interrupt() + MemorySaver checkpoint
- Resume: Command({ resume }) + checkpoint restore
- UI: 上下文按钮 (生成中/暂停中/已暂停)

**Not in scope (future):**
- 跨 session 持久化暂停（关闭应用后恢复）
- 单节点内部的细粒度暂停（mid-LLM-call pause）
- 模型架构级别的一致性改进（IP-Adapter 等）
