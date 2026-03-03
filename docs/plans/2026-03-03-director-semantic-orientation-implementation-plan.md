# Director 语义+结构双重强制 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把导演模式横/竖改为"像宫格一样的双重强制"——结构层（rows/cols）和语义层（prompt 约束）同时执行，双通道解耦持久化。

**Architecture:** Zustand store 维护双通道状态（layout + semantic），每条通道各自持久化与 auto/manual 控制。`useDirectorGeneration` 保持 `useShallow` 单 selector，同时传递两个方向给 pipeline。`DirectorPipeline` 在 pass6 prompt 中注入语义方向硬约束。UI 层按钮默认同时驱动双通道，正方网格场景给"拓扑不变但方向强制已应用"提示。

**Tech Stack:** React 19, Zustand 5, TypeScript, Vitest, LangGraph pipeline

**Context7 依据：**
1. Zustand slices pattern：`StateCreator<DirectorStore, [], [], ConfigSlice>` 模式新增字段。
2. Zustand persist：手动 localStorage 读写，不引入 persist 中间件。
3. React useCallback：依赖数组必须包含所有闭包引用值（`currentSemanticOrientation` 已纳入）。
4. React useShallow：多字段 selector 防止不必要重渲染。

---

> **注意**：Task 1-3 已在前一轮执行完成（Store 新增语义字段 + Hook 传参 + Pipeline prompt 注入）。  
> 以下 Task 4 起为本轮新增任务。

### Task 4: UI 双重强制交互

**Files:**
- Modify: `src/renderer/src/react-app/components/LayoutSelector.tsx`
- Test: `src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx`

**Step 1: Write the failing test**

在 `LayoutSelector.test.tsx` 新增失败用例：

```tsx
it('clicking orientation button drives both layout and semantic orientation', () => {
  const store = useDirectorStore.getState()
  store.setRatio('16:9')

  render(<LayoutSelector />)
  fireEvent.click(screen.getByRole('button', { name: /竖屏/ }))

  const state = useDirectorStore.getState()
  expect(state.currentLayoutOrientation).toBe('portrait')
  expect(state.currentSemanticOrientation).toBe('portrait')
})

it('shows topology-unchanged hint for square grids', () => {
  const store = useDirectorStore.getState()
  store.setLayout('9grid')
  store.setLayoutOrientation('portrait')

  render(<LayoutSelector />)
  expect(screen.getByText(/拓扑不变/)).toBeTruthy()
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx`  
Expected: FAIL（UI 未同时驱动双通道；未显示拓扑提示）

**Step 3: Write minimal implementation**

在 `LayoutSelector.tsx`：

- 横/竖按钮点击时同时调用 `setLayoutOrientation(val)` 和 `setSemanticOrientation(val)`。
- 新增 selector 读取 `currentSemanticOrientation`。
- 按钮 active 状态改为同时匹配 layout 和 semantic。
- 正方网格（4/9/16/25）场景下显示提示文案"方向强制已应用（拓扑不变）"。
- 非正方网格场景正常显示结构变化预览。

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/components/LayoutSelector.tsx src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx
git commit -m "feat(director-ui): dual-enforce orientation with topology-unchanged hint for square grids"
```

### Task 5: 综合回归验证

**Files:**
- All changed files from Task 1-4
- Modify: `docs/plans/2026-03-03-director-semantic-orientation-design.md` (if behavior changed)

**Step 1: Run all related tests**

Run: `npm run test:run -- src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts src/renderer/src/react-app/components/__tests__/LayoutSelector.test.tsx src/renderer/src/services/pipeline/__tests__/director-pipeline-parallel-generate.test.ts`  
Expected: ALL PASS

**Step 2: Run code quality check**

Run: `python "D:\tecx\text\.cursor\skills\code-reviewer\scripts\code_quality_checker.py" "src/renderer/src/react-app"`  
Expected: success, 0 findings

**Step 3: Lint check**

Run: ReadLints on all changed files  
Expected: No new linter errors

**Step 4: Dev smoke test**

Run: `npm run dev`，手工验证：
1. `generate -> director` 切换无 hooks/getSnapshot 报错。
2. 点击横/竖按钮，非正方网格预览结构变化。
3. 点击横/竖按钮，正方网格提示"拓扑不变但方向强制已应用"。
4. 生成后 prompt 包含语义方向约束。

**Step 5: Commit**

```bash
git add .
git commit -m "test(director): verify dual-enforce orientation flow end-to-end"
```
