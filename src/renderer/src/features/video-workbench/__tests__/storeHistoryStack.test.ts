// store 侧的撤销/重做接线:入栈由 revision 变化驱动(编排动作入栈、生成回流不
// 入栈)、撤销/重做的栈搬运、新编辑清空重做栈、落盘增量、栈深上限。
// IndexedDB 在 jsdom 缺失 → WorkbenchDb 自动内存降级。

import { beforeEach, describe, expect, it } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../../types/seedance'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { WORKBENCH_HISTORY_LIMIT } from '../workbenchHistory'
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
    const [cardId] = state().addCards([{ prompt: '一' }])
    state().updateCard(cardId, { prompt: '二' })
    state().updateCard(cardId, { prompt: '三' })

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

  it('撤销会 bump revision:agent 手里的旧 IR 令牌随之失效', async () => {
    const [cardId] = state().addCards([{ prompt: '一' }])
    state().updateCard(cardId, { prompt: '二' })
    const stale = state().exportIR()

    await state().undo()

    const applied = await state().applyIR(stale)
    expect(applied.ok).toBe(false)
    expect(applied.conflict).toEqual({ expected: stale.revision, actual: state().revision })
  })
})
