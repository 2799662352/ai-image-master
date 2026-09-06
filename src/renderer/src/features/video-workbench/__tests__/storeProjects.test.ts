// 剧(project)层:默认项目、新建/切换/改名/删除、分段归属、跨剧移动、水合回填、隔离。
// jsdom 无 IndexedDB → WorkbenchDb 内存降级;每个用例 reset store + db。
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../../../../../types/videoWorkbench'
import { ACTIVE_PROJECT_KEY } from '../projects'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

const S = () => useVideoWorkbenchStore.getState()
const boardsOf = (projectId: string) =>
  S()
    .boards.filter((b) => b.projectId === projectId)
    .sort((a, b) => a.order - b.order)

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('初始与默认项目', () => {
  it('初始有默认项目,初始页归它,视图为分段页', () => {
    expect(S().projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(S().activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(S().boards[0].projectId).toBe(DEFAULT_PROJECT_ID)
    expect(S().viewByProject[DEFAULT_PROJECT_ID]?.mode).toBe('board')
  })
})

describe('addProject / switchProject', () => {
  it('新建剧自带「分段 1」、切过去、停在总览、活动页指向新分段', () => {
    const before = S().revision
    const id = S().addProject()
    const p = S().projects.find((x) => x.id === id)!
    expect(p.name).toBe('未命名剧 2')
    expect(S().activeProjectId).toBe(id)
    expect(boardsOf(id).map((b) => b.name)).toEqual(['分段 1'])
    expect(S().activeBoardId).toBe(boardsOf(id)[0].id)
    expect(S().viewByProject[id]).toEqual({ mode: 'overview' })
    expect(S().revision).toBe(before + 1)
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe(id)
  })

  it('切回旧剧恢复它上次的视图与分段', () => {
    const p1 = S().activeProjectId
    const b1 = S().activeBoardId
    S().openBoard(b1)
    const p2 = S().addProject('第二部')
    S().switchProject(p1)
    expect(S().activeProjectId).toBe(p1)
    expect(S().activeBoardId).toBe(b1)
    expect(S().viewByProject[p1]).toEqual({ mode: 'board', boardId: b1 })
    S().switchProject(p2)
    expect(S().viewByProject[p2]).toEqual({ mode: 'overview' })
  })

  it('addCards 落在当前剧的活动分段,别的剧看不到', () => {
    const p1 = S().activeProjectId
    S().addCards([{ prompt: 'A' }])
    const p2 = S().addProject()
    S().addCards([{ prompt: 'B' }])
    const cardsOf = (pid: string) => {
      const ids = new Set(boardsOf(pid).map((b) => b.id))
      return S()
        .cards.filter((c) => c.boardId && ids.has(c.boardId))
        .map((c) => c.prompt)
    }
    expect(cardsOf(p1)).toEqual(['A'])
    expect(cardsOf(p2)).toEqual(['B'])
  })
})

describe('addBoard / removeBoard 在剧内', () => {
  it('addBoard 归当前剧,命名「分段 N」按剧内计数;删到本剧仅剩一段时拒绝', () => {
    const p2 = S().addProject()
    const b = S().addBoard()
    expect(S().boards.find((x) => x.id === b)!.projectId).toBe(p2)
    expect(boardsOf(p2).map((x) => x.name)).toEqual(['分段 1', '分段 2'])
    expect(S().removeBoard(b)).toBe(true)
    expect(S().removeBoard(boardsOf(p2)[0].id)).toBe(false)
    // 默认项目那边还是可以有一页,不受影响
    expect(boardsOf(DEFAULT_PROJECT_ID)).toHaveLength(1)
  })

  it('removeBoard 删掉当前段后回到总览', () => {
    const p2 = S().addProject()
    const b = S().addBoard()
    expect(S().activeBoardId).toBe(b)
    S().removeBoard(b)
    expect(S().viewByProject[p2]).toEqual({ mode: 'overview' })
    expect(S().activeBoardId).toBe(boardsOf(p2)[0].id)
  })

  it('switchBoard 到别的剧的分段会把当前剧也切过去', () => {
    const p1 = S().activeProjectId
    const b1 = S().activeBoardId
    S().addProject()
    S().switchBoard(b1)
    expect(S().activeProjectId).toBe(p1)
    expect(S().viewByProject[p1]).toEqual({ mode: 'board', boardId: b1 })
  })
})

describe('moveBoardToProject / renameProject / reorderProjects', () => {
  it('分段搬到另一部剧后 order 两边各自压实,源剧若空出则拒绝', () => {
    const p1 = S().activeProjectId
    const b1a = S().activeBoardId
    const b1b = S().addBoard()
    const p2 = S().addProject()
    expect(S().moveBoardToProject(b1b, p2)).toBe(true)
    expect(boardsOf(p1).map((b) => b.id)).toEqual([b1a])
    expect(boardsOf(p2).map((b) => b.order)).toEqual([0, 1])
    // p1 只剩一段,再搬就会空出 → 拒绝
    expect(S().moveBoardToProject(b1a, p2)).toBe(false)
  })

  it('改名 trim 后为空拒绝;同名不涨版本;改名清 legacy;reorder 要给全集', () => {
    const p1 = S().activeProjectId
    const p2 = S().addProject()
    expect(S().renameProject(p1, '   ')).toBe(false)
    const rev = S().revision
    expect(S().renameProject(p1, S().projects[0].name)).toBe(true)
    expect(S().revision).toBe(rev)
    expect(S().projects.find((p) => p.id === p1)!.legacy).toBe(true)
    expect(S().renameProject(p1, '我的第一部')).toBe(true)
    expect(S().projects.find((p) => p.id === p1)!.legacy).toBeUndefined()
    expect(S().reorderProjects([p2])).toBe(false)
    expect(S().reorderProjects([p2, p1])).toBe(true)
    expect(S().projects.map((p) => p.id)).toEqual([p2, p1])
    expect(S().projects.map((p) => p.order)).toEqual([0, 1])
  })
})

describe('duplicateProject', () => {
  it('复制出新 id 的剧/分段/卡片,已完成结果保留,生成中重置为草稿', () => {
    const p1 = S().activeProjectId
    S().addCards([{ prompt: 'done' }, { prompt: 'running' }])
    const [done, running] = S().cards.map((c) => c.id)
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) =>
        c.id === done
          ? { ...c, status: 'succeeded', remoteUrl: 'https://cos/x.mp4' }
          : c.id === running
            ? { ...c, status: 'running', taskId: 't' }
            : c,
      ),
    }))
    const copy = S().duplicateProject(p1)!
    expect(copy).not.toBe(p1)
    expect(S().projects.find((p) => p.id === copy)!.name).toBe('默认项目 副本')
    const copiedBoards = boardsOf(copy)
    expect(copiedBoards).toHaveLength(1)
    expect(copiedBoards[0].id).not.toBe(boardsOf(p1)[0].id)
    const copied = S().cards.filter((c) => c.boardId === copiedBoards[0].id)
    expect(copied.map((c) => c.prompt).sort()).toEqual(['done', 'running'])
    expect(copied.find((c) => c.prompt === 'done')).toMatchObject({ status: 'succeeded', remoteUrl: 'https://cos/x.mp4' })
    expect(copied.find((c) => c.prompt === 'running')).toMatchObject({ status: 'draft' })
    expect(copied.every((c) => c.id !== done && c.id !== running)).toBe(true)
  })
})

