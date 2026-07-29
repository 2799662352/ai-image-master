# 视频工作台·任意位置插卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在任意两张卡之间新建一张卡，agent 亦可按锚点插卡。

**Architecture:** 扩展现有 `addCards` 接受一个可选锚点（`{afterCardId}` / `{beforeCardId}`），
复用 `moveCard` 已有的「扁平数组 splice → `reorderBoard` 压实」套路；UI 侧在 `VideoWorkbenchPage`
的卡片流里插入一个悬停显形的细「＋」条，并把页面里预埋但一直没接的拖拽状态管线接上，
使「＋」条在拖拽时隐身，避让已有的插入指示线。

**Tech Stack:** TypeScript / React 19 / zustand / zod / vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-29-workbench-insert-card-design.md`

## Global Constraints

- 位置一律用**稳定 cardId 锚点**表达，任何 API 都不接受下标作为插入位置。
- **不传锚点时行为必须与今天逐字一致**（追加到 `activeBoardId` 末尾）——这是回归守卫，现有契约测试不得修改。
- 新卡**不继承**邻居任何字段，全部默认规格，与现有「＋」一致。
- 不引入分数索引；`order` 保持每页密集 `0..n-1` + `reorderBoard` 压实。
- 不改 `structureRevision` 语义：插卡属于「卡片集合与位置变了」，理应 bump 并让 agent 的 IR 令牌失效。
- 200 张上限**沿用 `evict()` 软淘汰**，不新增硬拒（`addCards` 今天就不检查它）。
- 触及 UI 时必须遵循仓库根目录 `DESIGN.md` 的设计令牌；工作台自身的既有配色约定见
  `src/renderer/src/pages-react/video-workbench/workbench.css`（zinc + `#FCE300`）。
- 运行测试用 `npx vitest run <path>`；提交前跑 `npm run typecheck:ci`。

---

### Task 0: 淘汰变诚实，并拆掉 apply 的 200 硬拒

**背景（必读）：** `WorkbenchDb.evict()` 只删数据库、返回被删 id 列表，而唯一调用点
`store.ts:860` 写的是 `void getWorkbenchDb().evict()` —— **返回值被丢弃，内存里那几张卡还在**。
于是超限时界面一切正常，等下次启动它们凭空消失。症状延迟到重启才出现，属最难排查的一类。

`workbenchIR.ts:496` 的「超过上限整体拒绝」正是在挡住这个缺陷的规模化版本。用户要求拆掉该拒绝，
所以必须先把缺陷修掉，否则一次 apply 加 100 张卡就是 100 张在重启后蒸发。

注意 `applyIR` 今天**根本不调 `evict()`**（它靠拒绝兜底），所以拆掉拒绝后 apply 只是允许卡数超过
200，真正的淘汰仍发生在下一次 `addCards`。

**Files:**
- Modify: `src/renderer/src/features/video-workbench/store.ts:860`
- Modify: `src/renderer/src/features/video-workbench/workbenchIR.ts:496-505`（删除整块）
- Modify: `src/renderer/src/features/video-workbench/workbenchIR.ts:17` 附近的
  `WORKBENCH_MAX_CARDS` import（删块后变成未使用，必须一并删）
- Test: `src/renderer/src/features/video-workbench/__tests__/store.test.ts`
- Test: `src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts:273-280`（改写既有用例）

**Interfaces:**
- Consumes: `getWorkbenchDb().evict(): Promise<string[]>`（已返回被删 id，无需改动 `WorkbenchDb`）、
  `useToastStore.getState().addToast({ type, message })`（`src/renderer/src/stores/useToastStore`）。
- Produces: 无新导出。行为契约变更：超限淘汰会同步从内存移除并弹一次 toast；
  `planApplyIR` 不再因超限拒绝。

- [ ] **Step 1: 写失败测试（淘汰同步内存）**

