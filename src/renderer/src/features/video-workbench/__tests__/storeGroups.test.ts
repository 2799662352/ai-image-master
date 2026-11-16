// 剧分组的 store 层:分组只是剧上的可选字段 `group`,摆放走 arrangeProjects(一步撤销、只写真变了的剧)。
// jsdom 无 IndexedDB → WorkbenchDb 内存降级(只验内存 fake,不碰任何真实库);每个用例 reset store + db + localStorage。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSED_GROUPS_KEY, EMPTY_GROUPS_KEY, PINS_KEY, readGroupNames } from '../projects'
import { planMoveProject } from '../projectGroups'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'
import type { ImportPlan } from '../projectFile'

const S = () => useVideoWorkbenchStore.getState()
const sorted = () => S().projects.slice().sort((a, b) => a.order - b.order)
const byName = (n: string) => S().projects.find((p) => p.name === n)!
/** 剧栏的存储顺序,写成「名字[:分组]」。 */
const layout = () => sorted().map((p) => (p.group ? `${p.name}:${p.group}` : p.name))

/** 默认项目 + 甲 乙 丙 丁(顺序即 order)。 */
function seed(): void {
  for (const n of ['甲', '乙', '丙', '丁']) S().addProject(n, { activate: false })
}

const emptyImportPlan = (): ImportPlan => ({ boards: [] }) as unknown as ImportPlan

