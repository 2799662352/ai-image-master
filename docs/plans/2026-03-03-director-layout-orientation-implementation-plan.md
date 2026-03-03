# Director Layout Orientation Auto Behavior Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复导演模式在 `ratio=auto` 时方向错误回退，并补齐方向模式持久化与可回归测试。

**Architecture:** 在 Zustand store 层统一收口方向推断和持久化行为；UI 仅消费状态并显示解释性文案；生成 hook 保持稳定订阅模式（单 selector + `useShallow`），避免 Hook 顺序与无限重渲染回归。通过 store/hook/UI 单测覆盖行为矩阵，确保自动与手动模式可预测。

**Tech Stack:** React 19, Zustand 5, TypeScript, Vitest

---

### Context7 最佳实践（已纳入本计划）

1. Zustand v5：对象/数组多字段选择器使用 `useShallow`，避免新引用导致不必要重渲染或循环。
2. Zustand 持久化：优先使用明确 key 的 localStorage 持久化策略，读取需容错。
3. React Hooks：保持稳定调用顺序，所有 hooks 顶层调用，避免开发态热更新时 hook-order 报错。

---

### Task 1: Store 行为修复与持久化

**Files:**
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts`
- Test: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`

**Step 1: Write the failing test**

在 `useDirectorStore` 测试中新增至少 2 条先失败用例：

```ts
it('keeps orientation unchanged when ratio=auto in auto mode', () => {
  const store = useDirectorStore.getState()
  store.setLayoutOrientationAuto(true)
  store.setLayoutOrientation('portrait') // 进入手动
  store.setLayoutOrientationAuto(true)   // 回到自动（以当前 ratio 为准）
  const before = useDirectorStore.getState().currentLayoutOrientation
  useDirectorStore.getState().setRatio('auto')
  expect(useDirectorStore.getState().currentLayoutOrientation).toBe(before)
})

it('reads and writes layout orientation persistence', () => {
  useDirectorStore.getState().setLayoutOrientation('portrait')
  expect(useDirectorStore.getState().isLayoutOrientationAuto).toBe(false)
  // 可通过 localStorage spy/assert key 验证持久化调用
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`  
Expected: FAIL（`auto` 保持方向与持久化断言未实现）

**Step 3: Write minimal implementation**

在 `useDirectorStore.ts` 中实现（保持最小改动）：

```ts
const DIRECTOR_LAYOUT_ORIENTATION_STORAGE_KEY = 'director.layout-orientation.v1'
const DIRECTOR_LAYOUT_ORIENTATION_AUTO_STORAGE_KEY = 'director.layout-orientation-auto.v1'

function getOrientationByRatio(ratio: string, fallback: LayoutOrientation): LayoutOrientation {
  const [w, h] = ratio.split(':').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return fallback
  return w < h ? 'portrait' : 'landscape'
}
```

并在 `setRatio`、`setLayoutOrientation`、`setLayoutOrientationAuto` 中写入持久化与 `auto` 保持行为：

- 自动模式 + 比例 `w:h` -> 自动更新方向
- 自动模式 + `auto`/非法 -> 方向保持不变
- 手动模式 -> 比例变化不改方向

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/stores/useDirectorStore.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts
git commit -m "fix(director): keep orientation stable on auto ratio and persist orientation mode"
```

### Task 2: UI 文案与交互一致性

**Files:**
- Modify: `src/renderer/src/react-app/components/LayoutSelector.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx` (必要时补 smoke 断言)

**Step 1: Write the failing test**

为方向状态文案添加断言（或新增轻量组件测试）：

```ts
expect(screen.getByText(/跟随比例：auto（保持当前方向）/)).toBeInTheDocument()
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: FAIL（文案未匹配或条件未实现）

**Step 3: Write minimal implementation**

在 `LayoutSelector.tsx` 中分支显示（不改交互结构）：

- 自动 + `currentRatio === 'auto'` -> `跟随比例：auto（保持当前方向）`
- 自动 + 非 auto -> `跟随比例：${currentRatio}`
- 手动 -> `手动覆盖方向中`

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/components/LayoutSelector.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx
git commit -m "feat(director-ui): clarify auto ratio orientation behavior in layout selector"
```

### Task 3: Hook 回归验证与文档同步

**Files:**
- Modify: `src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts`
- Modify: `docs/plans/2026-03-03-director-layout-orientation-design.md`

**Step 1: Write the failing test**

补充布局映射稳定性断言（若已有则扩展覆盖 `auto` 场景）：

```ts
it('keeps layout mapping stable when ratio becomes auto and orientation remains portrait', () => {
  const store = useDirectorStore.getState()
  store.setLayoutOrientation('portrait')
  store.setRatio('auto')
  const { result } = renderHook(() => useDirectorGeneration())
  expect(result.current.getLayoutConfig('6grid')).toEqual({ rows: 3, cols: 2, panelCount: 6 })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts`  
Expected: FAIL（若行为未完全打通）

**Step 3: Write minimal implementation**

如测试失败，最小修复相关 store/hook 依赖；保持 `useDirectorGeneration` 使用单 selector + `useShallow`（不新增 selector 分裂）。

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts docs/plans/2026-03-03-director-layout-orientation-design.md
git commit -m "test(director): cover auto ratio orientation behavior end-to-end"
```

### Task 4: 质量检查（code-reviewer + lint）

**Files:**
- Modify: (none unless fixes needed)
- Test: `src/renderer/src/react-app/**`

**Step 1: Run code quality checker**

Run: `python ".cursor/skills/code-reviewer/scripts/code_quality_checker.py" "src/renderer/src/react-app" --recursive --language typescript`  
Expected: 报告生成成功

**Step 2: Run lint and targeted tests**

Run: `npm run test -- src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: PASS

**Step 2.5: Hooks 回归冒烟**

Run: `npm run dev` 后切换 `generate -> director` 并观察控制台  
Expected: 无 `change in the order of Hooks`、无 `getSnapshot` 相关 runtime error

**Step 3: Fix any regressions**

若有失败，最小修复并重复 Step 2。

**Step 4: Commit**

```bash
git add .
git commit -m "chore(director): finalize orientation-auto behavior with tests and quality checks"
```
