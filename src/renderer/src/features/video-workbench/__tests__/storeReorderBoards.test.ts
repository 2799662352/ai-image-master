// reorderBoards:一部剧里分段的整体重排(分段网格拖动排序 / 右键「前移·后移」的落点)。
// 契约同 reorderProjects:必须给全集、order 压实、顺序没变就不动任何东西;别的剧的分段不受牵连。
// jsdom 无 IndexedDB → WorkbenchDb 内存降级;每个用例 reset store + db。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY } from '../projects'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

const S = () => useVideoWorkbenchStore.getState()
const boardsOf = (projectId: string) =>
  S()
    .boards.filter((b) => b.projectId === projectId)
    .sort((a, b) => a.order - b.order)
const idsOf = (projectId: string) => boardsOf(projectId).map((b) => b.id)
const namesOf = (projectId: string) => boardsOf(projectId).map((b) => b.name)

/** 剧 A = 页面 1(默认项目自带的分段)/ 隧道 / 天台,剧 B = 另一部有两段的剧。返回 [A, B]。 */
function seed(): [string, string] {
  const a = S().activeProjectId
  S().addBoard('隧道')
  S().addBoard('天台')
  const b = S().addProject('夜景')
  S().addBoard('屋顶')
  S().switchProject(a)
  return [a, b]
}

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reorderBoards', () => {
  it('按给定的全量顺序重排,order 压实成 0..n-1,revision / structureRevision 各 +1', () => {
    const [a] = seed()
    const [x, y, z] = idsOf(a)
    const rev = S().revision
    const srev = S().structureRevision
    expect(S().reorderBoards(a, [z, x, y])).toBe(true)
    expect(namesOf(a)).toEqual(['天台', '页面 1', '隧道'])
    expect(boardsOf(a).map((b) => b.order)).toEqual([0, 1, 2])
    expect(S().revision).toBe(rev + 1)
    expect(S().structureRevision).toBe(srev + 1)
  })

  it('别的剧的分段原样不动(引用都不换),活动分段 / 视图不变', () => {
    const [a, b] = seed()
    const beforeB = boardsOf(b)
    const active = S().activeBoardId
    const view = S().viewByProject[a]
    const [x, y, z] = idsOf(a)
    S().reorderBoards(a, [y, z, x])
    const afterB = boardsOf(b)
    expect(afterB).toHaveLength(beforeB.length)
    afterB.forEach((board, i) => expect(board).toBe(beforeB[i]))
    expect(S().activeBoardId).toBe(active)
    expect(S().viewByProject[a]).toEqual(view)
  })

  it('只落盘 order 真的变了的分段:相邻互换 2 张,不是全部', async () => {
    const [a] = seed()
    const put = vi.spyOn(getWorkbenchDb(), 'putBoard')
    const [x, y, z] = idsOf(a)
    S().reorderBoards(a, [x, z, y]) // 只有 y、z 换了位
    await Promise.resolve()
    expect(put.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual([y, z].sort())
    // 库里(内存降级库一开始是空的,没动的分段本来就不会被写)拿到的是压实后的新 order
    const saved = (await getWorkbenchDb().listBoards()).filter((bd) => bd.projectId === a)
    expect(saved.map((bd) => [bd.id, bd.order]).sort()).toEqual(
      [
        [z, 1],
        [y, 2],
      ].sort(),
    )
  })

  it('必须给这部剧的全集:少给、多给、重复、含别剧的 id、含未知 id 都拒绝,且什么都不动', () => {
    const [a, b] = seed()
    const [x, y, z] = idsOf(a)
    const [other] = idsOf(b)
    const rev = S().revision
    const snapshot = S().boards
    expect(S().reorderBoards(a, [x, y])).toBe(false)
    expect(S().reorderBoards(a, [x, y, z, other])).toBe(false)
    expect(S().reorderBoards(a, [x, x, y])).toBe(false)
    expect(S().reorderBoards(a, [x, y, other])).toBe(false)
    expect(S().reorderBoards(a, [x, y, 'nope'])).toBe(false)
    expect(S().reorderBoards(a, [])).toBe(false)
    expect(S().reorderBoards('no-such-project', [x, y, z])).toBe(false)
    expect(S().revision).toBe(rev)
    expect(S().boards).toBe(snapshot)
  })

  it('顺序没变:返回 true,但不涨版本、不入撤销栈、不落盘', () => {
    const [a] = seed()
    const put = vi.spyOn(getWorkbenchDb(), 'putBoard')
    const depth = S().undoStack.length
    const rev = S().revision
    const snapshot = S().boards
    expect(S().reorderBoards(a, idsOf(a))).toBe(true)
    expect(S().revision).toBe(rev)
    expect(S().undoStack).toHaveLength(depth)
    expect(S().boards).toBe(snapshot)
    expect(put).not.toHaveBeenCalled()
  })

  it('撤销 = 顺序还原,重做 = 再排一次', async () => {
    const [a] = seed()
    const original = idsOf(a)
    const [x, y, z] = original
    const reordered = [z, y, x]
    S().reorderBoards(a, reordered)
    expect(idsOf(a)).toEqual(reordered)
    expect((await S().undo()).ok).toBe(true)
    expect(idsOf(a)).toEqual(original)
    expect((await S().redo()).ok).toBe(true)
    expect(idsOf(a)).toEqual(reordered)
  })
})
