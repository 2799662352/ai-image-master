// 回收站 + 分段 Fork + 置顶:剧/分段的软删除、恢复、彻底删除、水合分流、
// 撤销/重做/agent 整板写不把有内容的东西永久抹掉。
// jsdom 无 IndexedDB → WorkbenchDb 内存降级;每个用例 reset store + db,不碰真实库。
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../../../../../types/videoWorkbench'
import { ACTIVE_PROJECT_KEY, PINS_KEY, pinnedFirst } from '../projects'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

const S = () => useVideoWorkbenchStore.getState()
const boardsOf = (projectId: string) =>
  S()
    .boards.filter((b) => b.projectId === projectId)
    .sort((a, b) => a.order - b.order)
const cardsOfBoard = (boardId: string) => S().cards.filter((c) => c.boardId === boardId)

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(PINS_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

/** store 里的库写是 fire-and-forget;水合前让它们落完。 */
const flushDb = () => new Promise<void>((resolve) => setTimeout(resolve, 20))
const dbReady = async () => {
  await flushDb()
  return getWorkbenchDb()
}

/** 新建一部带内容的剧:两个分段,第一段两张卡。返回 [剧 id, 段 A, 段 B]。 */
function seedProject(name = '追车戏'): [string, string, string] {
  const pid = S().addProject(name)
  const a = boardsOf(pid)[0].id
  S().switchBoard(a)
  S().addCards([{ prompt: 'A1' }, { prompt: 'A2' }])
  const b = S().addBoard('隧道')
  S().addCards([{ prompt: 'B1' }])
  return [pid, a, b]
}

describe('trashProject', () => {
  it('剧连同分段和卡片移入回收站;活数据里看不到;库里只打标记不删', async () => {
    const [pid, a, b] = seedProject()
    const before = S().revision
    expect(S().trashProject(pid)).toEqual({ ok: true })

    expect(S().projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(S().boards.some((x) => x.projectId === pid)).toBe(false)
    expect(S().cards.some((c) => c.prompt.startsWith('A') || c.prompt === 'B1')).toBe(false)
    expect(S().activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(S().revision).toBe(before + 1)

    expect(S().trash).toHaveLength(1)
    const entry = S().trash[0]
    expect(entry).toMatchObject({ id: pid, kind: 'project' })
    expect(entry.project?.name).toBe('追车戏')
    expect(entry.boards.map((x) => x.id)).toEqual([a, b])
    expect(entry.cards.map((c) => c.prompt).sort()).toEqual(['A1', 'A2', 'B1'])

    const db = await dbReady()
    const rec = (await db.listProjects()).find((p) => p.id === pid)!
    expect(rec.deletedAt).toBeTypeOf('number')
    expect((await db.listBoards()).filter((x) => x.projectId === pid).every((x) => x.deletedAt && x.deletedWithProject)).toBe(true)
    expect((await db.list()).filter((c) => c.boardId === a || c.boardId === b)).toHaveLength(3)
  })

  it('唯一一部剧拒绝;有生成中卡片拒绝', () => {
    expect(S().trashProject(DEFAULT_PROJECT_ID)).toMatchObject({ ok: false })
    const [pid] = seedProject()
    const running = S().cards.find((c) => c.prompt === 'A1')!.id
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === running ? { ...c, status: 'running', taskId: 't' } : c)),
    }))
    expect(S().trashProject(pid)).toMatchObject({ ok: false })
    expect(S().trash).toHaveLength(0)
  })

  it('删的是当前剧 → 切回第一部剧,并清掉它记住的视图', () => {
    const [pid] = seedProject()
    expect(S().activeProjectId).toBe(pid)
    S().trashProject(pid)
    expect(S().activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(S().viewByProject[pid]).toBeUndefined()
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe(DEFAULT_PROJECT_ID)
  })

  it('Ctrl+Z 救回来,且回收站里不再留一份', async () => {
    const [pid] = seedProject()
    S().trashProject(pid)
    expect(S().trash).toHaveLength(1)
    const r = await S().undo()
    expect(r.ok).toBe(true)
    expect(S().projects.some((p) => p.id === pid)).toBe(true)
    expect(S().trash).toHaveLength(0)
    expect(S().cards.filter((c) => c.prompt.startsWith('A'))).toHaveLength(2)
    // 库里的删除标记随之清掉
    const rec = (await (await dbReady()).listProjects()).find((p) => p.id === pid)!
    expect(rec.deletedAt).toBeUndefined()
  })

  it('重做「删除」是回到回收站,而不是永久抹掉', async () => {
    const [pid] = seedProject()
    S().trashProject(pid)
    await S().undo()
    expect(S().trash).toHaveLength(0)
    const r = await S().redo()
    expect(r.ok).toBe(true)
    expect(S().projects.some((p) => p.id === pid)).toBe(false)
    expect(S().trash.map((e) => e.id)).toEqual([pid])
    expect(S().trash[0].cards).toHaveLength(3)
    const rec = (await (await dbReady()).listProjects()).find((p) => p.id === pid)
    expect(rec?.deletedAt).toBeTypeOf('number')
  })
})

