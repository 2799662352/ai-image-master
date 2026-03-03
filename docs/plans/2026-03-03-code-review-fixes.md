# Code Review 修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Code Review 发现的 P1/P2 问题：LayoutSelector useShallow 重构、Pipeline 类型安全、Store 类型修复、测试补全。

**Architecture:** 4 个独立修复任务，每个自带 TDD 验证。修改仅限类型/选择器层面，不改变业务逻辑。

**Tech Stack:** React 19, Zustand 5 (`useShallow` from `zustand/react/shallow`), TypeScript, Vitest

**Context7 依据：** Zustand v5 `useShallow` 必须包裹多字段 selector 防止不必要重渲染；import 路径为 `zustand/react/shallow`。

---

### Task 1: LayoutSelector 改用 useShallow 单 selector (P1-1)

**Files:**
- Modify: `src/renderer/src/react-app/components/LayoutSelector.tsx:1,52-61`
- Test: `src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx`

**Step 1: Run existing tests to confirm green baseline**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx`
Expected: 5 PASS

**Step 2: Refactor LayoutSelector.tsx — replace 9 individual selectors with single useShallow**

Replace lines 1 and 52-61:

```tsx
import { useShallow } from 'zustand/react/shallow'
import { useDirectorStore, type LayoutOrientation, type LayoutType } from '../stores/useDirectorStore'
```

```tsx
export function LayoutSelector() {
  const {
    currentLayout, currentRatio, currentLayoutOrientation,
    isLayoutOrientationAuto, setLayout, setLayoutOrientation,
    setLayoutOrientationAuto, setSemanticOrientation, setSemanticOrientationAuto,
  } = useDirectorStore(useShallow((s) => ({
    currentLayout: s.currentLayout,
    currentRatio: s.currentRatio,
    currentLayoutOrientation: s.currentLayoutOrientation,
    isLayoutOrientationAuto: s.isLayoutOrientationAuto,
    setLayout: s.setLayout,
    setLayoutOrientation: s.setLayoutOrientation,
    setLayoutOrientationAuto: s.setLayoutOrientationAuto,
    setSemanticOrientation: s.setSemanticOrientation,
    setSemanticOrientationAuto: s.setSemanticOrientationAuto,
  })))
```

**Step 3: Run tests to verify refactor is green**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx`
Expected: 5 PASS（行为不变，仅选择器模式改为 useShallow）

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/components/LayoutSelector.tsx
git commit -m "refactor(LayoutSelector): use useShallow for Zustand selectors [P1-1]"
```

---

### Task 2: 移除 DirectorPipeline 不必要的 `as any` 类型转换 (P1-2)

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:180`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

**Step 1: Run existing tests to confirm green baseline**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: 3 PASS

**Step 2: Remove `(state as any)` cast**

Change line 180 from:
```typescript
semantic_orientation_instruction: getSemanticOrientationInstruction((state as any).semanticOrientation),
```

To:
```typescript
semantic_orientation_instruction: getSemanticOrientationInstruction(state.semanticOrientation),
```

**Step 3: Run tests to verify**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: 3 PASS

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix(DirectorPipeline): remove unnecessary as-any cast on semanticOrientation [P1-2]"
```

---

### Task 3: 修复 initialGenerationState Pick 类型遗漏 (P2-1)

**Files:**
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts:279-282`
- Test: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`

**Step 1: Run existing tests to confirm green baseline**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: 20 PASS

**Step 2: Add missing fields to Pick type**

Change lines 279-282 from:
```typescript
const initialGenerationState: Pick<
  GenerationSlice,
  'isGenerating' | 'isProcessingFiles' | 'generatedResults' | 'lastAnalysisResult' | 'lastCharacterAnchor' | 'viewState' | 'currentProgress' | 'passStatuses' | 'passCards' | 'progressPercentage'
> = {
```

To:
```typescript
const initialGenerationState: Pick<
  GenerationSlice,
  'isGenerating' | 'isProcessingFiles' | 'generatedResults' | 'lastAnalysisResult' | 'lastCharacterAnchor' | 'lastPipelineState' | 'viewState' | 'currentProgress' | 'passStatuses' | 'passCards' | 'progressPercentage' | 'regenerateCount'
> = {
```

**Step 3: Run tests + lint to verify**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: 20 PASS + lint 原有 2 个错误消失

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/stores/useDirectorStore.ts
git commit -m "fix(store): add missing lastPipelineState and regenerateCount to Pick type [P2-1]"
```

---

### Task 4: 补全测试覆盖 (P2-3)

**Files:**
- Modify: `src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx`
- Modify: `src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`

**Step 1: Write failing tests**

在 `LayoutSelector.test.tsx` 新增：

```tsx
it('restoring auto mode restores both layout and semantic auto flags', () => {
  const store = useDirectorStore.getState()
  store.setRatio('16:9')
  store.setLayoutOrientation('portrait')
  store.setSemanticOrientation('portrait')

  render(<LayoutSelector />)
  fireEvent.click(screen.getByRole('button', { name: '恢复跟随比例' }))

  const state = useDirectorStore.getState()
  expect(state.isLayoutOrientationAuto).toBe(true)
  expect(state.isSemanticOrientationAuto).toBe(true)
  expect(state.currentLayoutOrientation).toBe('landscape')
  expect(state.currentSemanticOrientation).toBe('landscape')
})
```

在 `director-pipeline-parallel-generate.test.ts` 新增：

```typescript
it('semantic orientation instruction falls back gracefully for undefined', () => {
  const result = getSemanticOrientationInstruction(undefined)
  expect(result).toContain('SEMANTIC ORIENTATION PRIORITY')
  expect(result).toContain('horizontal')
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: 新增用例 FAIL（代码已实现但测试是新增的，实际应该直接 PASS——这些是补全覆盖）

**Step 3: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`
Expected: ALL PASS（7 + 4 = 11 个测试）

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts
git commit -m "test: add coverage for handleRestoreAuto and getSemanticOrientationInstruction fallback [P2-3]"
```