beforeEach(() => {
  localStorage.clear()
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('arrangeProjects', () => {
  it('一次改顺序 + 分组:order 压实、group 写到剧上,revision / structureRevision 各 +1,只入一步撤销', () => {
    seed()
    S().assignProjectGroup(byName('乙').id, '外传')
    S().assignProjectGroup(byName('丁').id, '外传') // 丁 被带到 乙 后面
    expect(layout()).toEqual(['默认项目', '甲', '乙:外传', '丁:外传', '丙'])
    const rev = S().revision
    const srev = S().structureRevision
    const depth = S().undoStack.length
    // 甲 放进「外传」:排到组内最后 —— 顺序和分组同时变
    const plan = planMoveProject(sorted(), [], byName('甲').id, { kind: 'group', name: '外传', zone: 'into' })!
    expect(plan.groups).toEqual({ [byName('甲').id]: '外传' })
    expect(S().arrangeProjects(plan)).toBe(true)
    expect(layout()).toEqual(['默认项目', '乙:外传', '丁:外传', '甲:外传', '丙'])
    expect(sorted().map((p) => p.order)).toEqual([0, 1, 2, 3, 4])
    expect(S().revision).toBe(rev + 1)
    expect(S().structureRevision).toBe(srev + 1)
    expect(S().undoStack).toHaveLength(depth + 1)
  })

  it('只落盘 order 或 group 真变了的剧', async () => {
    seed()
    const put = vi.spyOn(getWorkbenchDb(), 'putProject')
    const plan = planMoveProject(sorted(), [], byName('丁').id, { kind: 'group', name: '新组', zone: 'into' })!
    // 丁 原位成组:order 全不变,只有 group 变了的这一部要写
    expect(plan.ids).toEqual(sorted().map((p) => p.id))
    S().arrangeProjects(plan)
    await Promise.resolve()
    expect(put.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual(['丁'])
    const saved = (await getWorkbenchDb().listProjects()).find((p) => p.name === '丁')!
    expect(saved.group).toBe('新组')
  })

  it('移出分组 = 把 group 字段删掉(库里那条记录也没有这个键),不是写成 undefined', async () => {
    seed()
    S().assignProjectGroup(byName('丙').id, 'G')
    expect(S().assignProjectGroup(byName('丙').id, null)).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(byName('丙'), 'group')).toBe(false)
    await Promise.resolve()
    const saved = (await getWorkbenchDb().listProjects()).find((p) => p.name === '丙')!
    expect('group' in saved).toBe(false)
  })

  it('摆完没有任何变化:返回 true,但不涨版本、不入撤销栈、不落盘', () => {
    seed()
    const put = vi.spyOn(getWorkbenchDb(), 'putProject')
    const depth = S().undoStack.length
    const rev = S().revision
    const snapshot = S().projects
    expect(S().arrangeProjects({ ids: sorted().map((p) => p.id), groups: {} })).toBe(true)
    expect(S().revision).toBe(rev)
    expect(S().undoStack).toHaveLength(depth)
    expect(S().projects).toBe(snapshot)
    expect(put).not.toHaveBeenCalled()
  })

  it('非法计划整个拒绝、什么都不动:少给 / 多给 / 重复 / 未知 id / 没规整的分组名', () => {
    seed()
    const ids = sorted().map((p) => p.id)
    const rev = S().revision
    const snapshot = S().projects
    expect(S().arrangeProjects({ ids: ids.slice(1), groups: {} })).toBe(false)
    expect(S().arrangeProjects({ ids: [...ids, 'nope'], groups: {} })).toBe(false)
    expect(S().arrangeProjects({ ids: [ids[0], ...ids.slice(0, -1)], groups: {} })).toBe(false)
    expect(S().arrangeProjects({ ids, groups: { nope: 'G' } })).toBe(false)
    expect(S().arrangeProjects({ ids, groups: { [ids[1]]: '  G ' } })).toBe(false)
    expect(S().arrangeProjects({ ids, groups: { [ids[1]]: '' } })).toBe(false)
    expect(S().revision).toBe(rev)
    expect(S().projects).toBe(snapshot)
  })

  it('撤销 = 顺序和分组一起还原,重做 = 再来一次', async () => {
    seed()
    S().assignProjectGroup(byName('乙').id, 'G')
    const before = layout()
    S().assignProjectGroup(byName('丁').id, 'G')
    const after = layout()
    expect(after).not.toEqual(before)
    expect((await S().undo()).ok).toBe(true)
    expect(layout()).toEqual(before)
    expect((await S().redo()).ok).toBe(true)
    expect(layout()).toEqual(after)
  })
})

describe('assignProjectGroup / renameGroup / dissolveGroup', () => {
  it('assignProjectGroup:进已有分组排到组内最后;新名字原位成组;非法名字 / 未知剧 → false', () => {
    seed()
    S().assignProjectGroup(byName('乙').id, 'G')
    expect(S().assignProjectGroup(byName('丁').id, ' G ')).toBe(true) // 规整后同名
    expect(layout()).toEqual(['默认项目', '甲', '乙:G', '丁:G', '丙'])
    expect(S().assignProjectGroup(byName('甲').id, '   ')).toBe(false)
    expect(S().assignProjectGroup('nope', 'G')).toBe(false)
  })

  it('renameGroup:所有成员一起改;改成已有的名字 = 并入;折叠状态跟着名字走', () => {
    seed()
    S().assignProjectGroup(byName('甲').id, 'X')
    S().assignProjectGroup(byName('乙').id, 'X')
    S().assignProjectGroup(byName('丙').id, 'Y')
    S().toggleGroupCollapsed('X')
    expect(S().renameGroup('X', '主线')).toBe(true)
    expect(layout()).toEqual(['默认项目', '甲:主线', '乙:主线', '丙:Y', '丁'])
    expect(S().collapsedGroups).toEqual(['主线'])
    expect(readGroupNames(COLLAPSED_GROUPS_KEY)).toEqual(['主线'])
    expect(S().renameGroup('Y', '主线')).toBe(true) // 并入
    expect(layout()).toEqual(['默认项目', '甲:主线', '乙:主线', '丙:主线', '丁'])
    expect(S().renameGroup('不存在', 'Z')).toBe(false)
    expect(S().renameGroup('主线', '  ')).toBe(false)
  })

  it('dissolveGroup:成员回到未分组、位置不动,折叠记录清掉;一步撤销能还原', async () => {
    seed()
    S().assignProjectGroup(byName('乙').id, 'G')
    S().assignProjectGroup(byName('丙').id, 'G')
    S().toggleGroupCollapsed('G')
    const withGroup = layout()
    expect(S().dissolveGroup('G')).toBe(true)
    expect(layout()).toEqual(['默认项目', '甲', '乙', '丙', '丁'])
    expect(S().collapsedGroups).toEqual([])
    expect((await S().undo()).ok).toBe(true)
    expect(layout()).toEqual(withGroup)
    expect(S().dissolveGroup('不存在')).toBe(false)
  })
})

describe('本机暂存的空分组(emptyGroups)与折叠(collapsedGroups)', () => {
  it('createEmptyGroup:规整名字、拒绝空名与重名(含已有成员的分组),存 localStorage,不动 revision / 撤销栈 / 库', async () => {
    seed()
    S().assignProjectGroup(byName('甲').id, '已有')
    const put = vi.spyOn(getWorkbenchDb(), 'putProject')
    const rev = S().revision
    const depth = S().undoStack.length
    expect(S().createEmptyGroup('  新 组 ')).toEqual({ ok: true, name: '新 组' })
    expect(S().createEmptyGroup('新 组')).toMatchObject({ ok: false, reason: '已有同名分组' })
    expect(S().createEmptyGroup('已有')).toMatchObject({ ok: false, reason: '已有同名分组' })
    expect(S().createEmptyGroup('   ')).toMatchObject({ ok: false })
    expect(S().emptyGroups).toEqual(['新 组'])
    expect(readGroupNames(EMPTY_GROUPS_KEY)).toEqual(['新 组'])
    expect(S().revision).toBe(rev)
    expect(S().undoStack).toHaveLength(depth)
    await Promise.resolve()
    expect(put).not.toHaveBeenCalled()
  })

  it('第一部剧放进来之后,它不再是「暂存」:从 emptyGroups 移除,真正写进剧的 group', () => {
    seed()
    S().createEmptyGroup('新组')
    expect(S().assignProjectGroup(byName('丙').id, '新组')).toBe(true)
    expect(S().emptyGroups).toEqual([])
    expect(readGroupNames(EMPTY_GROUPS_KEY)).toEqual([])
    expect(byName('丙').group).toBe('新组')
  })

  it('空分组可以改名(并入已有名字时它自己消失)、可以删除', () => {
    seed()
    S().assignProjectGroup(byName('甲').id, '已有')
    S().createEmptyGroup('草稿')
    expect(S().renameGroup('草稿', '成稿')).toBe(true)
    expect(S().emptyGroups).toEqual(['成稿'])
    expect(S().renameGroup('成稿', '已有')).toBe(true)
    expect(S().emptyGroups).toEqual([])
    S().createEmptyGroup('临时')
    expect(S().dissolveGroup('临时')).toBe(true)
    expect(S().emptyGroups).toEqual([])
  })

  it('toggleGroupCollapsed:存 localStorage;不入撤销栈;读回时丢掉脏数据', () => {
    seed()
    const depth = S().undoStack.length
    S().toggleGroupCollapsed('G')
    expect(S().collapsedGroups).toEqual(['G'])
    expect(readGroupNames(COLLAPSED_GROUPS_KEY)).toEqual(['G'])
    S().toggleGroupCollapsed('G')
    expect(S().collapsedGroups).toEqual([])
    expect(S().undoStack).toHaveLength(depth)
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(['a', 5, '', 'a', '  b  ', null]))
    expect(readGroupNames(COLLAPSED_GROUPS_KEY)).toEqual(['a', 'b'])
    localStorage.setItem(COLLAPSED_GROUPS_KEY, '{坏的')
    expect(readGroupNames(COLLAPSED_GROUPS_KEY)).toEqual([])
  })
})

describe('分组与其它剧的操作', () => {
  it('置顶不影响存储:置顶的成员只是组内显示在最前,group / order 原样', () => {
    seed()
    S().assignProjectGroup(byName('乙').id, 'G')
    S().assignProjectGroup(byName('丙').id, 'G')
    const before = layout()
    S().setProjectPinned(byName('丙').id, true)
    expect(layout()).toEqual(before)
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!).projects).toEqual([byName('丙').id])
  })

  it('进回收站再恢复:分组名还在;Fork 的副本和原剧同组', () => {
    seed()
    S().assignProjectGroup(byName('乙').id, 'G')
    const id = byName('乙').id
    expect(S().trashProject(id)).toEqual({ ok: true })
    expect(S().restoreFromTrash(id)).toEqual({ ok: true })
    expect(byName('乙').group).toBe('G')
    const copy = S().duplicateProject(id)!
    expect(S().projects.find((p) => p.id === copy)!.group).toBe('G')
  })

  it('importProject:带分组名 → 并入本机同名分组(排在组内最后),并清掉同名的空分组暂存;不带 → 未分组', () => {
    seed()
    S().assignProjectGroup(byName('甲').id, '外传')
    S().createEmptyGroup('新篇')
    const a = S().importProject(emptyImportPlan(), '导入一', undefined, '  外传 ')
    expect(S().projects.find((p) => p.id === a)!.group).toBe('外传')
    expect(sorted()[sorted().length - 1].id).toBe(a)
    const b = S().importProject(emptyImportPlan(), '导入二', undefined, '新篇')
    expect(S().projects.find((p) => p.id === b)!.group).toBe('新篇')
    expect(S().emptyGroups).toEqual([])
    const c = S().importProject(emptyImportPlan(), '导入三')
    expect('group' in S().projects.find((p) => p.id === c)!).toBe(false)
    const d = S().importProject(emptyImportPlan(), '导入四', undefined, '   ')
    expect('group' in S().projects.find((p) => p.id === d)!).toBe(false)
  })
})