describe('trashBoard', () => {
  it('分段移入回收站,剩余段 order 压实,删的是当前段则回总览', async () => {
    const [pid, a, b] = seedProject()
    S().switchBoard(b)
    expect(S().trashBoard(b)).toEqual({ ok: true })
    expect(boardsOf(pid).map((x) => x.id)).toEqual([a])
    expect(boardsOf(pid)[0].order).toBe(0)
    expect(S().viewByProject[pid]).toEqual({ mode: 'overview' })
    expect(S().activeBoardId).toBe(a)
    expect(cardsOfBoard(b)).toHaveLength(0)

    expect(S().trash[0]).toMatchObject({ id: b, kind: 'board', projectId: pid })
    expect(S().trash[0].cards.map((c) => c.prompt)).toEqual(['B1'])
    const rec = (await (await dbReady()).listBoards()).find((x) => x.id === b)!
    expect(rec.deletedAt).toBeTypeOf('number')
    expect(rec.deletedWithProject).toBeUndefined()
  })

  it('本剧仅剩一段 / 有生成中卡片 → 拒绝', () => {
    const [pid, a, b] = seedProject()
    const running = S().cards.find((c) => c.prompt === 'B1')!.id
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === running ? { ...c, status: 'queued', taskId: 't' } : c)),
    }))
    expect(S().trashBoard(b)).toMatchObject({ ok: false })
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === running ? { ...c, status: 'succeeded' } : c)),
    }))
    expect(S().trashBoard(b).ok).toBe(true)
    expect(S().trashBoard(a)).toMatchObject({ ok: false }) // 只剩一段
    expect(boardsOf(pid)).toHaveLength(1)
  })
})

describe('restoreFromTrash', () => {
  it('恢复剧:带回全部分段和卡片、排到剧栏末尾、不切换当前视图,库里标记清掉', async () => {
    const [pid, a, b] = seedProject()
    S().trashProject(pid)
    const other = S().addProject('第三部')
    expect(S().restoreFromTrash(pid)).toEqual({ ok: true })
    expect(S().trash).toHaveLength(0)
    const restored = S().projects.find((p) => p.id === pid)!
    expect(restored.order).toBe(S().projects.length - 1)
    expect(restored.deletedAt).toBeUndefined()
    expect(boardsOf(pid).map((x) => x.id)).toEqual([a, b])
    expect(cardsOfBoard(a).map((c) => c.prompt).sort()).toEqual(['A1', 'A2'])
    expect(cardsOfBoard(b).map((c) => c.prompt)).toEqual(['B1'])
    expect(S().activeProjectId).toBe(other)

    const db = await dbReady()
    expect((await db.listProjects()).find((p) => p.id === pid)!.deletedAt).toBeUndefined()
    expect((await db.listBoards()).filter((x) => x.projectId === pid).some((x) => x.deletedAt)).toBe(false)
  })

  it('恢复分段:放回原来的剧末尾', () => {
    const [pid, a, b] = seedProject()
    S().trashBoard(a)
    expect(S().restoreFromTrash(a)).toEqual({ ok: true })
    expect(boardsOf(pid).map((x) => x.id)).toEqual([b, a])
    expect(boardsOf(pid).map((x) => x.order)).toEqual([0, 1])
    expect(cardsOfBoard(a).map((c) => c.prompt).sort()).toEqual(['A1', 'A2'])
    expect(S().trash).toHaveLength(0)
  })

  it('分段所属的剧也在回收站 → 拒绝并说明先恢复哪部;先恢复剧后再恢复分段', () => {
    const [pid, a] = seedProject()
    S().trashBoard(a)
    S().trashProject(pid)
    const r = S().restoreFromTrash(a)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('追车戏')
    expect(S().restoreFromTrash(pid).ok).toBe(true)
    // 剧里只带回随剧删除的段;之前单独删的 a 仍在回收站,现在可以恢复了
    expect(boardsOf(pid).map((x) => x.name)).toEqual(['隧道'])
    expect(S().trash.map((e) => e.id)).toEqual([a])
    expect(S().restoreFromTrash(a).ok).toBe(true)
    expect(boardsOf(pid)).toHaveLength(2)
  })

  it('恢复本身可撤销', async () => {
    const [pid] = seedProject()
    S().trashProject(pid)
    S().restoreFromTrash(pid)
    expect(S().projects.some((p) => p.id === pid)).toBe(true)
    await S().undo()
    expect(S().projects.some((p) => p.id === pid)).toBe(false)
    expect(S().trash.map((e) => e.id)).toEqual([pid])
  })
})

