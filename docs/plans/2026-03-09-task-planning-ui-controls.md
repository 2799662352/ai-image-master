# 导演规划 UI 控件 (看图质量 + 跳过开关) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在导演模式 UI 中为"导演规划"(Pass 0) 添加看图质量 (低/高/自动) 和跳过开关，与场景分析/角色锚定/一致性校验的控件完全一致。

**Architecture:** 纵向贯穿 4 层：DirectorState (Zod schema) → useDirectorStore (Zustand + localStorage) → useDirectorGeneration (透传) → DirectorApp (UI 渲染)。同时更新 `DEFAULT_VISION_DETAIL`、`resolveVisionDetailByPass`、`detectVisionDetailPreset` 和预设逻辑。在 `taskPlanningFn` 中使用新的 vision detail 值和 skip 标志。

**Tech Stack:** TypeScript, React, Zustand, Zod, localStorage

---

## 改动清单概览

| 层 | 文件 | 新增字段 |
|----|------|---------|
| Pipeline State | `DirectorPipeline.ts` | `visionDetailTaskPlanning`, `skipTaskPlanning` |
| Pipeline Logic | `DirectorPipeline.ts` | `resolveVisionDetailByPass` 支持 `taskPlanning`; `taskPlanningFn` 使用 vision detail + skip |
| Store | `useDirectorStore.ts` | `visionDetailTaskPlanning`, `skipTaskPlanning` + setters + localStorage |
| Hook | `useDirectorGeneration.ts` | 透传两个新字段 |
| UI | `DirectorApp.tsx` | 导演规划行加入看图质量数组 |

---

### Task 1: DirectorPipeline state + logic

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 更新 DEFAULT_VISION_DETAIL (line 29)**

```typescript
// Before:
const DEFAULT_VISION_DETAIL = {
  analyzeScene: 'high',
  extractCharacterAnchors: 'high',
  designAndAssemble: 'high',
  verifyConsistency: 'low',
} as const

// After:
const DEFAULT_VISION_DETAIL = {
  taskPlanning: 'low',
  analyzeScene: 'high',
  extractCharacterAnchors: 'high',
  designAndAssemble: 'high',
  verifyConsistency: 'low',
} as const
```

**Step 2: 添加 stateSchema 字段 (约 line 81)**

在 `visionDetailAnalyzeScene` 行之前添加：

```typescript
  visionDetailTaskPlanning: z.enum(['low', 'high', 'auto']).default(DEFAULT_VISION_DETAIL.taskPlanning),
```

在 `skipAnalyzeScene` 行之前添加：

```typescript
  skipTaskPlanning: z.boolean().default(false),
```

**Step 3: 更新 resolveVisionDetailByPass (约 line 269)**

在 `pass` 参数类型联合中添加 `'taskPlanning'`：

```typescript
export function resolveVisionDetailByPass(
  state: Partial<DirectorState> | Record<string, unknown>,
  pass: 'taskPlanning' | 'analyzeScene' | 'extractCharacterAnchors' | 'designAndAssemble' | 'verifyConsistency',
): VisionDetail {
  switch (pass) {
    case 'taskPlanning':
      return normalizeVisionDetail((state as any).visionDetailTaskPlanning, DEFAULT_VISION_DETAIL.taskPlanning)
    case 'analyzeScene':
      // ... existing ...
```

**Step 4: 更新 taskPlanningFn 使用 vision detail + skip**

在 `taskPlanningFn` 开头（`const t0 = Date.now()` 之后）添加 skip 检查：

```typescript
      if (state.skipTaskPlanning) {
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('taskPlanning', { pass: 0, label: '导演规划' }, { planText: '(已跳过)', skipped: true }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: 0, label: '导演规划（已跳过）', elapsed, passData })
        return { taskPlan: '' }
      }
```

将 `buildImageContent` 调用中的硬编码 `'low'` 改为动态值：

```typescript
// Before:
            ...BasePipeline.buildImageContent(state.inputImages, 'low'),

// After:
            ...BasePipeline.buildImageContent(
              state.inputImages,
              resolveVisionDetailByPass(state, 'taskPlanning'),
            ),
```