在 `src/renderer/src/features/video-workbench/__tests__/store.test.ts` 追加。
顶部 import 补上 `WORKBENCH_MAX_CARDS`：

```ts
import { getWorkbenchDb, resetWorkbenchDbForTest, WORKBENCH_MAX_CARDS } from '../WorkbenchDb'
```

```ts
describe('超上限淘汰', () => {
  it('被淘汰的卡同步从内存摘掉,不会等到重启才消失', async () => {
    useVideoWorkbenchStore.getState().addCards(
      Array.from({ length: WORKBENCH_MAX_CARDS + 3 }, (_, i) => ({ prompt: `p${i}` })),
    )

    await vi.waitFor(() => {
      expect(useVideoWorkbenchStore.getState().cards).toHaveLength(WORKBENCH_MAX_CARDS)
    })
    const rows = await getWorkbenchDb().list()
    expect(rows).toHaveLength(WORKBENCH_MAX_CARDS)
  })
})
```

- [ ] **Step 2: 改写 apply 超限用例（从「拒绝」改为「放行」）**

把 `src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts:273-280` 整个 `it` 替换为：

```ts
  it('超过卡片上限不再拒绝:照写,超出部分由 evict 兜底淘汰', () => {
    const src = source()
    const ir = roundTrip(src)
    ir.boards[0].cards = Array.from({ length: WORKBENCH_MAX_CARDS + 1 }, (_, i) => ({ prompt: `镜 ${i}` }))
    const plan = planApplyIR(src, ir)
    expect(plan.result.ok).toBe(true)
    expect(plan.result.skipped.map((s) => s.reason).join()).not.toContain('超过上限')
    expect(plan.next!.cards).toHaveLength(WORKBENCH_MAX_CARDS + 1)
  })
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t "超上限淘汰"`
Expected: FAIL —— 内存仍是 `WORKBENCH_MAX_CARDS + 3` 张，`vi.waitFor` 超时。

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts -t "超过卡片上限"`
Expected: FAIL —— `plan.result.ok` 仍为 `false`。

- [ ] **Step 4: 让淘汰同步内存并可见**

把 `src/renderer/src/features/video-workbench/store.ts:860` 的 `void getWorkbenchDb().evict()` 替换为：

```ts
    // evict() 只删库并返回被删 id。必须把它们同步从内存摘掉 —— 否则界面上卡还在、
    // 重启后凭空消失,症状延迟到下次启动才出现,是最难排查的一类。
    // 淘汰也不该悄悄发生:弹一次 toast 告诉用户为了放下新卡牺牲了哪些旧卡。
    void getWorkbenchDb()
      .evict()
      .then((evicted) => {
        if (evicted.length === 0) return
        const gone = new Set(evicted)
        set((state) => ({
          cards: state.cards.filter((c) => !gone.has(c.id)),
          revision: state.revision + 1,
          // 卡片集合变了 —— agent 手里的整份 IR 令牌理应随之作废。
          structureRevision: state.structureRevision + 1,
        }))
        useToastStore.getState().addToast({
          type: 'info',
          message: `卡片超过上限 ${WORKBENCH_MAX_CARDS} 张,已淘汰最旧的 ${evicted.length} 张终态卡`,
        })
      })
      .catch(() => {})