describe('purgeFromTrash / emptyTrash', () => {
  it('彻底删除剧:库里的剧、分段、卡片记录全部删掉;名下单独进过回收站的分段一并清掉', async () => {
    const [pid, a, b] = seedProject()
    S().trashBoard(a)
    S().trashProject(pid)
    expect(S().trash).toHaveLength(2)
    expect(S().purgeFromTrash(pid)).toBe(true)
    expect(S().trash).toHaveLength(0)
    const db = await dbReady()
    expect((await db.listProjects()).some((p) => p.id === pid)).toBe(false)
    expect((await db.listBoards()).some((x) => x.id === a || x.id === b)).toBe(false)
    expect((await db.list()).some((c) => c.prompt === 'A1' || c.prompt === 'B1')).toBe(false)
  })

  it('彻底删除分段只动它自己;不存在的 id 返回 false', async () => {
    const [pid, a, b] = seedProject()
    S().trashBoard(a)
    expect(S().purgeFromTrash('ghost')).toBe(false)
    expect(S().purgeFromTrash(a)).toBe(true)
    const db = await dbReady()
    expect((await db.listBoards()).some((x) => x.id === a)).toBe(false)
    expect((await db.list()).some((c) => c.prompt === 'A1')).toBe(false)
    expect((await db.listBoards()).some((x) => x.id === b)).toBe(true)
    expect(boardsOf(pid).map((x) => x.id)).toEqual([b])
  })

  it('emptyTrash 清空并返回条数', () => {
    const [pid, a] = seedProject()
    S().trashBoard(a)
    S().trashProject(pid)
    expect(S().emptyTrash()).toBe(2)
    expect(S().trash).toHaveLength(0)
  })

  it('彻底删除后顺手清掉置顶记录', () => {
    const [pid, a] = seedProject()
    S().setBoardPinned(a, true)
    S().setProjectPinned(pid, true)
    S().trashProject(pid)
    S().purgeFromTrash(pid)
    expect(S().pinnedProjectIds).toEqual([])
    expect(S().pinnedBoardIds).toEqual([])
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual({ projects: [], boards: [] })
  })
})

