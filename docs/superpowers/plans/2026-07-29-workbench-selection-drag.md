# 视频工作台：卡片选中 + 拖进聊天栏 + agent 感知 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作台卡片可多选、可拖进 codex 聊天栏把视频递给模型，并让 agent 在任何一次工作台工具调用里顺带看到当前选中了哪些卡。

**Architecture:** 选中态是纯 UI 状态，只活在 store 内存里（不落 IndexedDB、不进 IR、不进撤销栈），切页即清空。批量操作（⚡ 生成 / 删除）在**无参**时优先作用于选中项，MCP 的显式 `cardIds` 路径完全不受影响。拖拽复用文件树已有的「一次 `setData` 两个 MIME」双目标模式：旧 MIME 继续供页内排序，新 MIME 携带卡片描述符 JSON 供聊天栏消费；聊天栏投放后产出「引用 chip + 一行可见文本」，chip 指向 `card.localPath`——该目录 `<userData>/agent/uploads` 已在发送侧白名单内，无需搬运或提权。

**Tech Stack:** TypeScript + React 19 + Zustand + Vitest（jsdom）+ @testing-library/react；MCP 侧 zod schema。

**前置阅读：** 设计定稿 `docs/superpowers/specs/2026-07-29-workbench-selection-drag-design.md`；贯穿约定在 `docs/superpowers/specs/2026-07-29-workbench-insert-card-design.md` 的「贯穿约定」一节。

## Global Constraints

- 选中态**不持久化**、**不进 IR**、**不进撤销栈**。它不递增 `revision` 也不递增 `structureRevision`——那两个计数器只表达「编排意图变了」，选中不是编排。
- 选中命中区**只能是卡片头部那一行**（`#NN` 徽章与拖拽手柄所在行）。`WorkbenchCard.tsx` 926 行，卡片主体密布提示词输入、规格药丸、素材栈，整卡点选会与它们持续打架。
- `video_workbench_start` 的显式 `cardIds` 语义**不变**：agent 的行为不受用户碰巧选了几张卡影响。
- **不为「选中变化」推送任何通知。** 选中是高频操作，推送等于刷屏。agent 按需回读（`snapshotWorkbench`）。
- **不复用 `mention` 输入变体表达卡片**：该通道属于 codex 的插件注册表（`plugin://` / `app://`），塞自定义 scheme 进去语义错误，且 `text_elements` 的字节区间计算不认识未知 scheme。
- 新 MIME 词表统一放 `src/renderer/src/features/file-explorer/dragHelpers.ts`，与 `application/x-catimation-file-paths` / `-quote` 并列。
- 配色沿用工作台既有赛博朋克体系（zinc + `#FCE300`），深度用发丝线不用投影。
- 每个 Task 结束前跑一次该 Task 的测试文件，绿了再 commit。

---

### Task 1: store 选中态