**Step 5: 运行测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All pass (185/186, 1 pre-existing)

---

### Task 2: useDirectorStore 添加新字段

**Files:**
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts`

**Step 1: 添加 localStorage key**

在已有的 vision detail storage key 之前添加：

```typescript
const DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY = 'director.vision-detail.task-planning.v1'
const DIRECTOR_SKIP_TASK_PLANNING_STORAGE_KEY = 'director.skip-task-planning.v1'
```

**Step 2: ConfigSlice 接口添加字段**

在 `visionDetailAnalyzeScene: VisionDetail` 之前添加：

```typescript
  visionDetailTaskPlanning: VisionDetail
```

在 `skipAnalyzeScene: boolean` 之前添加：

```typescript
  skipTaskPlanning: boolean
```

在 `setVisionDetailAnalyzeScene` 之前添加：

```typescript
  setVisionDetailTaskPlanning: (val: VisionDetail) => void
```

在 `setSkipAnalyzeScene` 之前添加：

```typescript
  setSkipTaskPlanning: (val: boolean) => void
```

**Step 3: createInitialConfigState 添加默认值**

在 `visionDetailAnalyzeScene` 之前添加：

```typescript
  visionDetailTaskPlanning: readVisionDetail(DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY, 'low'),
```

在 `skipAnalyzeScene` 之前添加：

```typescript
  skipTaskPlanning: readSkipFlag(DIRECTOR_SKIP_TASK_PLANNING_STORAGE_KEY),
```

**Step 4: createConfigSlice 添加 setter**

```typescript
  setVisionDetailTaskPlanning: (val) => {
    writeVisionDetail(DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY, val)
    set({ visionDetailTaskPlanning: val })
  },
  setSkipTaskPlanning: (val) => {
    writeSkipFlag(DIRECTOR_SKIP_TASK_PLANNING_STORAGE_KEY, val)
    set({ skipTaskPlanning: val })
  },
```

**Step 5: 更新 detectVisionDetailPreset**

在 `detectVisionDetailPreset` 函数的参数和逻辑中加入 `visionDetailTaskPlanning`：

```typescript
export function detectVisionDetailPreset(config: {
  visionDetailTaskPlanning: VisionDetail
  visionDetailAnalyzeScene: VisionDetail
  visionDetailCharacterAnchors: VisionDetail
  visionDetailDesignAssemble: VisionDetail
  visionDetailVerifyConsistency: VisionDetail
}): VisionDetailPresetState {
  if (
    config.visionDetailTaskPlanning === 'low' &&
    config.visionDetailAnalyzeScene === 'high' &&
    config.visionDetailCharacterAnchors === 'high' &&
    config.visionDetailDesignAssemble === 'low' &&
    config.visionDetailVerifyConsistency === 'low'
  ) {
    return 'speed'
  }
  if (
    config.visionDetailTaskPlanning === 'low' &&
    config.visionDetailAnalyzeScene === 'high' &&
    config.visionDetailCharacterAnchors === 'high' &&
    config.visionDetailDesignAssemble === 'auto' &&
    config.visionDetailVerifyConsistency === 'auto'
  ) {
    return 'balanced'
  }
  if (
    config.visionDetailTaskPlanning === 'high' &&
    config.visionDetailAnalyzeScene === 'high' &&
    config.visionDetailCharacterAnchors === 'high' &&
    config.visionDetailDesignAssemble === 'high' &&
    config.visionDetailVerifyConsistency === 'high'
  ) {
    return 'quality'
  }
  return 'custom'
}
```

**Step 6: 更新 applyVisionDetailPreset**

在 `applyVisionDetailPreset` 的三个预设对象中加入 `visionDetailTaskPlanning`：

```typescript
  applyVisionDetailPreset: (preset) => {
    const next = preset === 'quality'
      ? {
          visionDetailTaskPlanning: 'high' as VisionDetail,
          visionDetailAnalyzeScene: 'high' as VisionDetail,
          // ... existing ...
        }
      : preset === 'balanced'
        ? {
            visionDetailTaskPlanning: 'low' as VisionDetail,
            visionDetailAnalyzeScene: 'high' as VisionDetail,
            // ... existing ...
          }
        : {
            visionDetailTaskPlanning: 'low' as VisionDetail,
            visionDetailAnalyzeScene: 'high' as VisionDetail,
            // ... existing ...
          }

    writeVisionDetail(DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY, next.visionDetailTaskPlanning)
    // ... existing writeVisionDetail calls ...
    set(next)
  },
