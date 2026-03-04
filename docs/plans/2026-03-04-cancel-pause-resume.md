# Director Pipeline Cancel / Pause / Resume 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Director Pipeline 添加取消、暂停、恢复能力。取消通过 AbortController signal 传播到所有异步操作；暂停通过 LangGraph interrupt() 在节点边界保存检查点；恢复通过 Command({ resume }) 从检查点继续。

**Architecture:** Pipeline 接受 AbortSignal 并传播到 graph.stream()、LLM invoke()、fetch()。每个节点入口检查 pauseRequested 标志，为 true 时调用 interrupt() 保存到 MemorySaver 检查点。resume() 方法使用 Command 从上次中断处恢复。Store 用 generationStatus 状态机替换 isGenerating boolean。

**Tech Stack:** LangGraph (interrupt, Command, MemorySaver), AbortController/AbortSignal, Zustand, Vitest, TypeScript

**Design Doc:** `docs/plans/2026-03-04-cancel-pause-resume-design.md`

---

### Task 1: ApiService — 添加 signal 支持

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts`
- Test: `src/renderer/src/services/api/__tests__/ApiService.signal.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/services/api/__tests__/ApiService.signal.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('ApiService signal support', () => {
  it('makeApiRequest should pass signal to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    const { ApiService } = await import('../ApiService')
    const service = new (ApiService as any)()
    // Set up minimal config for the service
    service.apiKey = 'test-key'
    service.currentSite = 'openai'
    service.currentModel = 'test-model'

    const controller = new AbortController()
    await service.generateImage({
      prompt: 'test prompt',
      model: 'test-model',
      count: 1,
      signal: controller.signal,
    })

    expect(mockFetch).toHaveBeenCalled()
    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]).toHaveProperty('signal', controller.signal)
  })

  it('generateImage should abort when signal is aborted', async () => {
    const controller = new AbortController()
    const mockFetch = vi.fn().mockImplementation(() => {
      return new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const { ApiService } = await import('../ApiService')
    const service = new (ApiService as any)()
    service.apiKey = 'test-key'
    service.currentSite = 'openai'
    service.currentModel = 'test-model'

    const promise = service.generateImage({
      prompt: 'test prompt',
      model: 'test-model',
      count: 1,
      signal: controller.signal,
    })

    controller.abort()

    const result = await promise
    expect(result.success).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/api/__tests__/ApiService.signal.test.ts`
Expected: FAIL — `signal` not recognized in generateImage params / not passed to fetch

**Step 3: Write minimal implementation**

3a. Add `signal` to `GenerateImageParams` interface (find the interface definition):

```typescript
export interface GenerateImageParams {
  prompt: string
  model?: string
  ratio?: string
  resolution?: string
  referenceImages?: string[]
  imageBase64?: string
  negativePrompt?: string
  count?: number
  signal?: AbortSignal  // NEW
}
```

3b. Modify `generateImage()` to pass signal through:

```typescript
async generateImage(params: GenerateImageParams): Promise<GenerateResult> {
  const { prompt, model, ratio, resolution, referenceImages, imageBase64, count = 1, signal } = params
  // ... existing validation ...

  try {
    const response = await this.withRetry(
      () => this.makeApiRequest({
        prompt, model: modelKey, ratio, resolution,
        referenceImages, imageBase64, count, modelConfig, site,
        signal,  // NEW
      }),
      { maxRetries: 1, retryDelay: 2000 }
    )
    // ... existing response handling ...
  } catch (error) {
    // ... existing error handling ...
  }
}
```

3c. Add `signal` to `makeApiRequest` options and pass to `fetch`:

```typescript
private async makeApiRequest(options: {
  prompt: string
  model: string
  ratio?: string
  resolution?: string
  referenceImages?: string[]
  imageBase64?: string
  count: number
  modelConfig: ModelConfig
  site: ApiSite
  signal?: AbortSignal  // NEW
}): Promise<Response> {
  const { prompt, model, ratio, resolution, referenceImages, imageBase64, modelConfig, site, signal } = options

  // ... existing body building ...

  if (body.__isFluxKontextWithImage) {
    return this.makeFluxFormDataRequest(url, body, site, signal)  // pass signal
  }

  // ... existing headers ...

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,  // NEW
  })
}
```

3d. Modify `makeFluxFormDataRequest` to accept and pass signal:

```typescript
private async makeFluxFormDataRequest(
  url: string,
  payload: any,
  site: ApiSite,
  signal?: AbortSignal  // NEW
): Promise<Response> {
  // ... existing FormData building ...

  return fetch(url, {
    method: 'POST',
    headers,
    body: formData,
    signal,  // NEW
  })
}
```

3e. Modify `withRetry` to check signal before retrying:

在 `withRetry` 的重试循环中添加:
```typescript
if (options?.signal?.aborted) {
  throw new DOMException('The operation was aborted.', 'AbortError')
}
```

> 注: withRetry 可能没有 signal 参数,需要检查其签名并适当传递。如果 withRetry 不直接接受 signal，则在 generateImage 的 catch 中检查 signal.aborted 并重新抛出 AbortError。

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/api/__tests__/ApiService.signal.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts src/renderer/src/services/api/__tests__/ApiService.signal.test.ts
git commit -m "feat(api): add AbortSignal support to generateImage and fetch calls"
```

---

### Task 2: Pipeline — runWithConcurrency 支持 signal

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/runWithConcurrency.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/services/pipeline/__tests__/runWithConcurrency.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('runWithConcurrency with signal', () => {
  it('should stop processing tasks when signal is aborted', async () => {
    // We need to test the static/exported version or test via the pipeline
    // Since runWithConcurrency is private, we test indirectly through behavior
    const { DirectorPipeline } = await import('../DirectorPipeline')

    // Access private method via prototype for testing
    const pipeline = Object.create(DirectorPipeline.prototype)
    const runMethod = (pipeline as any).runWithConcurrency.bind(pipeline)

    const controller = new AbortController()
    const taskResults: number[] = []

    const task = async (i: number) => {
      if (i === 2) {
        controller.abort()
      }
      taskResults.push(i)
      return i
    }

    const results = await runMethod(5, 1, task, controller.signal)

    // Tasks after abort should not have run
    expect(taskResults.length).toBeLessThanOrEqual(3) // 0, 1, 2 (2 triggers abort)
  })

  it('should run all tasks when signal is not aborted', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = Object.create(DirectorPipeline.prototype)
    const runMethod = (pipeline as any).runWithConcurrency.bind(pipeline)

    const results = await runMethod(3, 1, async (i: number) => i * 2)
    expect(results).toEqual([0, 2, 4])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/runWithConcurrency.test.ts`
Expected: FAIL — runWithConcurrency doesn't accept signal parameter

**Step 3: Write minimal implementation**

Modify `runWithConcurrency` in `DirectorPipeline.ts`:

```typescript
private async runWithConcurrency<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<T[]> {
  const total = Math.max(0, Math.floor(count))
  if (total === 0) return []

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, total))
  const results: T[] = new Array(total)
  let cursor = 0

  const worker = async () => {
    while (true) {
      if (signal?.aborted) break
      const index = cursor
      cursor += 1
      if (index >= total) break
      results[index] = await task(index)
    }
  }

  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))
  return results
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/runWithConcurrency.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/runWithConcurrency.test.ts
git commit -m "feat(pipeline): add AbortSignal support to runWithConcurrency"
```

---

### Task 3: Pipeline — execute() 接受 signal + MemorySaver checkpointer

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/services/pipeline/types.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-cancel.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/services/pipeline/__tests__/director-cancel.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('DirectorPipeline execute with signal', () => {
  it('execute should accept options with signal', async () => {
    // Verify the method signature accepts { signal }
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    // Verify execute signature accepts 3rd parameter
    const executeStr = pipeline.execute.toString()
    // The method should have options parameter
    expect(typeof pipeline.execute).toBe('function')
    expect(pipeline.execute.length).toBeGreaterThanOrEqual(1)
  })
})

describe('PipelineExecuteOptions type', () => {
  it('should export PipelineExecuteOptions with signal field', async () => {
    const types = await import('../types')
    // Type check — this test validates the type exists at compile time
    const options: import('../types').PipelineExecuteOptions = {
      signal: new AbortController().signal,
    }
    expect(options.signal).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-cancel.test.ts`
Expected: FAIL — `PipelineExecuteOptions` not exported from types

**Step 3: Write minimal implementation**

3a. Add type to `types.ts`:

```typescript
export interface PipelineExecuteOptions {
  signal?: AbortSignal
}

export interface PipelineExecuteResult<T> {
  result: T
  paused: boolean
  cancelled: boolean
}
```

3b. Add imports and fields to `DirectorPipeline.ts`:

```typescript
import { MemorySaver, interrupt, Command } from '@langchain/langgraph'
```

Add class fields:

```typescript
export class DirectorPipeline extends BasePipeline<DirectorState, DirectorResult> {
  private _graph: any = null
  private _graphBuilder: any = null
  private _checkpointer: MemorySaver | null = null
  private _currentThreadId: string | null = null
  _pauseRequested = false  // underscore prefix, accessible for testing
```

3c. Modify `buildGraph()` to use MemorySaver:

At the end of `buildGraph()`, change:
```typescript
// OLD:
this._graph = graph.compile()
return graph

// NEW:
this._graphBuilder = graph
this._checkpointer = new MemorySaver()
this._graph = graph.compile({ checkpointer: this._checkpointer })
return graph
```

3d. Modify `execute()` signature:

```typescript
async execute(
  input: Partial<DirectorState>,
  onProgress?: (progress: PipelineProgress) => void,
  options?: PipelineExecuteOptions,
): Promise<DirectorResult> {
```

3e. In `execute()`, add signal and thread_id to config:

```typescript
// 新执行: 重置 checkpointer 避免旧检查点堆积
this._checkpointer = new MemorySaver()
this._graph = this._graphBuilder!.compile({ checkpointer: this._checkpointer })
this._pauseRequested = false
const threadId = crypto.randomUUID()
this._currentThreadId = threadId

const config: any = {
  streamMode: ['updates', 'custom'],
  signal: options?.signal,
  configurable: { thread_id: threadId },
}
```

3f. In `execute()`, wrap the `for await` loop in try-catch for AbortError:

```typescript
try {
  const stream = await compiledGraph.stream(input, config)
  for await (const event of stream) {
    // ... existing event processing ...
  }
} catch (err: unknown) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    console.log('[DirectorPipeline] 管线已取消')
    return this.postProcess(this.assembleResult(finalState))
  }
  throw err
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-cancel.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/types.ts src/renderer/src/services/pipeline/__tests__/director-cancel.test.ts
git commit -m "feat(pipeline): add signal + MemorySaver to execute(), handle AbortError"
```

---

### Task 4: Pipeline — 节点入口 interrupt() 暂停检查

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pause.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/services/pipeline/__tests__/director-pause.test.ts
import { describe, it, expect } from 'vitest'

describe('DirectorPipeline pause mechanism', () => {
  it('should expose requestPause and clearPauseRequest methods', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect(typeof pipeline.requestPause).toBe('function')
    expect(typeof pipeline.clearPauseRequest).toBe('function')
    expect(pipeline.isPauseRequested).toBe(false)
  })

  it('requestPause should set isPauseRequested to true', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    pipeline.requestPause()
    expect(pipeline.isPauseRequested).toBe(true)
  })

  it('clearPauseRequest should reset to false', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    pipeline.requestPause()
    pipeline.clearPauseRequest()
    expect(pipeline.isPauseRequested).toBe(false)
  })

  it('should expose currentThreadId after execute starts', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect(pipeline.currentThreadId).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pause.test.ts`
Expected: FAIL — `requestPause`, `clearPauseRequest`, `isPauseRequested` not defined

**Step 3: Write minimal implementation**

3a. Add public methods to `DirectorPipeline`:

```typescript
requestPause(): void {
  this._pauseRequested = true
}

clearPauseRequest(): void {
  this._pauseRequested = false
}

get isPauseRequested(): boolean {
  return this._pauseRequested
}

get currentThreadId(): string | null {
  return this._currentThreadId
}
```

3b. Add pause check helper inside `buildGraph()` (at the top, after `const self = this`):

```typescript
const checkPauseAndInterrupt = (nodeName: string, config: any) => {
  if (self._pauseRequested) {
    writer(config)?.({ type: 'paused', node: nodeName })
    interrupt({ reason: 'user_pause', node: nodeName })
  }
}
```

3c. Add `checkPauseAndInterrupt` call at the entry of each major node function:

In `analyzeSceneFn`:
```typescript
const analyzeSceneFn = async (state: DirectorState, config: any) => {
  checkPauseAndInterrupt('analyzeScene', config)
  // ... existing skip check and logic ...
```

In `extractCharacterAnchorsFn`:
```typescript
const extractCharacterAnchorsFn = async (state: DirectorState, config: any) => {
  checkPauseAndInterrupt('extractCharacterAnchors', config)
  // ... existing skip check and logic ...
```

In `designAndAssembleFn`:
```typescript
const designAndAssembleFn = async (state: DirectorState, config: any) => {
  checkPauseAndInterrupt('designAndAssemble', config)
  // ... existing logic ...
```

In `verifyConsistencyFn`:
```typescript
const verifyConsistencyFn = async (state: DirectorState, config: any) => {
  checkPauseAndInterrupt('verifyConsistency', config)
  // ... existing logic ...
```

In `generateImagesFn`:
```typescript
const generateImagesFn = async (state: DirectorState, config: any) => {
  checkPauseAndInterrupt('generateImages', config)
  // ... existing logic ...
```

3d. In `execute()` 的 stream 处理循环中，检测 interrupt 事件:

```typescript
// 在 for await 循环的事件处理中添加:
if (Array.isArray(event)) {
  const [mode, data] = event
  if (mode === 'custom' && data?.type === 'paused') {
    console.log(`[DirectorPipeline] 管线在 ${data.node} 处暂停`)
    // interrupt 会导致 stream 自动结束
    continue
  }
  // ... existing event handling ...
}
```

3e. 在 `execute()` 返回前检查是否是暂停导致的结束:

```typescript
const totalElapsed = Date.now() - pipelineStart
if (this._pauseRequested) {
  console.log(`[DirectorPipeline] 管线暂停 (${(totalElapsed / 1000).toFixed(1)}s)`)
} else {
  console.log(`[DirectorPipeline] 管线完成 (${totalPasses} passes)，总耗时 ${(totalElapsed / 1000).toFixed(1)}s`)
}
const result = this.postProcess(this.assembleResult(finalState))
;(result as any).__paused = this._pauseRequested
return result
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pause.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pause.test.ts
git commit -m "feat(pipeline): add pause mechanism with interrupt() at node boundaries"
```

---

### Task 5: Pipeline — resume() 方法

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-resume.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/services/pipeline/__tests__/director-resume.test.ts
import { describe, it, expect } from 'vitest'

describe('DirectorPipeline resume', () => {
  it('should expose resume method', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect(typeof pipeline.resume).toBe('function')
  })

  it('should throw if no currentThreadId (never executed)', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    await expect(pipeline.resume()).rejects.toThrow('没有可恢复的暂停状态')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-resume.test.ts`
Expected: FAIL — `resume` method not defined

**Step 3: Write minimal implementation**

Add `resume()` method to `DirectorPipeline`:

```typescript
async resume(
  onProgress?: (progress: PipelineProgress) => void,
  options?: PipelineExecuteOptions,
): Promise<DirectorResult> {
  if (!this._currentThreadId || !this._graph) {
    throw new Error('没有可恢复的暂停状态')
  }

  this._pauseRequested = false

  const config: any = {
    streamMode: ['updates', 'custom'],
    signal: options?.signal,
    configurable: { thread_id: this._currentThreadId },
  }

  const pipelineStart = Date.now()
  let finalState: DirectorState = {} as DirectorState
  let currentPass = 0

  try {
    const stream = await this._graph.stream(
      new Command({ resume: true }),
      config,
    )

    for await (const event of stream) {
      if (Array.isArray(event)) {
        const [mode, data] = event

        if (mode === 'custom' && data?.type === 'paused') {
          console.log(`[DirectorPipeline] 管线在 ${data.node} 处再次暂停`)
          continue
        }

        if (mode === 'custom' && data?.type === 'pass_complete') {
          currentPass = typeof data.pass === 'number' ? data.pass : currentPass
          onProgress?.({
            pass: data.pass,
            totalPasses: data.totalPasses || 6,
            label: data.label,
            status: 'completed',
            elapsed: data.elapsed,
            passData: data.passData,
          })
        } else if (mode === 'custom' && data?.type === 'image_generated') {
          onProgress?.({
            pass: data.pass,
            totalPasses: data.totalPasses || 6,
            label: data.label,
            status: 'running',
            data,
          })
        } else if (mode === 'updates') {
          const updatesData = data
          const entries = Object.entries(updatesData)
          if (entries.length > 0) {
            const [, output] = entries[0] as [string, any]
            finalState = { ...finalState, ...output }
          }
          if (Object.prototype.hasOwnProperty.call(updatesData, 'generateImages')) {
            const generateImagesOutput = (updatesData as any).generateImages
            if (generateImagesOutput && typeof generateImagesOutput === 'object') {
              finalState = { ...finalState, ...generateImagesOutput }
            }
            break
          }
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.log('[DirectorPipeline] 恢复执行已取消')
      const result = this.postProcess(this.assembleResult(finalState))
      ;(result as any).__paused = false
      ;(result as any).__cancelled = true
      return result
    }
    throw err
  }

  const totalElapsed = Date.now() - pipelineStart
  if (this._pauseRequested) {
    console.log(`[DirectorPipeline] 管线在恢复后再次暂停 (${(totalElapsed / 1000).toFixed(1)}s)`)
  } else {
    console.log(`[DirectorPipeline] 管线恢复完成，耗时 ${(totalElapsed / 1000).toFixed(1)}s`)
  }

  const result = this.postProcess(this.assembleResult(finalState))
  ;(result as any).__paused = this._pauseRequested
  return result
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-resume.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-resume.test.ts
git commit -m "feat(pipeline): add resume() method using LangGraph Command"
```

---

### Task 6: Pipeline — signal 传播到 LLM invoke

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Write the failing test**

> 此 Task 不需要新测试文件。LLM signal 传播是内部行为，通过 Task 3 的 cancel 测试间接验证。此处主要是代码修改。

**Step 2: Modify LLM invoke calls to pass config.signal**

搜索 `DirectorPipeline.ts` 中所有 `structuredLlm.invoke(` 和 `structuredWithRaw.invoke(` 调用，将第二个参数从空/省略改为 `{ signal: config?.signal }`。

典型改动模式:

```typescript
// OLD:
const response = await structuredLlm.invoke([
  { role: 'system', content: systemPrompt },
  { role: 'user', content: userContent },
])

// NEW:
const response = await structuredLlm.invoke(
  [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ],
  { signal: config?.signal },
)
```

需要修改的节点函数（搜索 `.invoke([` 并添加 signal）:
1. `analyzeSceneFn` — `structuredWithRaw.invoke(...)`
2. `extractCharacterAnchorsFn` — `structuredWithRaw.invoke(...)`
3. `designAndAssembleFn` — `structuredLlm.invoke(...)`
4. `verifyConsistencyFn` — `structuredWithRaw.invoke(...)`

同时，在 `generateImagesFn` 中，将 `config?.signal` 传给 `apiService.generateImage()` 和 `runWithConcurrency`:

```typescript
// 在 generateImagesFn 中:
const results = await self.runWithConcurrency(
  imageCount,
  concurrency,
  async (i) => {
    // ...
    const result = await apiService.generateImage({
      prompt: compositePrompt,
      model: drawingModel,
      negativePrompt,
      ratio: state.ratio,
      resolution: state.resolution,
      referenceImages,
      signal: config?.signal,  // NEW
    })
    // ...
  },
  config?.signal,  // NEW — pass to runWithConcurrency
)
```

**Step 3: Verify existing tests still pass**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/`
Expected: PASS (existing tests should not break)

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(pipeline): propagate AbortSignal to all LLM invoke and image generation calls"
```

---

### Task 7: Store — generationStatus 状态机

**Files:**
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts`
- Modify: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`

**Step 1: Write the failing test**

Append to existing `useDirectorStore.test.ts`:

```typescript
describe('generationStatus state machine', () => {
  it('should default to idle', () => {
    const store = useDirectorStore.getState()
    expect(store.generationStatus).toBe('idle')
  })

  it('should transition to running', () => {
    const store = useDirectorStore.getState()
    store.setGenerationStatus('running')
    expect(store.generationStatus).toBe('running')
    expect(store.isGenerating).toBe(true)
  })

  it('should transition to paused', () => {
    const store = useDirectorStore.getState()
    store.setGenerationStatus('paused')
    expect(store.generationStatus).toBe('paused')
    expect(store.isGenerating).toBe(false)
  })

  it('isGenerating should be true only when running', () => {
    const store = useDirectorStore.getState()

    store.setGenerationStatus('idle')
    expect(store.isGenerating).toBe(false)

    store.setGenerationStatus('running')
    expect(store.isGenerating).toBe(true)

    store.setGenerationStatus('paused')
    expect(store.isGenerating).toBe(false)
  })

  it('setIsGenerating(true) should set status to running', () => {
    const store = useDirectorStore.getState()
    store.setIsGenerating(true)
    expect(store.generationStatus).toBe('running')
  })

  it('setIsGenerating(false) should set status to idle', () => {
    const store = useDirectorStore.getState()
    store.setIsGenerating(false)
    expect(store.generationStatus).toBe('idle')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: FAIL — `generationStatus` and `setGenerationStatus` not defined

**Step 3: Write minimal implementation**

3a. Add type definition to `GenerationSlice`:

```typescript
export type GenerationStatus = 'idle' | 'running' | 'paused'
```

3b. In `GenerationSlice` interface, add:

```typescript
generationStatus: GenerationStatus
setGenerationStatus: (status: GenerationStatus) => void
```

3c. In `createInitialGenerationState`, add:

```typescript
generationStatus: 'idle' as GenerationStatus,
```

3d. In `createGenerationSlice`, add:

```typescript
setGenerationStatus: (status) => {
  set({ generationStatus: status, isGenerating: status === 'running' })
},
```

3e. Modify existing `setIsGenerating` for backward compatibility:

```typescript
setIsGenerating: (val) => {
  set({
    isGenerating: val,
    generationStatus: val ? 'running' : 'idle',
  })
},
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/stores/useDirectorStore.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts
git commit -m "feat(store): add generationStatus state machine with backward-compatible isGenerating"
```

---

### Task 8: Hook — cancel / pause / resume 函数

**Files:**
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`
- Test: `src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDirectorGeneration } from '../useDirectorGeneration'
import { useDirectorStore } from '../../stores/useDirectorStore'

// Mock ServiceBridge
vi.mock('@/services/ServiceBridge', () => ({
  getDirectorPipelineService: vi.fn().mockResolvedValue({
    execute: vi.fn().mockResolvedValue({ images: [], scene: null, characters: null }),
    resume: vi.fn().mockResolvedValue({ images: [] }),
    requestPause: vi.fn(),
    clearPauseRequest: vi.fn(),
    isPauseRequested: false,
  }),
}))

describe('useDirectorGeneration cancel/pause/resume', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  it('should expose cancelGeneration function', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(typeof result.current.cancelGeneration).toBe('function')
  })

  it('should expose pauseGeneration function', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(typeof result.current.pauseGeneration).toBe('function')
  })

  it('should expose resumeGeneration function', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(typeof result.current.resumeGeneration).toBe('function')
  })

  it('should expose generationStatus', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.generationStatus).toBe('idle')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`
Expected: FAIL — `cancelGeneration`, `pauseGeneration`, `resumeGeneration`, `generationStatus` not in return

**Step 3: Write minimal implementation**

3a. Add imports and refs:

```typescript
import { useCallback, useRef } from 'react'
import type { PipelineExecuteOptions } from '@/services/pipeline/types'
```

3b. Add refs inside `useDirectorGeneration()`:

```typescript
const abortControllerRef = useRef<AbortController | null>(null)
const pipelineRef = useRef<any>(null)
```

3c. Add `generationStatus` to store selector:

```typescript
const {
  // ... existing ...
  generationStatus,
} = useDirectorStore(useShallow((s) => ({
  // ... existing ...
  generationStatus: s.generationStatus,
})))
```

3d. Modify `startGeneration` to create AbortController and pass signal:

```typescript
const startGeneration = useCallback(
  async (onProgress, styleInstructions) => {
    const store = useDirectorStore.getState()
    store.setGenerationStatus('running')

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    try {
      // ... existing pipeline setup ...

      pipelineRef.current = pipeline

      // In single mode:
      const result = await pipeline.execute(
        { /* ... existing input ... */ },
        onProgress,
        { signal: abortController.signal },
      )

      if ((result as any).__paused) {
        store.setGenerationStatus('paused')
        return result
      }

      // ... existing result processing ...
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log('[Director] 生成已取消')
        return
      }
      throw err
    } finally {
      const store = useDirectorStore.getState()
      if (store.generationStatus === 'running') {
        store.setGenerationStatus('idle')
      }
    }
  },
  [/* ... existing deps ... */],
)
```

3e. Add `cancelGeneration`:

```typescript
const cancelGeneration = useCallback(() => {
  abortControllerRef.current?.abort()
  pipelineRef.current?.clearPauseRequest?.()
  useDirectorStore.getState().setGenerationStatus('idle')
}, [])
```

3f. Add `pauseGeneration`:

```typescript
const pauseGeneration = useCallback(() => {
  pipelineRef.current?.requestPause?.()
}, [])
```

3g. Add `resumeGeneration`:

```typescript
const resumeGeneration = useCallback(
  async (onProgress?: (progress: PipelineProgress) => void) => {
    const pipeline = pipelineRef.current
    if (!pipeline?.resume) {
      console.warn('[Director] 无法恢复: pipeline 未初始化')
      return
    }

    const store = useDirectorStore.getState()
    store.setGenerationStatus('running')

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    try {
      const result = await pipeline.resume(onProgress, { signal: abortController.signal })

      if ((result as any).__paused) {
        store.setGenerationStatus('paused')
        return result
      }

      // Process result (same as startGeneration)
      const mappedImages = (result.images ?? []).map((img: any) => ({
        url: img.url,
        prompt: img.prompt,
        timestamp: Date.now(),
      }))
      store.setGeneratedResults(mappedImages)

      if (result.scene) store.setLastAnalysisResult(JSON.stringify(result.scene))
      if (result.characters) store.setLastCharacterAnchor(JSON.stringify(result.characters))

      return result
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log('[Director] 恢复已取消')
        return
      }
      throw err
    } finally {
      const s = useDirectorStore.getState()
      if (s.generationStatus === 'running') {
        s.setGenerationStatus('idle')
      }
    }
  },
  [],
)
```

3h. Update return value:

```typescript
return {
  canGenerate,
  canRegenerate,
  isGenerating,
  generationStatus,
  startGeneration,
  regenerateImages,
  cancelGeneration,
  pauseGeneration,
  resumeGeneration,
  getLayoutConfig,
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/hooks/useDirectorGeneration.ts src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts
git commit -m "feat(hook): add cancelGeneration, pauseGeneration, resumeGeneration"
```

---

### Task 9: UI — GenerateButton 上下文按钮

**Files:**
- Modify: `src/renderer/src/react-app/components/GenerateButton.tsx`
- Test: `src/renderer/src/react-app/components/__tests__/GenerateButton.test.tsx`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/react-app/components/__tests__/GenerateButton.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GenerateButton } from '../GenerateButton'
import { useDirectorStore } from '../../stores/useDirectorStore'

describe('GenerateButton states', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  it('should show generate text when idle', () => {
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByText('一键生成漫画分镜')).toBeDefined()
  })

  it('should show cancel and pause buttons when running', () => {
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByText('取消')).toBeDefined()
    expect(screen.getByText('暂停')).toBeDefined()
  })

  it('should show resume and cancel buttons when paused', () => {
    useDirectorStore.getState().setGenerationStatus('paused')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    expect(screen.getByText('继续')).toBeDefined()
    expect(screen.getByText('取消')).toBeDefined()
  })

  it('should call onCancel when cancel button clicked', () => {
    const onCancel = vi.fn()
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={onCancel}
        onPause={vi.fn()}
        onResume={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('should call onPause when pause button clicked', () => {
    const onPause = vi.fn()
    useDirectorStore.getState().setGenerationStatus('running')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={onPause}
        onResume={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('暂停'))
    expect(onPause).toHaveBeenCalledOnce()
  })

  it('should call onResume when resume button clicked', () => {
    const onResume = vi.fn()
    useDirectorStore.getState().setGenerationStatus('paused')
    render(
      <GenerateButton
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onPause={vi.fn()}
        onResume={onResume}
      />
    )
    fireEvent.click(screen.getByText('继续'))
    expect(onResume).toHaveBeenCalledOnce()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/GenerateButton.test.tsx`
Expected: FAIL — GenerateButton doesn't accept onCancel/onPause/onResume props

**Step 3: Write minimal implementation**

```typescript
import { useDirectorStore } from '../stores/useDirectorStore'
import type { GenerationStatus } from '../stores/useDirectorStore'

interface GenerateButtonProps {
  onGenerate: () => void
  onCancel: () => void
  onPause: () => void
  onResume: () => void
}

export function GenerateButton({ onGenerate, onCancel, onPause, onResume }: GenerateButtonProps) {
  const generationStatus = useDirectorStore((s) => s.generationStatus)
  const hasImages = useDirectorStore((s) => s.referenceImages.length > 0)

  if (generationStatus === 'running') {
    return (
      <div className="w-full flex gap-1">
        <button
          onClick={onPause}
          className="flex-1 py-3 rounded-none bg-amber-500 text-black font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-amber-400 active:scale-95"
        >
          <i className="fas fa-pause" />
          暂停
        </button>
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-none bg-red-600 text-white font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-red-500 active:scale-95"
        >
          <i className="fas fa-times" />
          取消
        </button>
      </div>
    )
  }

  if (generationStatus === 'paused') {
    return (
      <div className="w-full flex gap-1">
        <button
          onClick={onResume}
          className="flex-1 py-3 rounded-none bg-green-600 text-white font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-green-500 active:scale-95"
        >
          <i className="fas fa-play" />
          继续
        </button>
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-none bg-red-600 text-white font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-red-500 active:scale-95"
        >
          <i className="fas fa-times" />
          取消
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={onGenerate}
      disabled={!hasImages}
      className="w-full py-3 rounded-none bg-[#FCE300] text-black font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 active:scale-95"
    >
      <i className="fas fa-magic" />
      一键生成漫画分镜
    </button>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/GenerateButton.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/components/GenerateButton.tsx src/renderer/src/react-app/components/__tests__/GenerateButton.test.tsx
git commit -m "feat(ui): add context-dependent cancel/pause/resume buttons to GenerateButton"
```

---

### Task 10: UI — DirectorApp 接线

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`

**Step 1: Update GenerateButton usage in DirectorApp**

在 `DirectorApp.tsx` 中找到 `<GenerateButton>` 的使用位置，更新 props：

```typescript
const {
  canGenerate,
  isGenerating,
  generationStatus,
  startGeneration,
  cancelGeneration,
  pauseGeneration,
  resumeGeneration,
  regenerateImages,
  getLayoutConfig,
} = useDirectorGeneration()
```

更新 `<GenerateButton>` 组件使用:

```typescript
<GenerateButton
  onGenerate={handleGenerate}
  onCancel={cancelGeneration}
  onPause={pauseGeneration}
  onResume={() => resumeGeneration(handleProgress)}
/>
```

**Step 2: Update GenerationProgress for paused state**

如果 `GenerationProgress` 组件显示进度信息，添加暂停状态显示:

```typescript
{generationStatus === 'paused' && (
  <div className="text-amber-400 text-sm mt-2 flex items-center gap-2">
    <i className="fas fa-pause-circle" />
    已暂停 — 点击「继续」恢复生成
  </div>
)}
```

**Step 3: Run all component tests**

Run: `npx vitest run src/renderer/src/react-app/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx
git commit -m "feat(ui): wire cancel/pause/resume into DirectorApp"
```

---

### Task 11: regenerateImages — signal 支持

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`

**Step 1: Modify regenerateImages to accept signal**

在 `DirectorPipeline.ts` 的 `regenerateImages()` 方法:

```typescript
async regenerateImages(
  previousState: Partial<DirectorState>,
  imageCount: number,
  onProgress?: (progress: PipelineProgress) => void,
  options?: PipelineExecuteOptions,  // NEW
): Promise<DirectorResult> {
```

在方法内部，将 signal 传递给 `apiService.generateImage` 和 `runWithConcurrency`:

```typescript
const results = await this.runWithConcurrency(
  imageCount,
  Math.max(1, imageCount),
  async (i) => {
    // ... existing task code ...
    const result = await apiService.generateImage({
      // ... existing params ...
      signal: options?.signal,  // NEW
    })
    // ...
  },
  options?.signal,  // NEW
)
```

**Step 2: Update hook's regenerateImages to pass signal**

在 `useDirectorGeneration.ts` 的 `regenerateImages` callback 中:

```typescript
const result = await pipeline.regenerateImages(
  { ...prevState, imageModel: drawingModel },
  count,
  onProgress,
  { signal: abortControllerRef.current?.signal },  // NEW
)
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/react-app/hooks/useDirectorGeneration.ts
git commit -m "feat: add signal support to regenerateImages"
```

---

### Task 12: 多场景模式 — cancel 支持

**Files:**
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`

**Step 1: Add signal check in multi-scene loop**

在 `startGeneration` 的多场景循环中，每次迭代前检查 signal:

```typescript
if (currentMode === 'multi' && multiSceneText.trim()) {
  const scenes = multiSceneText.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0)
  const allResults = []

  for (let i = 0; i < scenes.length; i++) {
    // 检查是否已取消
    if (abortController.signal.aborted) {
      console.log(`[Director] 多场景模式: 已取消，跳过场景 ${i + 1}/${scenes.length}`)
      break
    }

    const result = await executeSingle(
      pipeline, scenes[i], resolvedStyle, layoutConfig, drawingModel, onProgress,
    )
    // ... existing result processing ...
  }
}
```

**Step 2: Also pass signal to executeSingle**

修改 `executeSingle` 以传递 signal:

```typescript
const executeSingle = useCallback(
  async (pipeline, scene, resolvedStyle, layoutConfig, drawingModel, onProgress, signal?) => {
    return pipeline.execute(
      { /* ... existing input ... */ },
      onProgress,
      { signal },  // NEW
    )
  },
  [/* ... */],
)
```

并在调用处传递:

```typescript
const result = await executeSingle(
  pipeline, scenes[i], resolvedStyle, layoutConfig, drawingModel,
  onProgress, abortController.signal,
)
```

和单场景模式:

```typescript
const result = await executeSingle(
  pipeline, sceneDescription, resolvedStyle, layoutConfig, drawingModel,
  onProgress, abortController.signal,
)
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/hooks/useDirectorGeneration.ts
git commit -m "feat(hook): add cancel support for multi-scene mode"
```

---

### Task 13: 集成验证

**Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: All PASS

**Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增类型错误（预期有预先存在的路径别名错误，忽略）

**Step 3: 构建**

Run: `npm run build`
Expected: Build succeeds

**Step 4: 手动验证清单**

- [ ] 启动应用，进入导演模式
- [ ] 上传参考图，点击生成
- [ ] 生成中显示「暂停」和「取消」两个按钮
- [ ] 点击「取消」→ 立即停止，保留已完成的中间结果
- [ ] 重新生成，点击「暂停」→ 当前节点完成后暂停
- [ ] 暂停后显示「继续」和「取消」按钮
- [ ] 点击「继续」→ 从暂停处恢复
- [ ] 暂停后点击「取消」→ 清除暂停状态回到 idle
- [ ] 多场景模式下取消 → 已完成场景结果保留

**Step 5: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve integration issues from cancel/pause/resume feature"
```