**Files:**
- Modify: `src/renderer/src/features/video-workbench/store.ts`（`VideoWorkbenchState` 接口 ~250-330；`switchBoard` 796-800；`removeBoard` 825-；`removeCard` 986-1011）
- Test: `src/renderer/src/features/video-workbench/__tests__/store.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes: 无（本 Task 是地基）
- Produces:
  - `state.selectedCardIds: string[]`
  - `selectCard(id: string, mode?: 'replace' | 'toggle' | 'range'): void`（缺省 `'replace'`）
  - `clearSelection(): void`
  - `removeCards(ids: string[]): void`

- [ ] **Step 1: 写失败测试**

追加到 `src/renderer/src/features/video-workbench/__tests__/store.test.ts` 末尾：

```ts
describe('选中态', () => {
  function seed(n: number): string[] {
    return useVideoWorkbenchStore.getState().addCards(
      Array.from({ length: n }, (_, i) => ({ prompt: `p${i}` })),
    )
  }

  it('单击替换选中,Ctrl 切换,Shift 选区间', () => {
    const ids = seed(5)
    const s = () => useVideoWorkbenchStore.getState()

    s().selectCard(ids[1])
    expect(s().selectedCardIds).toEqual([ids[1]])

    s().selectCard(ids[3])
    expect(s().selectedCardIds).toEqual([ids[3]])

    s().selectCard(ids[0], 'toggle')
    expect(s().selectedCardIds).toEqual([ids[3], ids[0]])
    s().selectCard(ids[0], 'toggle')
    expect(s().selectedCardIds).toEqual([ids[3]])

    // 锚点 = 上一次 replace/toggle 命中的那张(ids[3]),区间到 ids[1]
    s().selectCard(ids[1], 'range')
    expect([...s().selectedCardIds].sort()).toEqual([ids[1], ids[2], ids[3]].sort())
  })

  it('没有锚点时 Shift 等同单击', () => {
    const ids = seed(3)
    useVideoWorkbenchStore.getState().selectCard(ids[2], 'range')
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([ids[2]])
  })

  it('选中不递增 revision / structureRevision', () => {
    const ids = seed(2)
    const before = useVideoWorkbenchStore.getState()
    const rev = before.revision
    const structRev = before.structureRevision
    before.selectCard(ids[0])
    const after = useVideoWorkbenchStore.getState()
    expect(after.revision).toBe(rev)
    expect(after.structureRevision).toBe(structRev)
  })

  it('切页清空选中', () => {
    const ids = seed(2)
    const store = useVideoWorkbenchStore.getState()
    store.selectCard(ids[0])
    const other = store.addBoard('第二页')
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([])

    useVideoWorkbenchStore.getState().selectCard(
      useVideoWorkbenchStore.getState().addCards([{ prompt: 'x' }])[0],
    )
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toHaveLength(1)
    useVideoWorkbenchStore.getState().switchBoard(other)
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([])
  })

  it('删卡把它从选中里剪掉', () => {
    const ids = seed(3)
    const store = useVideoWorkbenchStore.getState()
    store.selectCard(ids[0])
    store.selectCard(ids[1], 'toggle')
    useVideoWorkbenchStore.getState().removeCard(ids[0])
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([ids[1]])
  })

  it('removeCards 一次事务删多张,order 重新密排', () => {
    const ids = seed(4)
    useVideoWorkbenchStore.getState().removeCards([ids[0], ids[2]])
    const cards = useVideoWorkbenchStore.getState().cards
    expect(cards.map((c) => c.id)).toEqual([ids[1], ids[3]])
    expect(cards.map((c) => c.order)).toEqual([0, 1])
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([])
  })

  it('removeCards 只让 structureRevision 走一格', () => {
    const ids = seed(3)
    const structRev = useVideoWorkbenchStore.getState().structureRevision
    useVideoWorkbenchStore.getState().removeCards([ids[0], ids[1]])
    expect(useVideoWorkbenchStore.getState().structureRevision).toBe(structRev + 1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t 选中态`
Expected: FAIL，报 `selectCard is not a function`。

- [ ] **Step 3: 实现**

3a. 在 `VideoWorkbenchState` 接口里，紧跟 `structureRevision` 那段注释之后加字段声明：

```ts
  /**
   * 当前选中的卡片 id。**纯 UI 状态**:不落库、不进 IR、不进撤销栈,
   * 也刻意不递增 revision / structureRevision —— 那两个计数器表达
   * 「编排意图变了」,选中不是编排意图。切页清空。
   */
  selectedCardIds: string[]
  /**
   * Shift 区间选的锚点(上一次 replace/toggle 命中的那张)。与 selectedCardIds
   * 同样是 UI 状态。锚点卡被删掉后置空,区间选退化成单击。
   */
  selectionAnchorId?: string
```

3b. 在 action 声明区（`moveCard` 附近）加：

```ts
  /**
   * 选中卡片。
   * - `'replace'`(缺省):只选这张。
   * - `'toggle'`:Ctrl/Cmd 加选,已选则取消。
   * - `'range'`:Shift 区间选,从锚点到该卡(同页内,按当前显示序)。无锚点时等同单击。
   */
  selectCard: (id: string, mode?: 'replace' | 'toggle' | 'range') => void
  clearSelection: () => void
  /** 批量删卡:一次事务,structureRevision 只走一格(逐张调 removeCard 会走 N 格 + N 条撤销)。 */
  removeCards: (ids: string[]) => void
```

3c. 在 store 初始值区（`activeBoardId: initialBoard.id` 附近，约 690 行）加：

```ts
  selectedCardIds: [],
  selectionAnchorId: undefined,
```

3d. 实现三个 action。放在 `moveCard` 之后：

```ts
  selectCard: (id, mode = 'replace') => {
    const state = get()
    if (!state.cards.some((c) => c.id === id)) return

    if (mode === 'replace') {
      set({ selectedCardIds: [id], selectionAnchorId: id })
      return
    }
    if (mode === 'toggle') {
      const has = state.selectedCardIds.includes(id)
      set({
        selectedCardIds: has
          ? state.selectedCardIds.filter((x) => x !== id)
          : [...state.selectedCardIds, id],
        // 取消勾选时锚点跟着走开,否则下一次 Shift 会从一张没选的卡起算
        selectionAnchorId: has ? undefined : id,
      })
      return
    }

    const anchor = state.selectionAnchorId
    if (!anchor) {
      set({ selectedCardIds: [id], selectionAnchorId: id })
      return
    }
    // 区间限定在目标卡所在页内。跨页区间没有意义:页与页在 UI 上根本不同屏。
    const target = state.cards.find((c) => c.id === id)!
    const boardCards = state.cards.filter((c) => c.boardId === target.boardId)
    const from = boardCards.findIndex((c) => c.id === anchor)
    const to = boardCards.findIndex((c) => c.id === id)
    if (from < 0) {
      set({ selectedCardIds: [id], selectionAnchorId: id })
      return
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    set({
      selectedCardIds: boardCards.slice(lo, hi + 1).map((c) => c.id),
      // 锚点保持不动:连续 Shift 点击要能反复从同一头拉伸区间
      selectionAnchorId: anchor,
    })
  },

  clearSelection: () => {
    if (get().selectedCardIds.length === 0 && !get().selectionAnchorId) return
    set({ selectedCardIds: [], selectionAnchorId: undefined })
  },

  removeCards: (ids) => {
    const gone = new Set(ids)
    const boardIds = new Set<string>()
    let removed: VideoWorkbenchCard[] = []
    set((state) => {
      removed = state.cards.filter((c) => gone.has(c.id))
      if (removed.length === 0) return {}
      for (const c of removed) if (c.boardId) boardIds.add(c.boardId)
      let cards = state.cards.filter((c) => !gone.has(c.id))
      for (const boardId of boardIds) cards = reorderBoard(cards, boardId)
      return {
        cards,
        selectedCardIds: state.selectedCardIds.filter((x) => !gone.has(x)),
        selectionAnchorId: gone.has(state.selectionAnchorId ?? '')
          ? undefined
          : state.selectionAnchorId,
        revision: state.revision + 1,
        structureRevision: state.structureRevision + 1,
      }
    })
    if (removed.length === 0) return
    const db = getWorkbenchDb()
    for (const card of removed) {
      const timer = persistTimers.get(card.id)
      if (timer) {
        clearTimeout(timer)
        persistTimers.delete(card.id)
      }
      void db.remove(card.id).catch(() => {})
    }
    // 兄弟卡 order 变了,补写受影响的那几页 —— 别把整个工作台重写一遍。
    for (const card of get().cards) {
      if (card.boardId && boardIds.has(card.boardId)) schedulePersist(card)
    }
  },
```

3e. `switchBoard`（796-800）加清空：

```ts
  switchBoard: (id) => {
    if (!get().boards.some((b) => b.id === id)) return
    // 选中是当前页的语境,切页必须清 —— 否则 ⚡ 会去生成另一页上看不见的卡。
    set({ activeBoardId: id, selectedCardIds: [], selectionAnchorId: undefined })
    writeActiveBoard(id)
  },
```

3f. `addBoard`（783-788 那个 `set`）里补 `selectedCardIds: [], selectionAnchorId: undefined,`——它也切了 `activeBoardId`。

3g. `removeCard`（986 起）的 `set` 返回值里补剪枝：

```ts
      return {
        cards: reorderBoard(state.cards.filter((c) => c.id !== id), removed.boardId),
        selectedCardIds: state.selectedCardIds.filter((x) => x !== id),
        selectionAnchorId: state.selectionAnchorId === id ? undefined : state.selectionAnchorId,
        revision: state.revision + 1,
        structureRevision: state.structureRevision + 1,
      }
```

3h. `removeBoard`（833 那个 `set`）同样补 `selectedCardIds: [], selectionAnchorId: undefined,`——整页卡片都没了。

3i. `resetWorkbenchStoreForTest` 里把两个字段一起复位（搜 `resetWorkbenchStoreForTest`，在它 `set` 的对象里加 `selectedCardIds: [], selectionAnchorId: undefined,`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts`
Expected: PASS，全文件绿（含原有用例无回归）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/__tests__/store.test.ts
git commit -m "feat(workbench): store 选中态,单击/加选/区间选与批量删"
```

---

### Task 2: 批量操作作用于选中项 + 工具条文案

**Files:**
- Modify: `src/renderer/src/features/video-workbench/store.ts`（`startCards` 1108-1126 的目标筛选）
- Modify: `src/renderer/src/pages-react/VideoWorkbenchPage.tsx`（工具条 126-140）
- Test: `src/renderer/src/features/video-workbench/__tests__/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `state.selectedCardIds`、`removeCards(ids)`
- Produces: `startCards()` 无参时的新语义（有选中 → 选中项；无选中 → 当前整页）

- [ ] **Step 1: 写失败测试**

追加到 `store.test.ts`：

```ts
describe('无参批量操作吃选中态', () => {
  it('有选中时 startCards() 只启动选中项', async () => {
    const submit = mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([
      { prompt: 'a' },
      { prompt: 'b' },
      { prompt: 'c' },
    ])
    useVideoWorkbenchStore.getState().selectCard(ids[1])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toEqual([ids[1]])
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('无选中时 startCards() 维持整页', async () => {
    mockSubmit()
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toHaveLength(2)
  })

  it('显式 cardIds 无视选中 —— MCP 路径不受用户选中影响', async () => {
    mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    useVideoWorkbenchStore.getState().selectCard(ids[0])
    const result = await useVideoWorkbenchStore.getState().startCards([ids[1]])
    expect(result.started).toEqual([ids[1]])
  })

  it('选中项在别的页时仍只启动选中项', async () => {
    mockSubmit()
    const first = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }])
    const other = useVideoWorkbenchStore.getState().addBoard('第二页')
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'b' }])
    useVideoWorkbenchStore.getState().switchBoard(other)
    // 切页已清空选中,这里手动选回第一页那张,模拟「选中与活动页不一致」
    useVideoWorkbenchStore.getState().selectCard(first[0])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toEqual([first[0]])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t 无参批量操作吃选中态`
Expected: FAIL——第一个用例会启动 3 张而不是 1 张。

- [ ] **Step 3: 实现**

3a. `startCards`（1118-1121）改目标筛选：

```ts
    // 优先级:显式 ids > 用户选中 > 当前整页。
    //
    // 「有选中就只作用于选中」是 UI 侧的期待;MCP 走的是显式 ids 分支,不受影响 ——
    // agent 不该因为用户碰巧选了几张卡就改变行为。
    const selected = get().selectedCardIds
    const scope: string[] | undefined = ids ?? (selected.length > 0 ? selected : undefined)
    const targets = get().cards.filter((c) =>
      scope ? scope.includes(c.id) : c.boardId === get().activeBoardId,
    )
    if (scope) {
      for (const id of scope) {
        if (!targets.some((c) => c.id === id)) result.skipped.push({ cardId: id, reason: '卡片不存在' })
      }
    }
```

同时把下面 `if (ids || gate.reason !== '提示词为空')` 改成 `if (scope || gate.reason !== '提示词为空')`——选中一张空白草稿再点⚡，用户理应看到「提示词为空」而不是静默无事发生。

再把 1112 行那个 API 缺失的早退分支改为用同一个 scope（避免它仍按 `ids` 判断）：

```ts
    if (!api?.submit) {
      const selected = get().selectedCardIds
      const scope = ids ?? (selected.length > 0 ? selected : get().cards.map((c) => c.id))
      for (const id of scope) {
        result.skipped.push({ cardId: id, reason: '视频服务未就绪(preload 桥缺失)' })
      }
      return result
    }
```

3b. `VideoWorkbenchPage.tsx` 取选中态。在 `const startCards = ...` 附近加：

```ts
  const selectedCardIds = useVideoWorkbenchStore((s) => s.selectedCardIds)
  const clearSelection = useVideoWorkbenchStore((s) => s.clearSelection)
  const removeCards = useVideoWorkbenchStore((s) => s.removeCards)
```

3c. 工具条（126-133）改文案，并在有选中时插入删除按钮：

```tsx
            <button
              type="button"
              className="text-xs border border-[#3F3F46] text-white/70 hover:border-[#FCE300] hover:text-[#FCE300] px-3 py-2 transition-colors disabled:opacity-40"
              disabled={startableCount === 0}
              onClick={() => void startCards()}
            >
              {/* 文案必须随选中态变 —— 否则用户会以为点的是「全部生成」而烧掉一批额度 */}
              {selectedCardIds.length > 0
                ? `⚡ 生成选中 ${selectedCardIds.length} 张`
                : `⚡ 全部生成${startableCount > 0 ? `(${startableCount})` : ''}`}
            </button>
            {selectedCardIds.length > 0 && (
              <button
                type="button"
                className="text-xs border border-[#3F3F46] text-white/70 hover:border-red-500 hover:text-red-400 px-3 py-2 transition-colors"
                onClick={() => removeCards(selectedCardIds)}
              >
                🗑 删除选中 {selectedCardIds.length} 张
              </button>
            )}
            {selectedCardIds.length > 0 && (
              <button
                type="button"
                className="text-xs text-white/40 hover:text-white/70 px-2 py-2 transition-colors"
                onClick={clearSelection}
              >
                取消选中
              </button>
            )}
```

> `startableCount` 今天按当前页算。有选中时按钮文案已不再显示它，所以不需要改它的算法。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts`
Expected: PASS。

再跑页面测试确认工具条没炸：
Run: `npx vitest run src/renderer/src/pages-react/video-workbench`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/__tests__/store.test.ts src/renderer/src/pages-react/VideoWorkbenchPage.tsx
git commit -m "feat(workbench): 无参批量操作作用于选中项,按钮文案随之变化"
```

---

### Task 3: 卡片头部命中区 + 选中态边框

**Files:**
- Modify: `src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx`（外层容器 className ~430-441；头部行 462-463）
- Test: `src/renderer/src/pages-react/video-workbench/__tests__/WorkbenchCard.selection.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `selectCard(id, mode)`、`state.selectedCardIds`
- Produces: 头部行的 `data-testid="vw-card-header"` 点击区；选中卡外层带 `border-[#FCE300]`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/src/pages-react/video-workbench/__tests__/WorkbenchCard.selection.test.tsx`：

```tsx
// 头部行点选:单击 / Ctrl 加选 / Shift 区间,以及「点主体不改变选中」这条防误选守卫。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkbenchCard } from '../WorkbenchCard'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})
afterEach(cleanup)

function renderCards(n: number): string[] {
  const ids = useVideoWorkbenchStore.getState().addCards(
    Array.from({ length: n }, (_, i) => ({ prompt: `p${i}` })),
  )
  const cards = useVideoWorkbenchStore.getState().cards
  render(
    <>
      {cards.map((card, i) => (
        <WorkbenchCard key={card.id} card={card} index={i} onDragStateChange={() => {}} />
      ))}
    </>,
  )
  return ids
}

describe('WorkbenchCard 头部点选', () => {
  it('单击头部选中该卡', () => {
    const ids = renderCards(2)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([ids[0]])
  })

  it('Ctrl 单击加选', () => {
    const ids = renderCards(2)
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[1], { ctrlKey: true })
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([ids[0], ids[1]])
  })

  it('Shift 单击选区间', () => {
    const ids = renderCards(3)
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[2], { shiftKey: true })
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual(ids)
  })

  it('点卡片主体的提示词输入框不改变选中(防误选守卫)', () => {
    renderCards(1)
    const before = useVideoWorkbenchStore.getState().selectedCardIds
    const editor = document.querySelector('[contenteditable], textarea')
    expect(editor).toBeTruthy()
    fireEvent.click(editor!)
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual(before)
  })
})
```

> 如果 `WorkbenchCard` 的 props 与上面不一致（`index` / `onDragStateChange`），照 `VideoWorkbenchPage.tsx` 里的实际调用抄一份。别改组件签名来迁就测试。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench/__tests__/WorkbenchCard.selection.test.tsx`
Expected: FAIL，`Unable to find an element by: [data-testid="vw-card-header"]`。

- [ ] **Step 3: 实现**

3a. 组件内取选中态（放在其它 store 订阅旁）：

```ts
  const selected = useVideoWorkbenchStore((s) => s.selectedCardIds.includes(card.id))
  const selectCard = useVideoWorkbenchStore((s) => s.selectCard)
```

3b. 头部行（463）加点击处理与 testid：

```tsx
      {/* 头部:序号 + 拖拽手柄 + 状态徽标 + 删除。
          这一行同时是**唯一**的选中命中区 —— 卡片主体密布输入框与药丸,整卡点选会和它们打架。 */}
      <div
        data-testid="vw-card-header"
        className="flex items-center gap-2 px-4 pt-3"
        onClick={(e) => {
          // 头部行里那几个按钮(删除等)自己 stopPropagation 不现实,统一按 tag 放行
          if ((e.target as HTMLElement).closest('button')) return
          selectCard(card.id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace')
        }}
      >
```

3c. 外层容器 className 数组（430-440）里，把选中表达成边框高亮。找到那个 `[...].join(' ')`，在数组里追加一项：

```ts
        selected ? 'border-[#FCE300]' : '',
```

> 若外层已有 `border-[#3F3F46]` 之类的固定边框色，Tailwind 里后写的同属性类会赢，追加即可；实现时确认一下类名顺序（数组末尾追加就是后写）。选中**只改边框色**，不加投影、不加背景填充——不能遮挡内容。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench`
Expected: PASS（新文件 4 条 + 原有卡片测试无回归）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx src/renderer/src/pages-react/video-workbench/__tests__/WorkbenchCard.selection.test.tsx
git commit -m "feat(workbench): 卡片头部行点选,选中用边框高亮"
```

---

### Task 4: 拖拽载荷 —— 新 MIME + 多选拖拽

**Files:**
- Modify: `src/types/videoWorkbench.ts`（新增 `VideoWorkbenchCardDragItem`）
- Modify: `src/renderer/src/features/file-explorer/dragHelpers.ts`（新 MIME + 序列化/解析）
- Modify: `src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx`（拖拽手柄 `onDragStart` 468-473）
- Test: `src/renderer/src/features/file-explorer/__tests__/dragHelpers.workbench.test.ts`（新建）
- Test: `src/renderer/src/pages-react/video-workbench/__tests__/WorkbenchCard.selection.test.tsx`（追加拖拽用例）

**Interfaces:**
- Consumes: Task 1 的 `state.selectedCardIds`
- Produces:
  - `VideoWorkbenchCardDragItem { cardId, promptExcerpt, status, localPath?, remoteUrl? }`
  - `serializeWorkbenchCardDrag(dt: DataTransfer, items: VideoWorkbenchCardDragItem[]): void`
  - `parseWorkbenchCardDrop(dt: DataTransfer): VideoWorkbenchCardDragItem[]`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/src/features/file-explorer/__tests__/dragHelpers.workbench.test.ts`：

```ts
// 工作台卡片拖拽载荷的往返。DataTransfer 在 jsdom 里不完整,用最小替身。

import { describe, expect, it } from 'vitest'
import {
  parseWorkbenchCardDrop,
  serializeWorkbenchCardDrag,
} from '../dragHelpers'
import type { VideoWorkbenchCardDragItem } from '../../../../types/videoWorkbench'

function fakeDt(): DataTransfer {
  const store = new Map<string, string>()
  return {
    setData: (t: string, v: string) => void store.set(t, v),
    getData: (t: string) => store.get(t) ?? '',
    get types() {
      return [...store.keys()]
    },
  } as unknown as DataTransfer
}

const item: VideoWorkbenchCardDragItem = {
  cardId: 'c1',
  promptExcerpt: '一只猫跳上桌子',
  status: 'succeeded',
  localPath: 'C:/u/agent/uploads/a.mp4',
}

describe('工作台卡片拖拽载荷', () => {
  it('序列化后能无损解回', () => {
    const dt = fakeDt()
    serializeWorkbenchCardDrag(dt, [item, { ...item, cardId: 'c2', localPath: undefined }])
    const parsed = parseWorkbenchCardDrop(dt)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual(item)
    expect(parsed[1].localPath).toBeUndefined()
  })

  it('顺带写 text/plain 兜底,外部目标也看得见', () => {
    const dt = fakeDt()
    serializeWorkbenchCardDrag(dt, [item])
    expect(dt.getData('text/plain')).toContain('一只猫跳上桌子')
  })

  it('空列表不写任何 MIME', () => {
    const dt = fakeDt()
    serializeWorkbenchCardDrag(dt, [])
    expect(dt.types).toEqual([])
  })

  it('非本词表的拖拽解出空数组', () => {
    expect(parseWorkbenchCardDrop(fakeDt())).toEqual([])
  })

  it('载荷损坏时解出空数组而不是抛错', () => {
    const dt = fakeDt()
    dt.setData('application/x-catimation-workbench-cards', '{ 不是 JSON')
    expect(parseWorkbenchCardDrop(dt)).toEqual([])
  })
})
```

追加到 `WorkbenchCard.selection.test.tsx`：

```tsx
describe('WorkbenchCard 拖拽载荷', () => {
  function fakeDataTransfer(): DataTransfer {
    const store = new Map<string, string>()
    return {
      setData: (t: string, v: string) => void store.set(t, v),
      getData: (t: string) => store.get(t) ?? '',
      get types() {
        return [...store.keys()]
      },
      effectAllowed: 'none',
    } as unknown as DataTransfer
  }

  it('同时写旧 MIME(排序)与新 MIME(聊天栏)', () => {
    const ids = renderCards(1)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getAllByTitle('拖动排序')[0], { dataTransfer })
    expect(dataTransfer.getData('application/x-vw-card')).toBe(ids[0])
    expect(JSON.parse(dataTransfer.getData('application/x-catimation-workbench-cards'))).toHaveLength(1)
    expect(dataTransfer.effectAllowed).toBe('copyMove')
  })

  it('拖一张已选中的卡 = 拖全部选中项', () => {
    const ids = renderCards(3)
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[2], { ctrlKey: true })

    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getAllByTitle('拖动排序')[0], { dataTransfer })
    const payload = JSON.parse(dataTransfer.getData('application/x-catimation-workbench-cards'))
    expect(payload.map((p: { cardId: string }) => p.cardId)).toEqual([ids[0], ids[2]])
    // 旧 MIME 仍只带被拖那一张 —— 页内排序语义不变
    expect(dataTransfer.getData('application/x-vw-card')).toBe(ids[0])
  })

  it('拖一张未选中的卡只带它自己', () => {
    const ids = renderCards(3)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])

    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(screen.getAllByTitle('拖动排序')[2], { dataTransfer })
    const payload = JSON.parse(dataTransfer.getData('application/x-catimation-workbench-cards'))
    expect(payload.map((p: { cardId: string }) => p.cardId)).toEqual([ids[2]])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/file-explorer/__tests__/dragHelpers.workbench.test.ts`
Expected: FAIL，`serializeWorkbenchCardDrag is not exported`。

- [ ] **Step 3: 实现**

3a. `src/types/videoWorkbench.ts` 新增（放在 `VideoWorkbenchInsertAnchor` 之后）：

```ts
/**
 * 拖进聊天栏的卡片描述符。**只带模型与 UI 需要的字段**,不整卡序列化 ——
 * 卡片上的 referenceImages 可能是 data: URL,塞进 DataTransfer 会瞬间膨胀。
 *
 * `promptExcerpt` 是给人看的识别锚(贯穿约定:人靠提示词摘录认卡,agent 靠 cardId)。
 */
export interface VideoWorkbenchCardDragItem {
  cardId: string
  /** 提示词摘录,已截断。空提示词的草稿卡给空串。 */
  promptExcerpt: string
  status: VideoWorkbenchCardStatus
  /** 本地产物路径。在 `<userData>/agent/uploads` 下,天然在发送侧白名单内。 */
  localPath?: string
  /** 耐久源。localPath 被 7 天清理扫掉后只剩它。 */
  remoteUrl?: string
}
```

3b. `dragHelpers.ts` 顶部词表加一项，文件末尾加两个函数：

```ts
const WORKBENCH_CARD_TYPE = 'application/x-catimation-workbench-cards'
```

```ts
/**
 * 工作台卡片 → 聊天栏。与页内排序用的 `application/x-vw-card`(裸 id)并存:
 * 一次 dragStart 写两个 MIME,各自的消费者只认自己那个,互不干扰
 * (FileTreeNode 的双目标拖拽是同款先例)。
 *
 * `text/plain` 兜底让外部目标(编辑器、终端)也能看到点东西。
 */
export function serializeWorkbenchCardDrag(
  dt: DataTransfer,
  items: VideoWorkbenchCardDragItem[],
): void {
  if (items.length === 0) return
  dt.setData(WORKBENCH_CARD_TYPE, JSON.stringify(items))
  dt.setData('text/plain', items.map((i) => i.promptExcerpt || i.cardId).join('\n'))
}

/** 总是返回数组(可能为空),调用方不必判空。载荷损坏按「没有卡片」处理。 */
export function parseWorkbenchCardDrop(dt: DataTransfer): VideoWorkbenchCardDragItem[] {
  const raw = dt.getData(WORKBENCH_CARD_TYPE)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((x) => x && typeof x.cardId === 'string')) {
      return parsed as VideoWorkbenchCardDragItem[]
    }
  } catch {
    return []
  }
  return []
}
```

顶部补 import：

```ts
import type { VideoWorkbenchCardDragItem } from '../../../types/videoWorkbench'
```

> 确认相对层级：`dragHelpers.ts` 在 `src/renderer/src/features/file-explorer/`，到 `src/types/` 是 `../../../types/videoWorkbench`（同目录下其它文件怎么写就照抄）。

3c. `WorkbenchCard.tsx` 的 `onDragStart`（468-473）改为双写：

```tsx
          onDragStart={(e) => {
            // 旧 MIME:页内排序,只认被拖那一张,语义不变。
            e.dataTransfer.setData(CARD_DRAG_MIME, card.id)
            // 新 MIME:聊天栏。拖一张已选中的卡 = 拖全部选中项(与文件树多选拖拽一致)。
            const { cards, selectedCardIds } = useVideoWorkbenchStore.getState()
            const payloadIds = selectedCardIds.includes(card.id) ? selectedCardIds : [card.id]
            serializeWorkbenchCardDrag(
              e.dataTransfer,
              payloadIds
                .map((id) => cards.find((c) => c.id === id))
                .filter((c): c is VideoWorkbenchCard => Boolean(c))
                .map((c) => ({
                  cardId: c.id,
                  promptExcerpt: c.prompt.slice(0, 60),
                  status: c.status,
                  localPath: c.localPath,
                  remoteUrl: c.remoteUrl,
                })),
            )
            // 'move' 会让聊天栏那侧拿不到 copy 效果 —— 双目标必须 copyMove。
            e.dataTransfer.effectAllowed = 'copyMove'
            setDragging(true)
            onDragStateChange(true)
          }}
```

补 import：

```ts
import { serializeWorkbenchCardDrag } from '../../features/file-explorer/dragHelpers'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
```

> `VideoWorkbenchCard` 若文件里已 import 过就别重复。`serializeWorkbenchCardDrag` 的相对路径照该文件里现有的 `../../features/...` import 写法抄。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/file-explorer src/renderer/src/pages-react/video-workbench`
Expected: PASS（含文件树原有拖拽测试无回归）。

- [ ] **Step 5: Commit**

```bash
git add src/types/videoWorkbench.ts src/renderer/src/features/file-explorer/dragHelpers.ts src/renderer/src/features/file-explorer/__tests__/dragHelpers.workbench.test.ts src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx src/renderer/src/pages-react/video-workbench/__tests__/WorkbenchCard.selection.test.tsx
git commit -m "feat(workbench): 卡片拖拽带上聊天栏可消费的描述符,多选整批拖"
```

---

### Task 5: 聊天栏投放分支 + 悬停反馈

**Files:**
- Modify: `src/renderer/src/features/agent-chat/MentionInput.tsx`（`onDrop` 991-997 加分支；`form` 的 `onDragOver` 1205）
- Test: `src/renderer/src/features/agent-chat/__tests__/MentionInput.workbenchDrop.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 4 的 `parseWorkbenchCardDrop`、`VideoWorkbenchCardDragItem`；既有 `attachFileByPath(filePath, name)`、`appendInput(text)`、`setError(msg)`
- Produces: 无（终端消费者）

- [ ] **Step 1: 写失败测试**

Create `src/renderer/src/features/agent-chat/__tests__/MentionInput.workbenchDrop.test.tsx`：

```tsx
// 工作台卡片投放到聊天栏:引用 chip + 一行可见文本;无 localPath 退到 remoteUrl 并如实提示。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

function fakeDataTransfer(items: unknown[]): DataTransfer {
  const store = new Map<string, string>([
    ['application/x-catimation-workbench-cards', JSON.stringify(items)],
  ])
  return {
    setData: (t: string, v: string) => void store.set(t, v),
    getData: (t: string) => store.get(t) ?? '',
    get types() {
      return [...store.keys()]
    },
    files: [] as unknown as FileList,
  } as unknown as DataTransfer
}

beforeEach(() => {
  useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [], error: null })
  ;(window as any).electronAPI = {
    fs: { stat: vi.fn(async () => ({ ok: true, size: 1024, mime: 'video/mp4' })) },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).electronAPI
})

describe('工作台卡片投放到聊天栏', () => {
  it('有 localPath:产出引用 chip + 可见信息行', async () => {
    render(<MentionInput />)
    fireEvent.drop(screen.getByRole('textbox'), {
      dataTransfer: fakeDataTransfer([
        {
          cardId: 'c1',
          promptExcerpt: '一只猫跳上桌子',
          status: 'succeeded',
          localPath: 'C:/u/agent/uploads/a.mp4',
        },
      ]),
    })
    await waitFor(() => {
      expect(useAgentChatStore.getState().pendingReferences).toHaveLength(1)
    })
    expect(useAgentChatStore.getState().attachments).toHaveLength(1)
    // cardId 必须出现在可见文本里 —— 模型要靠它调工具
    expect(useAgentChatStore.getState().input).toContain('c1')
    expect(useAgentChatStore.getState().input).toContain('一只猫跳上桌子')
  })

  it('只有 remoteUrl:不产 chip,如实提示仅传了链接', async () => {
    render(<MentionInput />)
    fireEvent.drop(screen.getByRole('textbox'), {
      dataTransfer: fakeDataTransfer([
        {
          cardId: 'c2',
          promptExcerpt: '雨夜街道',
          status: 'succeeded',
          remoteUrl: 'https://cdn.example.com/b.mp4',
        },
      ]),
    })
    await waitFor(() => {
      expect(useAgentChatStore.getState().input).toContain('https://cdn.example.com/b.mp4')
    })
    expect(useAgentChatStore.getState().pendingReferences).toHaveLength(0)
    expect(useAgentChatStore.getState().error).toContain('仅传了链接')
  })

  it('草稿卡:只产信息行,不产 chip 也不报错', async () => {
    render(<MentionInput />)
    fireEvent.drop(screen.getByRole('textbox'), {
      dataTransfer: fakeDataTransfer([
        { cardId: 'c3', promptExcerpt: '还没生成', status: 'draft' },
      ]),
    })
    await waitFor(() => {
      expect(useAgentChatStore.getState().input).toContain('c3')
    })
    expect(useAgentChatStore.getState().pendingReferences).toHaveLength(0)
    expect(useAgentChatStore.getState().error).toBeNull()
  })

  it('多张一次投放,每张一行', async () => {
    render(<MentionInput />)
    fireEvent.drop(screen.getByRole('textbox'), {
      dataTransfer: fakeDataTransfer([
        { cardId: 'c1', promptExcerpt: 'a', status: 'succeeded', localPath: 'C:/u/agent/uploads/a.mp4' },
        { cardId: 'c2', promptExcerpt: 'b', status: 'succeeded', localPath: 'C:/u/agent/uploads/b.mp4' },
      ]),
    })
    await waitFor(() => {
      expect(useAgentChatStore.getState().pendingReferences).toHaveLength(2)
    })
    expect(useAgentChatStore.getState().input.split('\n').filter(Boolean)).toHaveLength(2)
  })
})
```

> `MentionInput` 的 props 若为必填，照 `agent-chat` 目录里现有测试的渲染方式抄一份 wrapper。`screen.getByRole('textbox')` 若命中多个，改用 `getAllByRole('textbox')[0]` 或该文件里现有测试用的选择器。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/MentionInput.workbenchDrop.test.tsx`
Expected: FAIL——`pendingReferences` 仍为 0，投放被当成「无候选文件」直接返回。

- [ ] **Step 3: 实现**

3a. `MentionInput.tsx` 顶部 import 补：

```ts
import { parseFileDrop, parseQuoteDrop, parseWorkbenchCardDrop } from '../file-explorer/dragHelpers'
```

3b. `onDrop`（991）在 quote 分支之后插入工作台分支：

```ts
    // 工作台卡片。放在 quote 之后、文件之前:卡片拖拽也会写 text/plain 兜底,
    // 若让文件分支先跑会把它当成路径去 stat。
    const droppedCards = parseWorkbenchCardDrop(event.dataTransfer)
    if (droppedCards.length > 0) {
      await dropWorkbenchCards(droppedCards)
      return
    }
```

3c. 在 `attachFileByPath` 之后新增处理函数：

```ts
  /**
   * 工作台卡片 → 聊天栏。每张卡产出两样东西:
   *
   * 1. 视频引用 chip —— 指向 card.localPath。该目录 `<userData>/agent/uploads`
   *    已在发送侧白名单(mapReferencesToInputItems)内,直接引用即可,无需搬运。
   * 2. 一行**可见文本** —— 提示词摘录 + cardId。可见而非隐藏前缀:用户看得见
   *    自己递过去了什么;cardId 让模型能拿它去调 video_workbench_* 工具。
   *
   * 降级:localPath 被 7 天清理扫掉时退到 remoteUrl。但 **.mp4 既不算图片也不算
   * 音频**,URL 引用在 mapReferencesToInputItems 里会产出空结果 —— 那样模型只会
   * 看到一个链接而拿不到视频内容,所以必须如实提示,不能假装附上了。
   */
  async function dropWorkbenchCards(items: VideoWorkbenchCardDragItem[]): Promise<void> {
    const lines: string[] = []
    const linkOnly: string[] = []
    for (const item of items) {
      const label = item.promptExcerpt || '(空提示词)'
      if (item.localPath) {
        const name = item.localPath.split(/[\\/]/).pop() ?? item.localPath
        const skip = await attachFileByPath(item.localPath, name)
        if (skip) {
          lines.push(`工作台卡片 ${item.cardId}「${label}」— 视频未附上:${skip}`)
          continue
        }
        lines.push(`工作台卡片 ${item.cardId}「${label}」`)
        continue
      }
      if (item.remoteUrl) {
        lines.push(`工作台卡片 ${item.cardId}「${label}」视频链接:${item.remoteUrl}`)
        linkOnly.push(item.cardId)
        continue
      }
      lines.push(`工作台卡片 ${item.cardId}「${label}」— ${statusLabel(item.status)},暂无视频`)
    }
    if (lines.length > 0) appendInput(lines.join('\n'))
    if (linkOnly.length > 0) {
      setError(`${linkOnly.length} 张卡的本地视频已被清理,仅传了链接,未附视频内容`)
    }
  }
```

3d. 状态文案小工具（放在组件外，模块作用域）：

```ts
function statusLabel(status: VideoWorkbenchCardStatus): string {
  switch (status) {
    case 'draft':
      return '草稿'
    case 'preparing':
      return '准备中'
    case 'queued':
      return '排队中'
    case 'running':
      return '渲染中'
    case 'succeeded':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default: {
      const never: never = status
      return never
    }
  }
}
```

补 import：

```ts
import type {
  VideoWorkbenchCardDragItem,
  VideoWorkbenchCardStatus,
} from '../../../types/videoWorkbench'
```

> `default` 分支的 `never` 检查是仓库教条（`typescript-exhaustive-switch`）：以后给卡片加状态时这里会编译失败，逼人来补文案。若 `VideoWorkbenchCardStatus` 的成员与上面不完全一致，照类型定义补齐——**别删 never 分支**。

3e. 悬停反馈。聊天栏今天 `onDragOver` 只调了 `preventDefault`，用户不知道能往哪儿放。加一个投放高亮：

```tsx
  const [dropActive, setDropActive] = useState(false)
```

```tsx
    <form
      onDragOver={(event) => {
        event.preventDefault()
        if (!dropActive) setDropActive(true)
      }}
      onDragLeave={(event) => {
        // 只在真正离开表单时收起 —— 掠过子元素也会冒泡出 dragleave
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false)
      }}
      onDrop={(event) => {
        setDropActive(false)
        void onDrop(event)
      }}
```

并在 form 的 className 里追加 `dropActive ? 'ring-1 ring-[#FCE300]' : ''`（发丝线级高亮，不加投影）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/agent-chat`
Expected: PASS（新文件 4 条 + agent-chat 既有套件无新增失败）。

> agent-chat 目录有**预存**失败（Lightbox / AttachmentCard / bootstrap / parseUnifiedDiff）。跑之前先在干净 `origin/main` 上记一次基线数字，只比较差值，别把预存失败算成回归。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-chat/MentionInput.tsx src/renderer/src/features/agent-chat/__tests__/MentionInput.workbenchDrop.test.tsx
git commit -m "feat(agent-chat): 工作台卡片可拖进聊天栏,产出引用 chip 与可见信息行"
```

---

### Task 6: agent 感知选中态

**Files:**
- Modify: `src/renderer/src/features/video-workbench/store.ts`（`WorkbenchSummary` 202-206；`snapshotWorkbench` 208-235）
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`（`workbenchSummarySchema` 72-76）
- Test: `src/renderer/src/features/video-workbench/__tests__/store.test.ts`
- Test: `src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `state.selectedCardIds`
- Produces: `WorkbenchSummary.selectedCardIds: string[]`（所有工作台工具的返回都带上）

- [ ] **Step 1: 写失败测试**

追加到 `store.test.ts`：

```ts
describe('摘要带出选中态', () => {
  it('snapshotWorkbench 回带 selectedCardIds', () => {
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    useVideoWorkbenchStore.getState().selectCard(ids[1])
    const summary = snapshotWorkbench(useVideoWorkbenchStore.getState())
    expect(summary.selectedCardIds).toEqual([ids[1]])
  })

  it('没有选中时是空数组而不是缺字段', () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }])
    expect(snapshotWorkbench(useVideoWorkbenchStore.getState()).selectedCardIds).toEqual([])
  })
})
```

追加到 `src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`（照该文件现有 schema 断言的写法）：

```ts
  it('摘要 schema 接受 selectedCardIds', () => {
    const parsed = workbenchSummarySchemaForTest.safeParse({
      activeBoardId: 'b1',
      boards: [{ id: 'b1', name: '页面 1', cardCount: 2 }],
      statusCounts: { draft: 1, preparing: 0, queued: 0, running: 0, succeeded: 1, failed: 0 },
      selectedCardIds: ['c1'],
    })
    expect(parsed.success).toBe(true)
  })
```

> 该文件如果没有导出 schema 给测试用，就换成走一次真实工具调用并断言返回里含 `selectedCardIds`——照文件里现有用例的调用方式抄，别为测试新开导出口子。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t 摘要带出选中态`
Expected: FAIL，`summary.selectedCardIds` 是 `undefined`。

- [ ] **Step 3: 实现**

3a. `WorkbenchSummary` 加字段：

```ts
export interface WorkbenchSummary {
  activeBoardId: string
  boards: WorkbenchBoardBrief[]
  statusCounts: WorkbenchStatusCounts
  /**
   * 用户当前在 UI 里选中的卡片。**按需回读,不主动推送** —— 选中是高频操作,
   * 推送等于刷屏。任何一次工作台工具调用都会顺带带出它。
   *
   * 别把它当成「该对哪些卡动手」的指令:agent 的目标卡永远由参数显式给出。
   */
  selectedCardIds: string[]
}
```

3b. `snapshotWorkbench` 的入参类型与返回值：

```ts
export function snapshotWorkbench(
  state: Pick<VideoWorkbenchState, 'cards' | 'boards' | 'activeBoardId' | 'selectedCardIds'>,
): WorkbenchSummary {
```

返回对象里加：

```ts
    selectedCardIds: [...state.selectedCardIds],
```

3c. `videoWorkbenchTools.ts` 的 `workbenchSummarySchema`：

```ts
const workbenchSummarySchema = z.object({
  activeBoardId: z.string(),
  boards: z.array(boardBriefSchema),
  statusCounts: statusCountsSchema.describe('Global card status tally across ALL boards.'),
  selectedCardIds: z.array(z.string()).describe(
    'Cards the USER currently has selected in the UI. Informational only — it is a volatile UI state '
    + 'that changes on every click. NEVER use it to decide which cards to act on; always pass explicit '
    + 'cardIds. Useful when the user says things like "生成选中的" or "这几张" without naming ids.',
  ),
})
```

3d. 若 TypeScript 报 `snapshotWorkbench` 的调用点缺 `selectedCardIds`（主进程侧的合成 state 之类），在那些调用点补 `selectedCardIds: []`——不要把字段改成可选，可选会让 agent 侧读到 `undefined` 又得写判空。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/video-workbench src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/__tests__/store.test.ts src/main/mcp/tools/videoWorkbenchTools.ts src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts
git commit -m "feat(workbench): 工具摘要带出用户选中的卡片"
```

---

## 收尾验收

- [ ] 全量跑相关套件：

```bash
npx vitest run src/renderer/src/features/video-workbench src/renderer/src/pages-react/video-workbench src/renderer/src/features/file-explorer src/renderer/src/features/agent-chat src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts
```

- [ ] `npm run build:vite` 通过。
- [ ] 触及文件零新增 lint（`ReadLints` 或 `npm run lint`）。
- [ ] 手动过一遍：拖拽排序仍正常（旧 MIME 未被新分支抢走）；缝隙「＋」插卡仍正常；选中 2 张拖进聊天栏，chip 出现且**发送不报 outside allowed roots**（这是本刀的核心守卫）。

## 自查记录

对着 spec 逐条核过：

| spec 要求 | 落在哪 |
| --- | --- |
| `selectedCardIds` 不持久化、切页清空 | Task 1（3e/3f）|
| 命中区限定卡片头部行 | Task 3（3b）|
| 单击 / Ctrl / Shift 三种选法 | Task 1（3d）+ Task 3 |
| 选中态边框高亮不遮内容 | Task 3（3c）|
| 无参批量操作作用于选中项 | Task 2（3a）|
| ⚡ 文案随选中态变化 | Task 2（3c）|
| 删除同理 | Task 2（3c 的删除按钮）+ Task 1 的 `removeCards` |
| MCP `start` 显式 cardIds 不受影响 | Task 2（3a 的优先级）+ 测试第 3 条 |
| 新 MIME 词表进 dragHelpers | Task 4（3b）|
| `effectAllowed` 改 copyMove | Task 4（3c）|
| 拖已选中的卡 = 拖全部选中 | Task 4（3c）+ 测试 |
| 页内排序继续读旧 MIME | Task 4（3c 双写）+ 测试断言旧 MIME 只带一张 |
| 投放产出 chip + 可见信息行 | Task 5（3c）|
| 无 localPath 退 remoteUrl 并如实提示 | Task 5（3c 的 `linkOnly`）|
| 草稿卡只产信息行 | Task 5（3c 末路径）+ 测试 |
| 聊天栏补投放悬停反馈 | Task 5（3e）|
| `snapshotWorkbench` 带出选中 | Task 6 |
| 不为选中变化推送通知 | 全程未实现推送——这是刻意的空缺 |
| 不复用 `mention` 输入变体 | 全程未碰 mention 通道 |