```

**Step 7: 更新 Pick 类型**

在 `createInitialConfigState` 的 Pick 类型联合中添加 `'visionDetailTaskPlanning' | 'skipTaskPlanning'`。

---

### Task 3: useDirectorGeneration 透传

**Files:**
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`

**Step 1: 从 store 解构新字段**

在已有的 `visionDetailAnalyzeScene` 解构附近添加 `visionDetailTaskPlanning` 和 `skipTaskPlanning`。

**Step 2: 传入 pipeline.execute()**

在 `executeSingle` 的 input 对象中添加：

```typescript
          visionDetailTaskPlanning,
          skipTaskPlanning,
```

**Step 3: 添加到 useCallback deps**

在 `executeSingle` 的依赖数组中添加 `visionDetailTaskPlanning` 和 `skipTaskPlanning`。

---

### Task 4: DirectorApp.tsx UI

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`

**Step 1: 从 store 解构新字段**

添加 `visionDetailTaskPlanning`, `setVisionDetailTaskPlanning`, `skipTaskPlanning`, `setSkipTaskPlanning`。

**Step 2: 在看图质量数组中添加导演规划行**

在 line 281 的数组最前面插入新行：

```typescript
                {[
                  { key: 'planning', label: '导演规划', value: visionDetailTaskPlanning, onChange: setVisionDetailTaskPlanning, skippable: true, skipped: skipTaskPlanning, onToggleSkip: setSkipTaskPlanning, skipLabel: '跳过导演规划' },
                  { key: 'analyze', label: '场景分析', value: visionDetailAnalyzeScene, onChange: setVisionDetailAnalyzeScene, skippable: true, skipped: skipAnalyzeScene, onToggleSkip: setSkipAnalyzeScene, skipLabel: '跳过场景分析' },
                  // ... existing entries ...
                ]}
```

**Step 3: 更新 activePreset 计算**

确保 `activePreset` 的计算（`detectVisionDetailPreset` 调用）传入了 `visionDetailTaskPlanning`。找到 `useMemo` 调用处，添加 `visionDetailTaskPlanning` 到参数和依赖。

---

### Task 5: 端到端验证

**Step 1: 运行 pipeline 测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All pass (185/186, 1 pre-existing)

**Step 2: 运行 store 测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/react-app/stores/__tests__/ --reporter=verbose`

Expected: All pass

**Step 3: 运行 DirectorApp skip-stages 测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/react-app/__tests__/DirectorApp.skip-stages.test.tsx --reporter=verbose`

Expected: All pass (可能需要更新快照或断言)

---

## 改动总结

| 文件 | 改动 |
|------|------|
| `DirectorPipeline.ts` | +`taskPlanning` in DEFAULT_VISION_DETAIL; +2 state fields; resolveVisionDetailByPass 支持 taskPlanning; taskPlanningFn 加 skip + dynamic vision detail |
| `useDirectorStore.ts` | +2 fields + 2 setters + 2 localStorage keys; detectVisionDetailPreset + applyVisionDetailPreset 更新 |
| `useDirectorGeneration.ts` | 透传 `visionDetailTaskPlanning` + `skipTaskPlanning` |
| `DirectorApp.tsx` | 看图质量数组首位插入"导演规划"行（toggle + 低/高/自动） |

**UI 效果：** 看图质量面板从 4 行变成 5 行，导演规划排在最前面，有独立的 skip toggle 和低/高/自动按钮。预设逻辑同步更新（省时 = low，质量 = high）。