describe('水合分流', () => {
  it('库里带删除标记的剧/分段不进活数据而进回收站;它们的卡不会被当孤儿卡塞进第一页', async () => {
    const [pid, a, b] = seedProject()
    S().trashBoard(b)
    S().trashProject(pid)
    await flushDb()
    const db = await dbReady()

    resetWorkbenchStoreForTest() // 只重置 store,不动库
    await S().ensureHydrated()

    expect(S().projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    // 默认剧只有它自己的那一段,回收站里的 a / b 没有漏进来
    expect(boardsOf(DEFAULT_PROJECT_ID)).toHaveLength(1)
    expect(S().boards.some((x) => x.id === a || x.id === b)).toBe(false)
    expect(S().cards).toHaveLength(0) // 三张卡都在回收站里,没有漏进默认剧的第一页
    expect((await db.list()).filter((c) => c.boardId === a || c.boardId === b)).toHaveLength(3)

    const byId = new Map(S().trash.map((e) => [e.id, e]))
    expect([...byId.keys()].sort()).toEqual([b, pid].sort())
    expect(byId.get(pid)).toMatchObject({ kind: 'project' })
    expect(byId.get(pid)!.boards.map((x) => x.id)).toEqual([a])
    expect(byId.get(pid)!.cards.map((c) => c.prompt).sort()).toEqual(['A1', 'A2'])
    expect(byId.get(b)).toMatchObject({ kind: 'board', projectId: pid })
    // 回收站里取出的记录是干净的(没有删除标记)
    expect(byId.get(pid)!.project?.deletedAt).toBeUndefined()
    expect(byId.get(b)!.boards[0].deletedAt).toBeUndefined()

    // 水合后的回收站条目照样能恢复
    expect(S().restoreFromTrash(pid).ok).toBe(true)
    expect(boardsOf(pid).map((x) => x.id)).toEqual([a])
    expect(S().restoreFromTrash(b).ok).toBe(true)
    expect(cardsOfBoard(b).map((c) => c.prompt)).toEqual(['B1'])
  })

  it('没有任何删除标记时回收站为空,行为与以前一致', async () => {
    seedProject()
    await flushDb()
    resetWorkbenchStoreForTest()
    await S().ensureHydrated()
    expect(S().trash).toEqual([])
    // 内存里的默认剧从没写进过库,所以库里只有 seed 出来的那一部
    expect(S().projects).toHaveLength(1)
    expect(S().boards.filter((x) => x.projectId === S().projects[0].id)).toHaveLength(2)
  })
})

describe('撤销/重做/agent 整板写:有内容的删除进回收站,空的直接删', () => {
  it('撤销「新建一段」(空段)不往回收站里塞噪音', async () => {
    const [pid] = seedProject()
    const extra = S().addBoard('空段')
    expect(boardsOf(pid)).toHaveLength(3)
    await S().undo()
    expect(S().boards.some((x) => x.id === extra)).toBe(false)
    expect(S().trash).toHaveLength(0)
    expect((await (await dbReady()).listBoards()).some((x) => x.id === extra)).toBe(false)
  })

  it('agent 整板写(replace)删掉有卡的分段 → 进回收站,卡跟着走、不丢', async () => {
    const [pid, a, b] = seedProject()
    S().switchBoard(a)
    const ir = S().exportIR()
    // 只保留第一段:IR 里去掉第二段 → apply 会删掉 b
    const next = { ...ir, boards: ir.boards.filter((x) => x.id !== b) }
    const applied = await S().applyIR(next, { mode: 'replace' })
    expect(applied.ok).toBe(true)
    expect(S().boards.some((x) => x.id === b)).toBe(false)
    expect(S().trash.map((e) => e.id)).toEqual([b])
    expect(S().trash[0].cards.map((c) => c.prompt)).toEqual(['B1'])
    expect(boardsOf(pid).map((x) => x.id)).toEqual([a])
    expect((await (await dbReady()).list()).some((c) => c.prompt === 'B1')).toBe(true)
  })
})

describe('duplicateBoard(Fork 分段)', () => {
  it('紧跟在原段后面,卡片深拷贝(新 id、生成中重置为草稿),后面的段顺延,不切换视图', () => {
    const [pid, a, b] = seedProject()
    const running = S().cards.find((c) => c.prompt === 'A1')!.id
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === running ? { ...c, status: 'running', taskId: 't' } : c)),
    }))
    const before = S().revision
    const active = S().activeBoardId
    const copy = S().duplicateBoard(a)!
    expect(copy).not.toBe(a)
    expect(boardsOf(pid).map((x) => x.id)).toEqual([a, copy, b])
    expect(boardsOf(pid).map((x) => x.order)).toEqual([0, 1, 2])
    expect(S().boards.find((x) => x.id === copy)!.name).toBe('分段 1 副本')
    const copied = cardsOfBoard(copy)
    expect(copied.map((c) => c.prompt).sort()).toEqual(['A1', 'A2'])
    expect(copied.every((c) => c.id !== running)).toBe(true)
    expect(copied.find((c) => c.prompt === 'A1')).toMatchObject({ status: 'draft' })
    expect(cardsOfBoard(a)).toHaveLength(2)
    expect(S().activeBoardId).toBe(active)
    expect(S().revision).toBe(before + 1)
  })

  it('重名时「副本 2」;不存在返回 null;库里写了新段和卡', async () => {
    const [, a] = seedProject()
    const c1 = S().duplicateBoard(a)!
    const c2 = S().duplicateBoard(a)!
    expect(S().boards.find((x) => x.id === c1)!.name).toBe('分段 1 副本')
    expect(S().boards.find((x) => x.id === c2)!.name).toBe('分段 1 副本 2')
    expect(S().duplicateBoard('ghost')).toBeNull()
    const db = await dbReady()
    expect((await db.listBoards()).some((x) => x.id === c2)).toBe(true)
    expect((await db.list()).filter((c) => c.boardId === c2)).toHaveLength(2)
  })
})

describe('置顶', () => {
  it('置顶/取消置顶写 localStorage,不动版本号、不进撤销栈;不存在的 id 忽略', () => {
    const [pid, a] = seedProject()
    const rev = S().revision
    const depth = S().undoStack.length
    S().setProjectPinned(pid, true)
    S().setBoardPinned(a, true)
    S().setProjectPinned('ghost', true)
    expect(S().pinnedProjectIds).toEqual([pid])
    expect(S().pinnedBoardIds).toEqual([a])
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual({ projects: [pid], boards: [a] })
    expect(S().revision).toBe(rev)
    expect(S().undoStack.length).toBe(depth)
    S().setProjectPinned(pid, false)
    expect(S().pinnedProjectIds).toEqual([])
  })

  it('pinnedFirst 稳定:置顶的排前,其余保持原顺序', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
    expect(pinnedFirst(items, ['c', 'a']).map((x) => x.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(pinnedFirst(items, []).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