```

在 `store.ts` 顶部补入：

```ts
import { useToastStore } from '../../stores/useToastStore'
```

并把既有的 `WorkbenchDb` import 补上 `WORKBENCH_MAX_CARDS`。

- [ ] **Step 5: 拆掉 apply 的 200 硬拒**

删除 `src/renderer/src/features/video-workbench/workbenchIR.ts:496-505` 整个
`if (nextCards.length > WORKBENCH_MAX_CARDS) { ... }` 块。

删除该文件顶部 `import { WORKBENCH_MAX_CARDS } from './WorkbenchDb'` —— 删块之后它已无使用点，
留着会触发未使用导入的 lint 错误。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/video-workbench`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/workbenchIR.ts src/renderer/src/features/video-workbench/__tests__/store.test.ts src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts
git commit -m "fix(workbench): 超限淘汰同步内存并提示,apply 不再因超限整体拒绝"
```

---

### Task 1: store 支持锚点插入

**Files:**
- Modify: `src/types/videoWorkbench.ts`（新增锚点类型）
- Modify: `src/renderer/src/features/video-workbench/store.ts:296-297`（接口声明）
- Modify: `src/renderer/src/features/video-workbench/store.ts:846-862`（`addCards` 实现）
- Test: `src/renderer/src/features/video-workbench/__tests__/store.test.ts`

**Interfaces:**
- Consumes: 既有 `buildCard(input, order, boardId)`（`cardSpec.ts:114`）、
  `reorderBoard(cards, boardId)`（`cardSpec.ts:190`）、`persistNow`、`schedulePersist`、
  `startTransfersForCard`、`getWorkbenchDb().evict()`。
- Produces: `VideoWorkbenchInsertAnchor` 类型；
  `addCards(inputs: VideoWorkbenchCardInput[], anchor?: VideoWorkbenchInsertAnchor): string[]`。
  Task 2、3 都依赖这个签名。

- [ ] **Step 1: 写失败测试**

追加到 `src/renderer/src/features/video-workbench/__tests__/store.test.ts` 末尾：

```ts
describe('addCards 锚点插入', () => {
  it('插到中间:顺序压实,后续卡顺延', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])
    const [mid] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['A', 'M', 'B'])
    expect(cards.map((c) => c.order)).toEqual([0, 1, 2])
    expect(cards.find((c) => c.id === mid)?.order).toBe(1)
  })

  it('beforeCardId 插到最前', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'T' }], { beforeCardId: a })

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['T', 'A'])
  })

  it('锚点在非活动页:新卡落在锚点那一页,不是 activeBoardId', () => {
    const store = useVideoWorkbenchStore.getState()
    const [onFirst] = store.addCards([{ prompt: '第一页的卡' }])
    const firstBoardId = useVideoWorkbenchStore.getState().cards[0].boardId
    const secondBoardId = useVideoWorkbenchStore.getState().addBoard('第二页')
    useVideoWorkbenchStore.getState().switchBoard(secondBoardId)
    expect(useVideoWorkbenchStore.getState().activeBoardId).toBe(secondBoardId)

    const [inserted] = useVideoWorkbenchStore.getState().addCards(
      [{ prompt: '插进第一页' }],
      { afterCardId: onFirst },
    )

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === inserted)
    expect(card?.boardId).toBe(firstBoardId)
  })

  it('锚点不存在:抛错且什么都不写', () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    const before = useVideoWorkbenchStore.getState()
    const countBefore = before.cards.length
    const structureBefore = before.structureRevision

    expect(() =>
      useVideoWorkbenchStore.getState().addCards([{ prompt: 'X' }], { afterCardId: '不存在' }),
    ).toThrow(/anchor card not found/)

    expect(useVideoWorkbenchStore.getState().cards).toHaveLength(countBefore)
    expect(useVideoWorkbenchStore.getState().structureRevision).toBe(structureBefore)
  })

  it('不传锚点仍追加到当前页末尾(回归守卫)', () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }, { prompt: 'B' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'C' }])

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['A', 'B', 'C'])
  })

  it('插入 bump revision 与 structureRevision', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    const before = useVideoWorkbenchStore.getState()
    const rev = before.revision
    const structure = before.structureRevision

    useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })

    expect(useVideoWorkbenchStore.getState().revision).toBe(rev + 1)
    expect(useVideoWorkbenchStore.getState().structureRevision).toBe(structure + 1)
  })

  it('插入后新卡落库的 order 是压实后的值,不是占位 0', async () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])
    const [mid] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })

    const rows = await getWorkbenchDb().list()
    expect(rows.find((r) => r.id === mid)?.order).toBe(1)
  })

  it('被顶下去的兄弟卡也重新落库,重载后顺序不会错乱', async () => {
    // schedulePersist 有 500ms 防抖(store.ts PERSIST_DEBOUNCE_MS),要推进定时器才看得到写入。
    vi.useFakeTimers()
    try {
      const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
      const [b] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])
      // B 落库时 order 是 1;插入后它应变成 2 并被补写。
      useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })
      await vi.advanceTimersByTimeAsync(600)

      const rows = await getWorkbenchDb().list()
      expect(rows.find((r) => r.id === b)?.order).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t "锚点插入"`
Expected: FAIL —— `addCards` 目前只接受一个参数，第二个实参被忽略，因此「插到中间」会得到 `['A','B','M']`；
「锚点不存在」不会抛错。

- [ ] **Step 3: 新增锚点类型**

在 `src/types/videoWorkbench.ts` 的 `VideoWorkbenchCard` 定义之后加入：

```ts
/**
 * 插卡锚点。位置用**稳定 cardId** 表达而不是下标 —— 下标是易变状态，调用方手里的
 * 下标可能已经不指向它以为的那张卡；id 不会漂。二选一；两者都不传 = 追加到当前页末尾。
 */
