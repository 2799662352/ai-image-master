// store 侧的撤销/重做接线:入栈由 revision 变化驱动(编排动作入栈、生成回流不
// 入栈)、撤销/重做的栈搬运、新编辑清空重做栈、落盘增量、栈深上限。
// IndexedDB 在 jsdom 缺失 → WorkbenchDb 自动内存降级。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../../types/seedance'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { WORKBENCH_COALESCE_MS, WORKBENCH_HISTORY_LIMIT } from '../workbenchHistory'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

function state() {
  return useVideoWorkbenchStore.getState()
}

function makeUpdate(patch: Partial<SeedanceTaskUpdate>): SeedanceTaskUpdate {
  return {
    taskId: 'task-1',
    prompt: 'p',
    model: '2.0',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    persistence: 'idle',
    source: 'workbench',
    ...patch,
  }
}

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

afterEach(() => {
  vi.useRealTimers()
})

/** 模拟在提示词框里逐字符打字(UI 就是 onChange 逐字符调 updateCard)。 */
function type(cardId: string, text: string): void {
  for (let i = 1; i <= text.length; i++) {
    state().updateCard(cardId, { prompt: text.slice(0, i) })
  }
}

describe('入栈', () => {
  it('初始两个栈都是空的,撤销/重做直接拒绝', async () => {
    expect(state().undoStack).toHaveLength(0)
    expect(state().redoStack).toHaveLength(0)

    const undone = await state().undo()
    expect(undone.ok).toBe(false)
    expect(undone.skipped[0].reason).toBe('没有可撤销的步骤')

    const redone = await state().redo()
    expect(redone.skipped[0].reason).toBe('没有可重做的步骤')
  })

  it('每个编排动作各压一步', async () => {
    const [cardId] = state().addCards([{ prompt: 'A' }])
    expect(state().undoStack).toHaveLength(1)

    state().updateCard(cardId, { prompt: 'A+' })
    expect(state().undoStack).toHaveLength(2)

    state().addBoard('第二页')
    expect(state().undoStack).toHaveLength(3)

    state().addMaterials(cardId, 'referenceImages', [{ name: 'a.png', src: 'https://x/a.png' }])
    expect(state().undoStack).toHaveLength(4)
  })

  it('生成状态回流不入栈:撤销不会把跑着的任务从卡片上抹掉', () => {
    const [cardId] = state().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.setState({
      cards: state().cards.map((c) => (c.id === cardId ? { ...c, clientId: 'cl-1' } : c)),
    })
    const depth = state().undoStack.length

    state().applyTaskUpdate(makeUpdate({ clientId: 'cl-1', status: 'running' }))
    state().applyTaskUpdate(makeUpdate({ clientId: 'cl-1', status: 'succeeded', persistence: 'done' }))

    expect(state().undoStack).toHaveLength(depth)
    expect(state().cards[0].status).toBe('succeeded')
  })

  it('无操作的重命名不入栈', () => {
    const boardId = state().activeBoardId
    state().renameBoard(boardId, '新名字')
    const depth = state().undoStack.length

    state().renameBoard(boardId, '新名字')

    expect(state().undoStack).toHaveLength(depth)
  })

  it('一串连续打字只算一步 —— 否则一条提示词就吃光整个撤销栈', async () => {
    const [cardId] = state().addCards([{ prompt: '' }])
    const depth = state().undoStack.length

    type(cardId, '一个赛博朋克街头长镜头,雨夜霓虹')

    expect(state().undoStack).toHaveLength(depth + 1)

    await state().undo()
    expect(state().cards[0].prompt).toBe('')
  })

  it('停手超过合并窗口后再打字,另起一步', () => {
    vi.useFakeTimers()
    const [cardId] = state().addCards([{ prompt: '' }])
    const depth = state().undoStack.length

    type(cardId, '第一句')
    expect(state().undoStack).toHaveLength(depth + 1)

    vi.advanceTimersByTime(WORKBENCH_COALESCE_MS + 50)
    type(cardId, '第一句,第二句')

    expect(state().undoStack).toHaveLength(depth + 2)
  })

  it('打字之后换下拉框设置,不并进那串打字', () => {
    const [cardId] = state().addCards([{ prompt: '' }])
    const depth = state().undoStack.length

    type(cardId, '镜头')
    state().updateCard(cardId, { resolution: '1080p' })
    state().updateCard(cardId, { ratio: '9:16' })

    expect(state().undoStack).toHaveLength(depth + 3)
  })

  it('分别在两张卡上打字算两步', () => {
    const ids = state().addCards([{ prompt: '' }, { prompt: '' }])
    const depth = state().undoStack.length

    type(ids[0], 'A 卡')
    type(ids[1], 'B 卡')

    expect(state().undoStack).toHaveLength(depth + 2)
  })

  it('撤销后接着打字不会并进被撤销掉的那一步', async () => {
    const [cardId] = state().addCards([{ prompt: '' }])
    type(cardId, '原句')
    const depth = state().undoStack.length

    await state().undo()
    expect(state().cards[0].prompt).toBe('')
    type(cardId, '新句')

    // 撤销弹掉一步、新打字压回一步 —— 而不是悄悄并进已经撤销掉的那一步
    expect(state().undoStack).toHaveLength(depth)
    await state().undo()
    expect(state().cards[0].prompt).toBe('')
  })

  it('agent 的整板 applyIR 永不与相邻编辑合并', async () => {
    const [cardId] = state().addCards([{ prompt: '' }])
    type(cardId, '用户写的')
    const depth = state().undoStack.length

    const ir = state().exportIR()
    await state().applyIR(
      { ...ir, boards: ir.boards.map((b) => ({ ...b, cards: [{ prompt: 'agent 写的' }] })) },
      { mode: 'replace' },
    )

    expect(state().undoStack).toHaveLength(depth + 1)
    await state().undo()
    expect(state().cards.map((c) => c.prompt)).toEqual(['用户写的'])
  })

  it('超出栈深上限丢最老的一步', () => {
    for (let i = 0; i < WORKBENCH_HISTORY_LIMIT + 3; i++) state().addCards([{ prompt: `P${i}` }])
    expect(state().undoStack).toHaveLength(WORKBENCH_HISTORY_LIMIT)
  })
})

