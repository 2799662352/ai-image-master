// store 侧的看板 IR 接线:revision 令牌的递增纪律(编排改动递增、无操作与
// 生成回流不递增)、exportIR/applyIR 的落盘增量。
// IndexedDB 在 jsdom 缺失 → WorkbenchDb 自动内存降级,「重载」= 只 reset store。

import { beforeEach, describe, expect, it } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../../types/seedance'
import type { WorkbenchIR } from '../../../../../types/videoWorkbench'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

function state() {
  return useVideoWorkbenchStore.getState()
}

function revision(): number {
  return state().revision
}

/** 跑一个动作,返回 revision 的增量。 */
function delta(run: () => void): number {
  const before = revision()
  run()
  return revision() - before
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
  delete (window as any).electronAPI
})

describe('revision 令牌', () => {
  it('初始为 0', () => {
    expect(revision()).toBe(0)
  })

  it('每个编排动作各递增 1', () => {
    const [cardId] = state().addCards([{ prompt: 'A' }])
    expect(revision()).toBe(1)

    expect(delta(() => state().addCards([{ prompt: 'B' }]))).toBe(1)
    expect(delta(() => state().updateCard(cardId, { prompt: 'A+' }))).toBe(1)
    expect(delta(() => state().moveCard(cardId, 1))).toBe(1)
    expect(delta(() => state().addMaterials(cardId, 'referenceImages', [{ name: 'x', src: 'D:/x.png' }]))).toBe(1)
    expect(delta(() => state().addMaterials(cardId, 'referenceImages', [{ name: 'y', src: 'D:/y.png' }]))).toBe(1)
    expect(delta(() => state().moveMaterial(cardId, 'referenceImages', 0, 1))).toBe(1)
    expect(delta(() => state().removeMaterial(cardId, 'referenceImages', 0))).toBe(1)
    expect(delta(() => state().removeCard(cardId))).toBe(1)

    const boardId = state().addBoard('第二幕')
    expect(delta(() => { state().renameBoard(boardId, '开场') })).toBe(1)
    expect(delta(() => { state().removeBoard(boardId) })).toBe(1)
  })

  it('无操作不递增(不该白让 agent 的令牌失效)', () => {
    const [cardId] = state().addCards([{ prompt: 'A' }])
    const boardId = state().activeBoardId

    expect(delta(() => state().updateCard('ghost', { prompt: 'x' }))).toBe(0)
    expect(delta(() => state().removeCard('ghost'))).toBe(0)
    expect(delta(() => state().moveCard('ghost', 0))).toBe(0)
    expect(delta(() => state().moveCard(cardId, 0))).toBe(0) // 原地不动
    expect(delta(() => state().addMaterials('ghost', 'referenceImages', []))).toBe(0)
    expect(delta(() => state().removeMaterial(cardId, 'referenceImages', 9))).toBe(0)
    expect(delta(() => state().moveMaterial(cardId, 'referenceImages', 0, 0))).toBe(0)
    // 仅剩一页时删页被拒;重命名成同名是无操作;切页不是编排改动。
    expect(delta(() => { state().removeBoard(boardId) })).toBe(0)
    expect(delta(() => { state().renameBoard(boardId, state().boards[0].name) })).toBe(0)
    expect(delta(() => { state().renameBoard(boardId, '   ') })).toBe(0)
    expect(delta(() => state().switchBoard(boardId))).toBe(0)
  })

  it('生成状态回流不递增 —— 否则跑着一个任务就让每次 apply 都撞冲突', () => {
    const [cardId] = state().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.setState({
      cards: state().cards.map((c) => (c.id === cardId ? { ...c, taskId: 'task-1', status: 'queued' } : c)),
    })
    const before = revision()
    state().applyTaskUpdate(makeUpdate({ status: 'running' }))
    state().applyTaskUpdate(makeUpdate({ status: 'succeeded', persistence: 'done', localPath: 'D:/v.mp4' }))
    expect(revision()).toBe(before)
  })
})