export type VideoWorkbenchInsertAnchor =
  | { afterCardId: string; beforeCardId?: undefined }
  | { beforeCardId: string; afterCardId?: undefined }
```

- [ ] **Step 4: 改 store 接口声明**

把 `src/renderer/src/features/video-workbench/store.ts:296-297` 替换为：

```ts
  /**
   * 批量新建卡片,返回新卡 id 列表。
   * - 不传 anchor:追加到当前页末尾(UI 的「＋」= addCards([{}]))。
   * - 传 anchor:插到锚点卡前/后,并落在**锚点所在的页**(不是 activeBoardId),
   *   否则在非活动页插卡会跑到别的页去。
   * - 锚点不存在:抛错、零写入。调用方明确要求了位置,静默退化成追加等于
   *   给它一个错误的成功。
   */
  addCards: (inputs: VideoWorkbenchCardInput[], anchor?: VideoWorkbenchInsertAnchor) => string[]
```

并在该文件顶部的 `import type { ... } from '../../../../types/videoWorkbench'` 中补上
`VideoWorkbenchInsertAnchor`。

- [ ] **Step 5: 改 `addCards` 实现**

把 `src/renderer/src/features/video-workbench/store.ts:846-862` 整段替换为：

```ts
  addCards: (inputs, anchor) => {
    const created: VideoWorkbenchCard[] = []
    let targetBoardId: string | undefined
    let missingAnchor: string | null = null

    set((state) => {
      if (!anchor) {
        targetBoardId = state.activeBoardId
        const base = state.cards.filter((c) => c.boardId === state.activeBoardId).length
        inputs.forEach((input, i) => created.push(buildCard(input, base + i, state.activeBoardId)))
        return {
          cards: [...state.cards, ...created],
          revision: state.revision + 1,
          structureRevision: state.structureRevision + 1,
        }
      }

      const anchorId = anchor.afterCardId ?? anchor.beforeCardId
      const at = state.cards.findIndex((c) => c.id === anchorId)
      if (at < 0) {
        missingAnchor = anchorId
        return {}
      }
      const anchorCard = state.cards[at]
      targetBoardId = anchorCard.boardId
      // order 交给紧随其后的 reorderBoard 压实,这里的 0 只是占位。
      inputs.forEach((input) => created.push(buildCard(input, 0, anchorCard.boardId)))
      const next = [...state.cards]
      next.splice(anchor.afterCardId ? at + 1 : at, 0, ...created)
      return {
        cards: reorderBoard(next, anchorCard.boardId),
        revision: state.revision + 1,
        structureRevision: state.structureRevision + 1,
      }
    })

    if (missingAnchor !== null) throw new Error(`anchor card not found: ${missingAnchor}`)

    const createdIds = new Set(created.map((c) => c.id))
    // reorderBoard 会替换卡片对象(order 被压实),所以必须从 store 取压实后的版本再落库,
    // 否则插入路径会把占位 order 0 写进 IndexedDB。
    const fresh = get().cards.filter((c) => createdIds.has(c.id))
    for (const card of fresh) persistNow(card)
    // agent 经 MCP 加卡时素材是随卡一起来的,不走 addMaterials —— 转存要在这里接。
    for (const card of fresh) startTransfersForCard(card)
    if (anchor) {
      // 插入让同页兄弟卡的 order 变了,补写 —— 只这一页,别把整个工作台重写一遍。
      for (const card of get().cards) {
        if (card.boardId === targetBoardId && !createdIds.has(card.id)) schedulePersist(card)
      }
    }
    void getWorkbenchDb().evict()
    return created.map((c) => c.id)
  },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts`
Expected: PASS，全部用例（含既有的追加 / `moveCard` / `removeCard` 压实用例）。

- [ ] **Step 7: 跑相邻套件防回归**

Run: `npx vitest run src/renderer/src/features/video-workbench`
Expected: PASS。特别关注 `storeIR.test.ts`（`structureRevision` 递增纪律）与
`storeHistoryStack.test.ts`（撤销栈）。

- [ ] **Step 8: 提交**

```bash
git add src/types/videoWorkbench.ts src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/__tests__/store.test.ts
git commit -m "feat(workbench): addCards 支持按锚点 cardId 插入"
```

---

### Task 2: MCP 契约暴露锚点

**Files:**
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts:287-291`（`add_tasks` 入参 schema 与描述）
- Modify: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts:343-367`（透传锚点）
- Test: `src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`
- Test: `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `addCards(inputs, anchor?)`。
- Produces: `video_workbench_add_tasks` 新增两个互斥可选入参 `afterCardId?: string` /
  `beforeCardId?: string`。

