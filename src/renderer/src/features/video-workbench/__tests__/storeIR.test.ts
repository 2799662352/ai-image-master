// store 侧的看板 IR 接线:两级并发令牌的递增纪律(structureRevision 只跟卡片
// 集合/位置/页走,按卡 rev 只跟该卡规格走,生成回流两者都不动)、exportIR/applyIR
// 的落盘增量。
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

function structureRevision(): number {
  return state().structureRevision
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
  it('exportIR 反映当前状态与两级令牌', () => {
    state().addCards([{ prompt: '一只猫' }, { prompt: '一只狗' }])
    const ir = state().exportIR()
    expect(ir.structureRevision).toBe(structureRevision())
    expect(ir.boards).toHaveLength(1)
    expect(ir.boards[0].cards.map((c) => c.prompt)).toEqual(['一只猫', '一只狗'])
    expect(ir.boards[0].cards.map((c) => c.rev)).toEqual([0, 0])
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
    expect(applied.structureRevision).toBe(ir.structureRevision + 1)
    expect(structureRevision()).toBe(applied.structureRevision)

    // 「重载」:只 reset store,库里的内容重新水合回来。
    resetWorkbenchStoreForTest()
    await state().ensureHydrated()
    const reloaded = state()
    expect(reloaded.boards.map((b) => b.name)).toEqual(['开场'])
    const cards = reloaded.cards.sort((a, b) => a.order - b.order)
    expect(cards.map((c) => c.prompt)).toEqual(['B', '新镜'])
    expect(cards[1].model).toBe('2.0-fast')
  })

  it('用户加过卡 → structureRevision 过期,applyIR 整份拒绝,状态与库都不动', async () => {
    state().addCards([{ prompt: 'A' }])
    const stale = state().exportIR()
    state().addCards([{ prompt: '用户后来加的' }]) // 结构变了

    const result = await state().applyIR({
      ...stale,
      boards: [{ ...stale.boards[0], cards: [] }],
    }, { mode: 'replace' })

    expect(result.ok).toBe(false)
    expect(result.conflict).toEqual({
      expected: stale.structureRevision,
      actual: structureRevision(),
    })
    expect(state().cards.map((c) => c.prompt)).toEqual(['A', '用户后来加的'])
    expect((await getWorkbenchDb().list()).length).toBe(2)
  })

  it('用户只在一张卡里打字 → 整份 apply 仍然成立,只跳过那一张', async () => {
    const [c1, c2] = state().addCards([{ prompt: 'A' }, { prompt: 'B' }])
    const ir = state().exportIR()

    // 用户在 c1 里打字(逐字符 updateCard)。结构没动,只有 c1 的 rev 涨了。
    state().updateCard(c1, { prompt: 'A 用户改的' })
    expect(structureRevision()).toBe(ir.structureRevision)

    const result = await state().applyIR({
      ...ir,
      boards: [{
        ...ir.boards[0],
        cards: ir.boards[0].cards.map((c) => ({ ...c, prompt: `agent 写的 ${c.id === c1 ? 1 : 2}` })),
      }],
    })

    expect(result.ok).toBe(true)
    expect(result.conflict).toBeUndefined()
    expect(result.cards.updated).toEqual([c2])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].cardId).toBe(c1)
    const byId = new Map(state().cards.map((c) => [c.id, c]))
    expect(byId.get(c1)!.prompt).toBe('A 用户改的')
    expect(byId.get(c2)!.prompt).toBe('agent 写的 2')
  })

  it('改卡不动 structureRevision,增删卡才动', () => {
    const [cardId] = state().addCards([{ prompt: 'A' }])
    const afterAdd = structureRevision()

    state().updateCard(cardId, { prompt: 'A+' })
    state().addMaterials(cardId, 'referenceImages', [{ name: 'x', src: 'D:/x.png' }])
    expect(structureRevision()).toBe(afterAdd)
    // 但「有改动」计数器照涨,撤销仍然可用
    expect(revision()).toBeGreaterThan(afterAdd)

    state().addCards([{ prompt: 'B' }])
    expect(structureRevision()).toBe(afterAdd + 1)
    state().moveCard(cardId, 1)
    expect(structureRevision()).toBe(afterAdd + 2)
    state().removeCard(cardId)
    expect(structureRevision()).toBe(afterAdd + 3)
  })

  it('用户整句打字期间 agent 仍能回写别的卡 —— 这是两级令牌存在的理由', async () => {
    const ids = state().addCards([{ prompt: '' }, { prompt: '' }, { prompt: '' }])
    const ir = state().exportIR()

    // 用户在第一张卡里逐字符打一整句(UI 的 onChange 就是这样)
    const sentence = '雨夜霓虹下的赛博朋克街头长镜头'
    for (let i = 1; i <= sentence.length; i++) {
      state().updateCard(ids[0], { prompt: sentence.slice(0, i) })
    }

    // 结构一步没动 → agent 那份 IR 整体仍然有效
    expect(structureRevision()).toBe(ir.structureRevision)

    const result = await state().applyIR({
      ...ir,
      boards: [{
        ...ir.boards[0],
        cards: ir.boards[0].cards.map((c, i) => ({ ...c, resolution: '1080p' as const, prompt: `镜 ${i}` })),
      }],
    })

    expect(result.ok).toBe(true)
    // 只有被用户碰过的那张被跳过,另外两张照写
    expect(result.cards.updated).toEqual([ids[1], ids[2]])
    expect(result.skipped.map((s) => s.cardId)).toEqual([ids[0]])
    const byId = new Map(state().cards.map((c) => [c.id, c]))
    expect(byId.get(ids[0])!.prompt).toBe(sentence)
    expect(byId.get(ids[0])!.resolution).toBe('720p')
    expect(byId.get(ids[1])!.resolution).toBe('1080p')
  })

  /**
   * 冲突要带现场值。人和 agent 同改一块看板时，「你写的被跳过了」只说明发生了冲突，
   * 说不清该怎么办 —— agent 为了看用户改了什么，得再 export 一次整板。把当前规格
   * 一并回带，那趟往返就省了，而且 agent 能自己判断：只是时长变了就按新值重写，
   * 提示词被整个换过就该停下来问。
   */
  it('按卡冲突把这张卡「现在的样子」一起回带,省掉再 export 一次', async () => {
    const [c1] = state().addCards([{ prompt: 'A' }])
    const ir = state().exportIR()

    // 用户改了提示词和时长（两次 updateCard，rev 从 0 涨到 2）。
    state().updateCard(c1, { prompt: '用户重写的提示词' })
    state().updateCard(c1, { duration: 12 })

    const result = await state().applyIR({
      ...ir,
      boards: [{ ...ir.boards[0], cards: [{ ...ir.boards[0].cards[0], prompt: 'agent 写的' }] }],
    })

    const skip = result.skipped.find((s) => s.cardId === c1)
    expect(skip, '这张卡应当被跳过').toBeTruthy()
    expect(skip!.current, '跳过项要带 current').toBeTruthy()
    // 字段级线索：用户改了时长、agent 改了提示词，两个都该被点名。
    expect(skip!.reason).toContain('duration(现 12s / 你写 5s)')
    expect(skip!.reason).toContain('prompt')
    expect(skip!.current!.prompt).toBe('用户重写的提示词')
    expect(skip!.current!.duration).toBe(12)
    // 抄这个 rev 回去即可覆盖，不必重新 export 整板。
    expect(skip!.current!.rev).toBe(2)
    // 用户的值没被覆盖。
    expect(state().cards.find((c) => c.id === c1)!.prompt).toBe('用户重写的提示词')
  })

  it('照 current.rev 重发就能覆盖 —— 冲突是可恢复的,不是死路', async () => {
    const [c1] = state().addCards([{ prompt: 'A' }])
    const ir = state().exportIR()
    state().updateCard(c1, { prompt: '用户改的' })

    const first = await state().applyIR({
      ...ir,
      boards: [{ ...ir.boards[0], cards: [{ ...ir.boards[0].cards[0], prompt: 'agent 第一次' }] }],
    })
    const rev = first.skipped.find((s) => s.cardId === c1)!.current!.rev

    const second = await state().applyIR({
      ...ir,
      structureRevision: first.structureRevision,
      boards: [{ ...ir.boards[0], cards: [{ ...ir.boards[0].cards[0], rev, prompt: 'agent 第二次' }] }],
    })
    expect(second.skipped).toHaveLength(0)
    expect(state().cards.find((c) => c.id === c1)!.prompt).toBe('agent 第二次')
  })

  it('非并发原因的跳过不带 current —— 那些拿现场值也没用', async () => {
    state().addCards([{ prompt: 'A' }])
    const ir = state().exportIR()
    const result = await state().applyIR({
      ...ir,
      boards: [{ ...ir.boards[0], cards: [{ ...ir.boards[0].cards[0], id: '不存在的卡' }] }],
    })
    const skip = result.skipped.find((s) => s.cardId === '不存在的卡')
    expect(skip).toBeTruthy()
    expect(skip!.current).toBeUndefined()
  })

  /**
   * updateCard 被输入框逐字符调用，也被失焦 / 重渲染用同一份值重复调用。无条件 bump
   * 的代价全落在 agent 身上：它手里那份 IR 的 rev 会因为一次「什么都没改」的调用作废，
   * 下次回写整张卡被跳过。改页名早就是这个口径，这里对齐。
   */
  it('值没变的 updateCard 是无操作 —— 不该白白作废 agent 手里的令牌', async () => {
    const [c1] = state().addCards([{ prompt: 'A', duration: 5 }])
    const ir = state().exportIR()
    const revBefore = state().revision

    // 失焦 / 重渲染用同一份值再调一次。
    state().updateCard(c1, { prompt: 'A' })
    state().updateCard(c1, { duration: 5 })

    expect(state().cards.find((c) => c.id === c1)!.rev).toBe(0)
    expect(state().revision).toBe(revBefore)

    // agent 那份导出仍然有效,整张卡照写不误。
    const result = await state().applyIR({
      ...ir,
      boards: [{ ...ir.boards[0], cards: [{ ...ir.boards[0].cards[0], prompt: 'agent 写的' }] }],
    })
    expect(result.skipped).toHaveLength(0)
    expect(state().cards.find((c) => c.id === c1)!.prompt).toBe('agent 写的')
  })

  it('但真改了一个字符照样 bump —— 不能为了少冲突把真冲突也吞掉', () => {
    const [c1] = state().addCards([{ prompt: 'A' }])
    state().updateCard(c1, { prompt: 'AB' })
    expect(state().cards.find((c) => c.id === c1)!.rev).toBe(1)
  })

  it('改卡片规格会 bump 那张卡的 rev,别的卡不受影响', () => {
    const [c1, c2] = state().addCards([{ prompt: 'A' }, { prompt: 'B' }])
    const byId = () => new Map(state().cards.map((c) => [c.id, c]))
    expect(byId().get(c1)!.rev).toBe(0)

    state().updateCard(c1, { prompt: 'A+' })
    state().addMaterials(c1, 'referenceImages', [{ name: 'x', src: 'D:/x.png' }])

    expect(byId().get(c1)!.rev).toBe(2)
    expect(byId().get(c2)!.rev).toBe(0)
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

  it('applyIR 删掉的卡从选中态里剔除 —— 悬空 id 会让 ⚡ 无参空跑,也会误导 agent', async () => {
    const [c1, c2] = state().addCards([{ prompt: 'A' }, { prompt: 'B' }])
    state().selectCard(c1)
    state().selectCard(c2, 'toggle')

    const ir = state().exportIR()
    const applied = await state().applyIR(
      { ...ir, boards: [{ ...ir.boards[0], cards: [{ id: c2, prompt: 'B' }] }] },
      { mode: 'replace' },
    )

    expect(applied.ok).toBe(true)
    expect(applied.cards.removed).toEqual([c1])
    expect(state().selectedCardIds).toEqual([c2])
    expect(state().selectionAnchorId).toBeUndefined()
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