describe('removeProject', () => {
  it('删剧连带分段和卡片;唯一一部剧拒删;有生成中卡片拒删', async () => {
    const p1 = S().activeProjectId
    expect(S().removeProject(p1).ok).toBe(false)
    const p2 = S().addProject()
    S().addCards([{ prompt: 'x' }])
    const cardId = S().cards.find((c) => c.prompt === 'x')!.id
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, status: 'running', taskId: 't' } : c)),
    }))
    expect(S().removeProject(p2)).toMatchObject({ ok: false })
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, status: 'succeeded' } : c)),
    }))
    expect(S().removeProject(p2).ok).toBe(true)
    expect(S().projects.map((p) => p.id)).toEqual([p1])
    expect(boardsOf(p2)).toHaveLength(0)
    expect(S().cards.some((c) => c.id === cardId)).toBe(false)
    expect(S().activeProjectId).toBe(p1)
    expect((await getWorkbenchDb().listProjects()).map((p) => p.id)).toEqual([p1])
  })
})

describe('moveCardToBoard', () => {
  it('卡片挪到另一段末尾,两边 order 压实;目标不存在返回 false;生成中不挪', () => {
    S().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    const [a, b] = S().cards.map((c) => c.id)
    const b2 = S().addBoard('第二段')
    expect(S().moveCardToBoard(a, 'ghost')).toBe(false)
    const rev = S().revision
    expect(S().moveCardToBoard(a, b2)).toBe(true)
    expect(S().revision).toBe(rev + 1)
    expect(S().cards.find((c) => c.id === a)!).toMatchObject({ boardId: b2, order: 0 })
    expect(S().cards.find((c) => c.id === b)!.order).toBe(0)
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === b ? { ...c, status: 'running', taskId: 't' } : c)),
    }))
    expect(S().moveCardToBoard(b, b2)).toBe(false)
  })
})

describe('水合回填', () => {
  it('库里的老 board 没有 projectId → 归默认项目并写回;activeProjectId 从 localStorage 恢复', async () => {
    const db = getWorkbenchDb()
    await db.putBoard({ id: 'old-1', name: '页面 1', order: 0, createdAt: 1 } as never)
    await db.putBoard({ id: 'old-2', name: '页面 2', order: 1, createdAt: 2 } as never)
    await db.putProject({ id: 'p9', name: '别的剧', order: 1, createdAt: 1, updatedAt: 1 })
    await db.putBoard({ id: 'b9', name: '分段 1', order: 0, createdAt: 3, projectId: 'p9' })
    localStorage.setItem(ACTIVE_PROJECT_KEY, 'p9')
    resetWorkbenchStoreForTest()
    await S().ensureHydrated()
    expect(boardsOf(DEFAULT_PROJECT_ID).map((b) => b.id)).toEqual(['old-1', 'old-2'])
    expect(S().activeProjectId).toBe('p9')
    expect(S().activeBoardId).toBe('b9')
    expect((await db.listBoards()).every((b) => b.projectId)).toBe(true)
  })

  it('localStorage 里的剧不存在 → 回第一部剧', async () => {
    localStorage.setItem(ACTIVE_PROJECT_KEY, 'ghost')
    await S().ensureHydrated()
    expect(S().activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(S().boards.find((b) => b.id === S().activeBoardId)!.projectId).toBe(DEFAULT_PROJECT_ID)
  })

  it('库里一部剧没有任何分段 → 水合补一段', async () => {
    const db = getWorkbenchDb()
    await db.putProject({ id: 'empty', name: '空剧', order: 1, createdAt: 1, updatedAt: 1 })
    await S().ensureHydrated()
    expect(boardsOf('empty').map((b) => b.name)).toEqual(['分段 1'])
  })
})