- [ ] **Step 1: 写失败测试（schema 层）**

在 `src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts` 的 schema describe 块内追加：

```ts
  it('add_tasks:锚点二选一,同时传两个被拒', () => {
    const { tools, server, router } = capture()
    registerVideoWorkbenchTools(server, router)
    const schema = toolByName(tools, 'video_workbench_add_tasks').config.inputSchema

    expect(schema.safeParse({ tasks: [{ prompt: 'a' }] }).success).toBe(true)
    expect(schema.safeParse({ tasks: [{ prompt: 'a' }], afterCardId: 'c1' }).success).toBe(true)
    expect(schema.safeParse({ tasks: [{ prompt: 'a' }], beforeCardId: 'c1' }).success).toBe(true)
    expect(
      schema.safeParse({ tasks: [{ prompt: 'a' }], afterCardId: 'c1', beforeCardId: 'c2' }).success,
    ).toBe(false)
  })
```

- [ ] **Step 2: 写失败测试（渲染端透传）**

在 `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts` 追加：

该文件已有一个私有方法直调壳 `callTool(toolName, params)`（定义在文件第 17-23 行），直接用它：

```ts
  it('add_tasks 带 afterCardId:插到锚点之后而不是末尾', async () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])

    await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'M' }],
      afterCardId: a,
      navigate: false,
    })

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['A', 'M', 'B'])
  })

  it('add_tasks 锚点不存在:回错且一张卡都不加', async () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])

    await expect(
      callTool('video_workbench_add_tasks', {
        tasks: [{ prompt: 'M' }],
        afterCardId: '不存在',
        navigate: false,
      }),
    ).rejects.toThrow(/anchor card not found/)

    expect(useVideoWorkbenchStore.getState().cards).toHaveLength(1)
  })
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts -t "锚点"`
Expected: FAIL —— 同时传两个锚点目前会被 `z.object` 放行（`success` 为 `true`）。

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts -t "afterCardId"`
Expected: FAIL —— 得到 `['A','B','M']`。

- [ ] **Step 4: 改 MCP 入参 schema**

把 `src/main/mcp/tools/videoWorkbenchTools.ts:287-291` 的 `inputSchema` 替换为：

```ts
    inputSchema: z.object({
      tasks: z.array(cardInputSchema).min(1).max(20).describe('Cards to append, top-to-bottom order.'),
      autoStart: z.boolean().optional().describe('Start rendering right after adding. Default false (fill only).'),
      navigate: z.boolean().optional().describe('Switch the app to the workbench tab. Default true.'),
      afterCardId: z.string().optional().describe(
        'Insert the new cards right AFTER this card. Pass a stable card id from '
        + 'video_workbench_status — NOT a position number, those shift. The cards land on the '
        + 'anchor card\'s board. Mutually exclusive with beforeCardId; omit both to append at '
        + 'the end of the active board. Note this invalidates any IR token you are holding.',
      ),
      beforeCardId: z.string().optional().describe(
        'Insert right BEFORE this card. Mutually exclusive with afterCardId. Same rules as afterCardId.',
      ),
    }).refine(
      (v) => !(v.afterCardId && v.beforeCardId),
      { message: 'afterCardId and beforeCardId are mutually exclusive' },
    ),