describe('撤销 / 重做', () => {
  it('撤销改提示词,重做再改回来', async () => {
    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })
    expect(state().cards[0].prompt).toBe('新')

    const undone = await state().undo()
    expect(undone.ok).toBe(true)
    expect(undone.cards.restored).toEqual([cardId])
    expect(state().cards[0].prompt).toBe('旧')
    expect(state().redoStack).toHaveLength(1)

    const redone = await state().redo()
    expect(redone.ok).toBe(true)
    expect(state().cards[0].prompt).toBe('新')
    expect(state().redoStack).toHaveLength(0)
  })

  it('撤销删卡 = 复活,且写回数据库', async () => {
    const [cardId] = state().addCards([{ prompt: '别删我' }])
    state().removeCard(cardId)
    expect(state().cards).toHaveLength(0)

    const undone = await state().undo()

    expect(undone.cards.resurrected).toEqual([cardId])
    expect(state().cards.map((c) => c.prompt)).toEqual(['别删我'])
    const rows = await getWorkbenchDb().list()
    expect(rows.map((r) => r.id)).toEqual([cardId])
  })

  it('撤销掉建卡后,选中态里不留悬空 id', async () => {
    const [cardId] = state().addCards([{ prompt: '刚建的' }])
    state().selectCard(cardId)
    expect(state().selectedCardIds).toEqual([cardId])

    await state().undo()

    expect(state().cards).toHaveLength(0)
    expect(state().selectedCardIds).toEqual([])
    expect(state().selectionAnchorId).toBeUndefined()
  })

  it('撤销删页 = 连带复活该页的卡,并切回那一页', async () => {
    const first = state().activeBoardId
    const second = state().addBoard('第二页')
    const [cardId] = state().addCards([{ prompt: '第二页的卡' }])
    expect(state().cards[0].boardId).toBe(second)

    state().removeBoard(second)
    expect(state().boards.map((b) => b.id)).toEqual([first])
    expect(state().cards).toHaveLength(0)

    const undone = await state().undo()

    expect(undone.ok).toBe(true)
    expect(state().boards.map((b) => b.name)).toEqual(['页面 1', '第二页'])
    expect(state().cards.map((c) => c.prompt)).toEqual(['第二页的卡'])
    expect(state().activeBoardId).toBe(second)
  })

  it('撤销排序:卡片顺序还原,且只落盘动过的卡', async () => {
    const ids = state().addCards([{ prompt: 'A' }, { prompt: 'B' }, { prompt: 'C' }])
    state().moveCard(ids[0], 2)
    expect(state().cards.map((c) => c.prompt)).toEqual(['B', 'C', 'A'])

    await state().undo()

    const ordered = [...state().cards].sort((a, b) => a.order - b.order)
    expect(ordered.map((c) => c.prompt)).toEqual(['A', 'B', 'C'])
  })

  it('撤销 agent 的整板 applyIR', async () => {
    state().addCards([{ prompt: '用户写的' }])
    const ir = state().exportIR()

    const applied = await state().applyIR(
      { ...ir, boards: ir.boards.map((b) => ({ ...b, cards: [{ prompt: 'agent 重写的' }] })) },
      { mode: 'replace' },
    )
    expect(applied.ok).toBe(true)
    expect(state().cards.map((c) => c.prompt)).toEqual(['agent 重写的'])

    await state().undo()

    expect(state().cards.map((c) => c.prompt)).toEqual(['用户写的'])
  })

  it('撤销之后的新编辑清空重做栈', async () => {
    const [cardId] = state().addCards([{ prompt: '一' }])
    state().updateCard(cardId, { prompt: '二' })
    await state().undo()
    expect(state().redoStack).toHaveLength(1)

    state().updateCard(cardId, { prompt: '三' })

    expect(state().redoStack).toHaveLength(0)
    const redone = await state().redo()
    expect(redone.ok).toBe(false)
  })

  it('连续撤销逐步回退,连续重做逐步前进', async () => {
    // 隔开合并窗口,让三次编辑真的是三步 —— 不隔开就是一步(见入栈那组用例)
    vi.useFakeTimers()
    const [cardId] = state().addCards([{ prompt: '一' }])
    state().updateCard(cardId, { prompt: '二' })
    vi.advanceTimersByTime(WORKBENCH_COALESCE_MS + 50)
    state().updateCard(cardId, { prompt: '三' })
    vi.useRealTimers()

    await state().undo()
    expect(state().cards[0].prompt).toBe('二')
    await state().undo()
    expect(state().cards[0].prompt).toBe('一')
    await state().undo()
    expect(state().cards).toHaveLength(0)

    await state().redo()
    expect(state().cards[0].prompt).toBe('一')
    await state().redo()
    expect(state().cards[0].prompt).toBe('二')
    await state().redo()
    expect(state().cards[0].prompt).toBe('三')
  })

  it('撤销自身不入撤销栈(否则重做永远轮不到)', async () => {
    const [cardId] = state().addCards([{ prompt: '一' }])
    state().updateCard(cardId, { prompt: '二' })
    const depth = state().undoStack.length

    await state().undo()

    expect(state().undoStack).toHaveLength(depth - 1)
    expect(state().redoStack).toHaveLength(1)
  })

  it('撤销会 bump structureRevision:agent 手里的整份 IR 随之作废', async () => {
    const [cardId] = state().addCards([{ prompt: '一' }])
    state().updateCard(cardId, { prompt: '二' })
    const stale = state().exportIR()

    await state().undo()

    const applied = await state().applyIR(stale)
    expect(applied.ok).toBe(false)
    expect(applied.conflict).toEqual({
      expected: stale.structureRevision,
      actual: state().structureRevision,
    })
  })

  it('撤销把卡片的 rev 往上推,不跟着快照回退', async () => {
    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })
    const revAfterEdit = state().cards[0].rev!

    await state().undo()

    // 内容回到「旧」,但 rev 继续往上 —— 否则一份撤销前导出的 IR 会看到匹配的
    // rev 而校验通过,把被撤销掉的内容悄悄写回来。
    expect(state().cards[0].prompt).toBe('旧')
    expect(state().cards[0].rev!).toBeGreaterThan(revAfterEdit)
  })
})

describe('撤销删剧', () => {
  it('removeProject 后 undo 复活剧、分段、卡片并回到那部剧;redo 再删', async () => {
    const p2 = state().addProject('第二部')
    state().addCards([{ prompt: 'in-p2' }])
    expect(state().removeProject(p2).ok).toBe(true)
    expect(state().projects.some((p) => p.id === p2)).toBe(false)
    const r = await state().undo()
    expect(r.ok).toBe(true)
    expect(state().projects.some((p) => p.id === p2)).toBe(true)
    expect(state().boards.some((b) => b.projectId === p2)).toBe(true)
    expect(state().cards.some((c) => c.prompt === 'in-p2')).toBe(true)
    expect(state().activeProjectId).toBe(p2)
    await state().redo()
    expect(state().projects.some((p) => p.id === p2)).toBe(false)
    expect(state().boards.some((b) => b.projectId === p2)).toBe(false)
  })
})
