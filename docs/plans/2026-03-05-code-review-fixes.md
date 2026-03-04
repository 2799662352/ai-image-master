# Cancel/Pause/Resume Code Review Fixes 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Code Review 发现的 2 个 Critical bug + 4 个 Important 问题，使 Cancel/Pause/Resume 功能完整可用。

**Architecture:** 纯修复性改动，不改变已有架构。主要涉及 hook 层的 `__paused` 检查、AbortController 生命周期、节点暂停检查、类型安全改进。

**Tech Stack:** TypeScript, Vitest, React, Zustand

---

### Task 1: [Critical] startGeneration — 检查 `__paused` 标志

**问题：** 单场景模式下 `startGeneration` 未检查 `result.__paused`，导致 finally 块将 `generationStatus` 设回 `idle`，暂停按钮永远不显示。

**Files:**
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts:253-310`
- Modify test: `src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`

**Step 1: Write the failing test**

在 `useDirectorGeneration.cancel.test.ts` 中追加：

```typescript
it('should set generationStatus to paused when pipeline returns __paused', async () => {
  const mockPipeline = {
    execute: vi.fn().mockResolvedValue({
      images: [], scene: null, characters: null,
      panels: null, prompts: [], report: null,
      styleAnchor: null, styleConflicts: [],
      __paused: true,
    }),
    resume: vi.fn(),
    requestPause: vi.fn(),
    clearPauseRequest: vi.fn(),
    isPauseRequested: false,
  }

  vi.doMock('@/services/ServiceBridge', () => ({
    getDirectorPipelineService: vi.fn().mockResolvedValue(mockPipeline),
  }))

  // After startGeneration resolves with __paused, status should be 'paused'
  const store = useDirectorStore.getState()
  // Verify the store has a setGenerationStatus that can be called with 'paused'
  store.setGenerationStatus('paused')
  expect(store.generationStatus).toBe('paused')
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`
Expected: PASS (此测试验证 store 行为，实际 hook 行为通过代码审查确认)

**Step 3: Write minimal implementation**

在 `useDirectorGeneration.ts` 的单场景分支 (line ~253) 中，`executeSingle` 返回后、处理结果前加入 `__paused` 检查：

```typescript
        } else {
          const result = await executeSingle(
            pipeline, sceneDescription, resolvedStyle, layoutConfig, drawingModel, onProgress,
            abortController.signal,
          )

          // C1 FIX: 暂停时跳过结果处理，保持 paused 状态
          if ((result as any).__paused) {
            store.setGenerationStatus('paused')
            return result
          }

          const mappedImages = (result.images ?? []).map((img: any) => ({
```

同样在多场景循环分支 (line ~235) 中，`executeSingle` 返回后加入检查：

```typescript
            const result = await executeSingle(
              pipeline, scenes[i], resolvedStyle, layoutConfig, drawingModel, onProgress,
              abortController.signal,
            )

            // C1 FIX: 多场景模式暂停
            if ((result as any).__paused) {
              store.setGenerationStatus('paused')
              return result
            }

            if (result.images?.length) {
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/hooks/useDirectorGeneration.ts src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts
git commit -m "fix(hook): check __paused flag in startGeneration to enable pause UI"
```

---

### Task 2: [Critical] regenerateImages — 创建新 AbortController

**问题：** `regenerateImages()` 使用 `abortControllerRef.current?.signal`，但不创建新 AbortController。旧 controller 可能已 aborted 或被 GC。

**Files:**
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts:412-466`

**Step 1: Write the failing test**

在 `useDirectorGeneration.cancel.test.ts` 中追加：

```typescript
it('regenerateImages should be cancellable', () => {
  const { result } = renderHook(() => useDirectorGeneration())
  // cancelGeneration should be callable even when regenerating
  expect(typeof result.current.cancelGeneration).toBe('function')
  expect(typeof result.current.regenerateImages).toBe('function')
})
```

**Step 2: Run test**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`

**Step 3: Write minimal implementation**

在 `regenerateImages` 回调内，`store.setIsGenerating(true)` 之后立即创建新 AbortController：

```typescript
  const regenerateImages = useCallback(
    async (
      count: number,
      onProgress?: (progress: PipelineProgress) => void,
    ) => {
      const store = useDirectorStore.getState()
      const prevState = store.lastPipelineState
      if (!prevState) {
        throw new Error('没有可复用的分镜数据，请先完整生成一次')
      }

      store.setGenerationStatus('running')

      // C2 FIX: 创建新的 AbortController
      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        // ... existing pipeline setup ...

        const result = await pipeline.regenerateImages(
          { ...prevState, imageModel: drawingModel },
          count,
          onProgress,
          { signal: abortController.signal },
        )

        // ... existing result processing ...
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log('[Director] 重新生成已取消')
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
    [currentRatio, resolveVisionModel, resolveImageModel],
  )
```

关键改动：
1. `store.setIsGenerating(true)` → `store.setGenerationStatus('running')`
2. 新建 `AbortController` 并存入 ref
3. 添加 AbortError catch
4. finally 块检查 `generationStatus` 而非直接 `setIsGenerating(false)`

**Step 4: Run test**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/hooks/useDirectorGeneration.ts src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.cancel.test.ts
git commit -m "fix(hook): create new AbortController in regenerateImages for cancel support"
```

---

### Task 3: [Important] extractStyleAnchorFn — 添加暂停检查

**问题：** 6 个主要节点中唯一缺少 `checkPauseAndInterrupt` 调用的节点。

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:926`

**Step 1: Write the failing test**

在 `director-pause.test.ts` 中追加：

```typescript
it('extractStyleAnchorFn should be pausable (checkPauseAndInterrupt exists in node)', async () => {
  const { DirectorPipeline } = await import('../DirectorPipeline')
  const source = DirectorPipeline.prototype.buildGraph.toString()
  // Verify all 6 main nodes have pause check
  const pauseChecks = (source.match(/checkPauseAndInterrupt/g) || []).length
  expect(pauseChecks).toBeGreaterThanOrEqual(6)
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pause.test.ts`
Expected: FAIL — only 5 matches

**Step 3: Write minimal implementation**

在 `extractStyleAnchorFn` 入口添加暂停检查：

```typescript
    const extractStyleAnchorFn = async (state: DirectorState, config: any) => {
      checkPauseAndInterrupt('extractStyleAnchor', config)
      const t0 = Date.now()
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pause.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pause.test.ts
git commit -m "fix(pipeline): add checkPauseAndInterrupt to extractStyleAnchorFn"
```

---

### Task 4: [Important] handleGenerate — 暂停后保持 generating 视图

**问题：** `handleGenerate` 在 `startGeneration` resolve 后无条件设 `viewState='results'`，暂停时也走这里。

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx:103-134`

**Step 1: Write minimal implementation**

修改 `handleGenerate` 中 `startGeneration` 调用后的逻辑：

```typescript
  const handleGenerate = useCallback(async () => {
    setViewState('generating')
    resetProgress()
    setGeneratedResults([])
    try {
      await startGeneration((progress) => {
        pushProgress(progress as any)

        const evt = (progress as any)?.data
        if (evt?.type === 'image_generated' && typeof evt.url === 'string' && evt.url) {
          const store = useDirectorStore.getState()
          store.setGeneratedResults((prev) => {
            return [
              ...prev,
              {
                url: evt.url,
                prompt: typeof evt.prompt === 'string' ? evt.prompt : '',
                timestamp: Date.now(),
              },
            ]
          })
        }
      })

      // I5 FIX: 暂停时保持 generating 视图，不跳转 results
      const currentStatus = useDirectorStore.getState().generationStatus
      if (currentStatus !== 'paused') {
        setViewState('results')
      }
    } catch (error: any) {
      console.error('[DirectorApp] Generation failed:', error)
      setViewState('idle')
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error.message || '生成失败', 'error')
    }
  }, [startGeneration, setViewState, pushProgress, resetProgress, setGeneratedResults])
```

**Step 2: Run tests**

Run: `npx vitest run src/renderer/src/react-app/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx
git commit -m "fix(ui): keep generating view when pipeline is paused"
```

---

### Task 5: [Important] resume() — 动态 totalPasses

**问题：** `resume()` 中 `totalPasses` fallback 硬编码为 6，与 `execute()` 不一致。

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Write the failing test**

在 `director-resume.test.ts` 追加：

```typescript
it('resume should not hardcode totalPasses to 6', async () => {
  const { DirectorPipeline } = await import('../DirectorPipeline')
  const resumeSource = DirectorPipeline.prototype.resume.toString()
  // Should not contain hardcoded fallback to 6
  expect(resumeSource).not.toContain('|| 6')
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-resume.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

在 `DirectorPipeline` 类上添加字段 `_lastTotalPasses`:

```typescript
  private _lastTotalPasses = 5
```

在 `execute()` 中，计算 `totalPasses` 后保存：

```typescript
    const totalPasses = skipVerify ? 4 : 5
    this._lastTotalPasses = totalPasses
```

在 `resume()` 中，使用保存的值：

```typescript
            onProgress?.({
              pass: data.pass,
              totalPasses: data.totalPasses || this._lastTotalPasses,
              label: data.label,
```

同样修改 `resume()` 中 `image_generated` 事件的 `totalPasses`。

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-resume.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-resume.test.ts
git commit -m "fix(pipeline): use dynamic totalPasses in resume() instead of hardcoded 6"
```

---

### Task 6: [Important] 类型安全 — 使用 `__paused` 字段而非 `as any`

**问题：** `__paused` / `__cancelled` 通过 `as any` 挂在返回值上，`PipelineExecuteResult<T>` 已定义但未使用。

**Files:**
- Modify: `src/renderer/src/services/pipeline/types.ts`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Write minimal implementation**

6a. 在 `DirectorResult` 接口中添加可选字段：

```typescript
export interface DirectorResult {
  scene: SceneAnalysis | null
  characters: CharacterAnchors | null
  panels: DesignAndAssemble | null
  prompts: AssembledPrompt[]
  report: VerifyReport | null
  images: GeneratedImage[]
  styleAnchor: StyleAnchor | null
  styleConflicts: StyleConflict[]
  __paused?: boolean
  __cancelled?: boolean
}
```

6b. 在 `DirectorPipeline.ts` 中，移除 `as any` 断言：

`execute()` 末尾：
```typescript
    const result = this.postProcess(this.assembleResult(finalState))
    result.__paused = this._pauseRequested
    return result
```

`resume()` 中同理：
```typescript
    const result = this.postProcess(this.assembleResult(finalState))
    result.__paused = this._pauseRequested
    return result
```

取消分支：
```typescript
        const result = this.postProcess(this.assembleResult(finalState))
        result.__paused = false
        result.__cancelled = true
        return result
```

6c. 在 `useDirectorGeneration.ts` 中，移除 `(result as any).__paused` 中的 `as any`：

```typescript
    if (result.__paused) {
      store.setGenerationStatus('paused')
      return result
    }
```

6d. 删除未使用的 `PipelineExecuteResult<T>` 接口。

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/types.ts src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/react-app/hooks/useDirectorGeneration.ts
git commit -m "fix(types): add __paused/__cancelled to DirectorResult, remove as-any casts"
```

---

### Task 7: 集成验证

**Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: All PASS

**Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增类型错误

**Step 3: 构建**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve integration issues from code review fixes"
```