```

- [ ] **Step 5: 渲染端透传锚点**

在 `src/renderer/src/features/agent-chat/AgentToolExecutor.ts` 的 `video_workbench_add_tasks`
分支里，把 `store.addCards(tasks)` 改为按入参构造锚点后传入：

```ts
        const afterCardId = typeof params.afterCardId === 'string' ? params.afterCardId : undefined
        const beforeCardId = typeof params.beforeCardId === 'string' ? params.beforeCardId : undefined
        const anchor = afterCardId
          ? ({ afterCardId } as const)
          : beforeCardId
            ? ({ beforeCardId } as const)
            : undefined
        const cardIds = store.addCards(tasks, anchor)
```

（保留该分支原有的 `navigate` / `autoStart` / `registerAgentBatch` 逻辑不动。）

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`
Expected: PASS，且**既有的「add_tasks 追加顺序」用例不得改动仍通过**（回归守卫）。

- [ ] **Step 7: 提交**

```bash
git add src/main/mcp/tools/videoWorkbenchTools.ts src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts src/renderer/src/features/agent-chat/AgentToolExecutor.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts
git commit -m "feat(workbench): add_tasks 支持 afterCardId / beforeCardId 锚点"
```

---

### Task 3: UI 缝隙「＋」条

**Files:**
- Create: `src/renderer/src/pages-react/video-workbench/CardGap.tsx`
- Modify: `src/renderer/src/pages-react/VideoWorkbenchPage.tsx:10`（改 `useState` 导入）
- Modify: `src/renderer/src/pages-react/VideoWorkbenchPage.tsx:23-24`（删 `NOOP_DRAG_STATE`）
- Modify: `src/renderer/src/pages-react/VideoWorkbenchPage.tsx:161-169`（卡片流）
- Test: `src/renderer/src/pages-react/video-workbench/__tests__/CardGap.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `addCards(inputs, { beforeCardId })`。
- Produces: `CardGap` 组件，props 为 `{ beforeCardId: string; hidden: boolean }`。

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/pages-react/video-workbench/__tests__/CardGap.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { CardGap } from '../CardGap'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

describe('CardGap', () => {
  it('点击在该卡之前插入一张默认卡', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    render(<CardGap beforeCardId={a} hidden={false} />)

    fireEvent.click(screen.getByRole('button', { name: /在此插入卡片/ }))

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards).toHaveLength(2)
    expect(cards[1].prompt).toBe('A')
    expect(cards[0].prompt).toBe('')
  })

  it('拖拽进行中整条隐身,避让插入指示线', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    render(<CardGap beforeCardId={a} hidden />)

    expect(screen.queryByRole('button', { name: /在此插入卡片/ })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench/__tests__/CardGap.test.tsx`