describe('exportIR / applyIR', () => {
  it('exportIR 反映当前状态与 revision', () => {
    state().addCards([{ prompt: '一只猫' }, { prompt: '一只狗' }])
    const ir = state().exportIR()
    expect(ir.revision).toBe(revision())
    expect(ir.boards).toHaveLength(1)
    expect(ir.boards[0].cards.map((c) => c.prompt)).toEqual(['一只猫', '一只狗'])
  })

  it('applyIR 落库:重排 + 新建 + 删除都能在「重载」后还原', async () => {
    const [c1, c2] = state().addCards([{ prompt: 'A' }, { prompt: 'B' }])
    const ir = state().exportIR()
    const applied = await state().applyIR({
      ...ir,
      boards: [{
        id: ir.boards[0].id,
        name: '开场',
        cards: [
          { id: c2, prompt: 'B' },
          { prompt: '新镜', model: '2.0-fast' },
        ],
      }],
    }, { mode: 'replace' })

    expect(applied.ok).toBe(true)
    expect(applied.cards.removed).toEqual([c1])
    expect(applied.cards.created).toHaveLength(1)
    expect(applied.boards.renamed).toEqual([ir.boards[0].id])
    expect(applied.revision).toBe(ir.revision + 1)
    expect(revision()).toBe(applied.revision)

    // 「重载」:只 reset store,库里的内容重新水合回来。
    resetWorkbenchStoreForTest()
    await state().ensureHydrated()
    const reloaded = state()
    expect(reloaded.boards.map((b) => b.name)).toEqual(['开场'])
    const cards = reloaded.cards.sort((a, b) => a.order - b.order)
    expect(cards.map((c) => c.prompt)).toEqual(['B', '新镜'])
    expect(cards[1].model).toBe('2.0-fast')
  })

  it('revision 过期时 applyIR 拒绝,状态与库都不动', async () => {
    state().addCards([{ prompt: 'A' }])
    const stale = state().exportIR()
    state().addCards([{ prompt: '用户后来加的' }]) // revision 前进了

    const result = await state().applyIR({
      ...stale,
      boards: [{ ...stale.boards[0], cards: [] }],
    }, { mode: 'replace' })

    expect(result.ok).toBe(false)
    expect(result.conflict).toEqual({ expected: stale.revision, actual: revision() })
    expect(state().cards.map((c) => c.prompt)).toEqual(['A', '用户后来加的'])
    expect((await getWorkbenchDb().list()).length).toBe(2)
  })

  it('applyIR 不写没变的卡(避免整页写放大)', async () => {
    const [c1] = state().addCards([{ prompt: 'A' }, { prompt: 'B' }, { prompt: 'C' }])
    const ir = state().exportIR()
    const before = (await getWorkbenchDb().list()).find((c) => c.id === c1)!

    const next: WorkbenchIR = {
      ...ir,
      boards: [{
        ...ir.boards[0],
        cards: ir.boards[0].cards.map((c, i) => (i === 1 ? { ...c, prompt: 'B+' } : c)),
      }],
    }
    const applied = await state().applyIR(next)
    expect(applied.cards.updated).toHaveLength(1)
    expect(applied.cards.moved).toEqual([])
    // 未触碰的卡在库里是同一份(updatedAt 没被无谓刷新)。
    const after = (await getWorkbenchDb().list()).find((c) => c.id === c1)!
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('applyIR 切页会持久化 activeBoardId', async () => {
    const second = state().addBoard('第二幕')
    state().switchBoard(state().boards[0].id)
    const ir = state().exportIR()
    await state().applyIR({ ...ir, activeBoardId: second })
    expect(state().activeBoardId).toBe(second)
    expect(localStorage.getItem(ACTIVE_BOARD_KEY)).toBe(second)
  })
})