Expected: FAIL —— `Cannot find module '../CardGap'`。

- [ ] **Step 3: 写 CardGap 组件**

新建 `src/renderer/src/pages-react/video-workbench/CardGap.tsx`：

```tsx
// 两张卡之间的插入缝隙。悬停才显形,点击在下方那张卡之前插入一张默认卡。
//
// 高度为 0 且绝对定位进 space-y-4 的间距里 —— 卡片流的行距不能因为多了这一层而变化。
// 拖拽进行中整条隐身:同一道缝已被 WorkbenchCard 的 .vw-drop-above/.vw-drop-below
// 插入指示线占用,两种反馈叠在一起会互相干扰。

interface CardGapProps {
  /** 点这道缝 = 在这张卡之前插入。 */
  beforeCardId: string
  /** 拖拽进行中隐身。 */
  hidden: boolean
}

export function CardGap({ beforeCardId, hidden }: CardGapProps): React.JSX.Element | null {
  if (hidden) return null
  return (
    <div className="relative h-0">
      <button
        type="button"
        aria-label="在此插入卡片"
        title="在此插入卡片"
        className="absolute inset-x-0 -top-4 h-4 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
        onClick={() =>
          useVideoWorkbenchStore.getState().addCards([{}], { beforeCardId })
        }
      >
        <span className="w-full border-t border-dashed border-[#FCE300]" />
        <span className="absolute px-2 text-[10px] leading-none text-black bg-[#FCE300]">＋</span>
      </button>
    </div>
  )
}
```

在文件顶部加入：

```tsx
import type React from 'react'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench/__tests__/CardGap.test.tsx`
Expected: PASS

- [ ] **Step 5: 接进页面并接上拖拽状态**

`src/renderer/src/pages-react/VideoWorkbenchPage.tsx`：

第 10 行改为 `import { useEffect, useState } from 'react'`；
第 20 行后加 `import { CardGap } from './video-workbench/CardGap'`；
删除第 23-24 行的 `NOOP_DRAG_STATE` 注释与常量。

在组件内加入拖拽状态：

```tsx
  // 卡片汇报的拖拽态。以前这里传的是 noop,卡片说了页面不听;缝隙「＋」要在拖拽时
  // 隐身,正好把这根预埋管线接上。
  const [dragging, setDragging] = useState(false)
```

把第 161-169 行替换为：

```tsx
          <div className="space-y-4 pt-4">
            {cards.map((card, index) => (
              <div key={card.id} className="relative">
                <CardGap beforeCardId={card.id} hidden={dragging} />
                <WorkbenchCard
                  card={card}
                  index={index}
                  onDragStateChange={setDragging}
                />
              </div>
            ))}
```

（`pt-4` 是给第一张卡上方那道缝留出落点——`space-y-4` 不给首个子元素外边距，
没有它就无法插到最前面。）

- [ ] **Step 6: 跑页面测试确认无回归**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench`
Expected: PASS

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck:ci`
Expected: 新增错误数为 0（基线里的既有错误不计）。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/pages-react/video-workbench/CardGap.tsx src/renderer/src/pages-react/video-workbench/__tests__/CardGap.test.tsx src/renderer/src/pages-react/VideoWorkbenchPage.tsx
git commit -m "feat(workbench): 卡片之间的插入缝隙「＋」,拖拽时隐身"
```

---

## 收尾验证

- [ ] Run: `npx vitest run src/renderer/src/features/video-workbench src/renderer/src/pages-react/video-workbench src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`
- [ ] Run: `npm run typecheck:ci` —— 新增错误为 0
- [ ] Run: `npm run build:vite` —— 通过
