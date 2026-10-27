// 对话 → 剧 绑定的纯逻辑单测:作用域解析、屏幕跟随所需的「别的对话」判定、
// 未绑定写入的把关、以及「把 store 看成另一部剧是当前剧」的视图。全部喂普通对象。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VideoWorkbenchBoard } from '../../../../../types/videoWorkbench'
import {
  THREAD_SCOPE_LIVE_MS,
  bindThreadBoard,
  bindThreadProject,
  boardHeldByOther,
  forgetThreadBinding,
  otherLiveBindings,
  resetThreadScopesForTest,
  resolveThreadScope,
  scopedView,
  touchThread,
  unboundWriteBlock,
  type ScopeState,
} from '../threadScope'

const board = (id: string, projectId: string, order: number): VideoWorkbenchBoard => ({
  id,
  projectId,
  name: id,
  order,
  createdAt: 1,
})

function state(patch: Partial<ScopeState> = {}): ScopeState {
  return {
    projects: [
      { id: 'p1', name: '第一部' },
      { id: 'p2', name: '第二部' },
    ],
    boards: [board('p1-b1', 'p1', 0), board('p2-b1', 'p2', 0), board('p2-b2', 'p2', 1)],
    activeProjectId: 'p1',
    activeBoardId: 'p1-b1',
    viewByProject: {},
    ...patch,
  }
}

beforeEach(() => resetThreadScopesForTest())
afterEach(() => resetThreadScopesForTest())

describe('resolveThreadScope', () => {
  it('没绑过或没有 threadId:回落到屏幕上的当前剧与当前页(老行为)', () => {
    expect(resolveThreadScope(state(), undefined)).toEqual({
      projectId: 'p1',
      boardId: 'p1-b1',
      onScreen: true,
      bound: false,
      boardBound: false,
    })
    expect(resolveThreadScope(state(), 'thread-x').bound).toBe(false)
  })

  it('绑定后读自己的剧,不随屏幕指针走;页取该剧上次停的那页,没有就第一页', () => {
    bindThreadProject('t', 'p2')
    expect(resolveThreadScope(state(), 't')).toEqual({
      projectId: 'p2',
      boardId: 'p2-b1',
      onScreen: false,
      bound: true,
      boardBound: false,
    })
    const remembered = state({ viewByProject: { p2: { boardId: 'p2-b2' } } })
    expect(resolveThreadScope(remembered, 't').boardId).toBe('p2-b2')
    // 记着的页已不属于该剧(被删/被挪)→ 退回第一页
    const stale = state({ viewByProject: { p2: { boardId: 'p1-b1' } } })
    expect(resolveThreadScope(stale, 't').boardId).toBe('p2-b1')
  })

  it('绑的剧就是屏幕上的剧:onScreen,且页跟屏幕当前页(用户翻页 agent 跟着)', () => {
    bindThreadProject('t', 'p2')
    const s = state({ activeProjectId: 'p2', activeBoardId: 'p2-b2' })
    expect(resolveThreadScope(s, 't')).toMatchObject({ projectId: 'p2', boardId: 'p2-b2', onScreen: true, bound: true })
  })

  it('绑的剧已被删:当作没绑,回落到屏幕上的剧', () => {
    bindThreadProject('t', 'gone')
    expect(resolveThreadScope(state(), 't')).toMatchObject({ projectId: 'p1', bound: false })
  })
})

describe('scopedView', () => {
  it('剧就是当前剧时原样返回同一个对象', () => {
    const s = state()
    expect(scopedView(s, 'p1')).toBe(s)
  })

  it('换成另一部剧的视角:当前剧/页改了,选中清空,原对象不被改', () => {
    const s = { ...state(), selectedCardIds: ['c1'] }
    const v = scopedView(s, 'p2')
    expect(v).toMatchObject({ activeProjectId: 'p2', activeBoardId: 'p2-b1', selectedCardIds: [] })
    expect(s.activeProjectId).toBe('p1')
    expect(s.selectedCardIds).toEqual(['c1'])
  })
})

describe('otherLiveBindings', () => {
  it('不含自己;停手超过窗口的不算', () => {
    bindThreadProject('a', 'p1', 1_000)
    bindThreadProject('b', 'p2', 1_000)
    expect(otherLiveBindings('a', 1_000).map((o) => o.threadId)).toEqual(['b'])
    expect(otherLiveBindings('a', 1_000 + THREAD_SCOPE_LIVE_MS + 1)).toEqual([])
    // 再碰一次工作台就重新算在干活
    touchThread('b', 1_000 + THREAD_SCOPE_LIVE_MS)
    expect(otherLiveBindings('a', 1_000 + THREAD_SCOPE_LIVE_MS + 1).map((o) => o.threadId)).toEqual(['b'])
  })

  it('没绑过的对话 touch 不会凭空登记', () => {
    touchThread('ghost')
    expect(otherLiveBindings('a')).toEqual([])
  })
})

describe('unboundWriteBlock', () => {
  const s = state()

  it('没有别的对话在干活:放行(单对话行为不变)', () => {
    const scope = resolveThreadScope(s, 't')
    expect(unboundWriteBlock('t', scope, s)).toBeNull()
  })

  it('别的对话占着剧而自己没选:拦,并点出剧名与下一步', () => {
    bindThreadProject('other', 'p2')
    const scope = resolveThreadScope(s, 't')
    const msg = unboundWriteBlock('t', scope, s)
    expect(msg).toContain('第二部')
    expect(msg).toContain('video_workbench_switch_project')
  })

  it('自己绑过了 / 没有 threadId:不拦', () => {
    bindThreadProject('other', 'p2')
    bindThreadProject('t', 'p1')
    expect(unboundWriteBlock('t', resolveThreadScope(s, 't'), s)).toBeNull()
    expect(unboundWriteBlock(undefined, resolveThreadScope(s, undefined), s)).toBeNull()
  })
})

describe('分段绑定(同一部剧里各管一集)', () => {
  it('钉了分段:隐式落点就是那一段,不随屏幕指针和「该剧上次停的页」走', () => {
    bindThreadProject('t', 'p2')
    bindThreadBoard('t', 'p2-b2')
    const scope = resolveThreadScope(state({ viewByProject: { p2: { boardId: 'p2-b1' } } }), 't')
    expect(scope).toMatchObject({ projectId: 'p2', boardId: 'p2-b2', bound: true, boardBound: true })
  })

  it('剧就是屏幕上的剧、屏幕在别的段:仍落在钉的那段(用户翻页不影响 agent)', () => {
    bindThreadProject('t', 'p2')
    bindThreadBoard('t', 'p2-b2')
    const s = state({ activeProjectId: 'p2', activeBoardId: 'p2-b1' })
    expect(resolveThreadScope(s, 't')).toMatchObject({ onScreen: true, boardId: 'p2-b2', boardBound: true })
  })

  it('钉的分段已被删 / 不属于这部剧:当作没钉,回落到该剧当前页', () => {
    bindThreadProject('t', 'p2')
    bindThreadBoard('t', 'p1-b1') // 别的剧的段
    expect(resolveThreadScope(state(), 't')).toMatchObject({ boardId: 'p2-b1', boardBound: false })
    bindThreadBoard('t', 'ghost')
    expect(resolveThreadScope(state(), 't')).toMatchObject({ boardId: 'p2-b1', boardBound: false })
  })

  it('重复 switch 到同一部剧不冲掉已钉的分段;换剧则作废', () => {
    bindThreadProject('t', 'p2')
    bindThreadBoard('t', 'p2-b2')
    bindThreadProject('t', 'p2')
    expect(resolveThreadScope(state(), 't').boardId).toBe('p2-b2')
    bindThreadProject('t', 'p1')
    bindThreadProject('t', 'p2')
    expect(resolveThreadScope(state(), 't')).toMatchObject({ boardId: 'p2-b1', boardBound: false })
  })

  it('没绑过剧时钉分段什么都不做', () => {
    bindThreadBoard('t', 'p2-b2')
    expect(resolveThreadScope(state(), 't')).toMatchObject({ bound: false, boardBound: false })
  })

  it('scopedView 的 pinned:屏幕上的剧也能换到钉的那段来看,选中清空;pinned 不在这部剧里就忽略', () => {
    const s = { ...state({ activeProjectId: 'p2', activeBoardId: 'p2-b1' }), selectedCardIds: ['c1'] }
    const v = scopedView(s, 'p2', 'p2-b2')
    expect(v).toMatchObject({ activeProjectId: 'p2', activeBoardId: 'p2-b2', selectedCardIds: [] })
    expect(s.activeBoardId).toBe('p2-b1')
    // pinned 就是屏幕当前段 → 原样返回
    expect(scopedView(s, 'p2', 'p2-b1')).toBe(s)
    // 别的剧的段 → 当没钉
    expect(scopedView(s, 'p2', 'p1-b1')).toBe(s)
  })

  it('boardHeldByOther:只看别的、还在干活的对话钉着这一段', () => {
    bindThreadProject('a', 'p2', 1_000)
    bindThreadBoard('a', 'p2-b1', 1_000)
    bindThreadProject('b', 'p2', 1_000)
    expect(boardHeldByOther('b', 'p2', 'p2-b1', 1_000)).toBe(true)
    expect(boardHeldByOther('b', 'p2', 'p2-b2', 1_000)).toBe(false)
    // 自己钉的不算「别人」
    expect(boardHeldByOther('a', 'p2', 'p2-b1', 1_000)).toBe(false)
    // 停手超过窗口 → 不再算占着
    expect(boardHeldByOther('b', 'p2', 'p2-b1', 1_000 + THREAD_SCOPE_LIVE_MS + 1)).toBe(false)
  })

  it('unboundWriteBlock:同剧里隐式落点正是别人钉着的段 → 拦并指路 boardId;自己钉了或落点没人占 → 放行', () => {
    const s = state()
    bindThreadProject('other', 'p2')
    bindThreadBoard('other', 'p2-b1')
    bindThreadProject('t', 'p2') // 只绑了剧,隐式落点 = p2-b1,正被 other 占着
    const msg = unboundWriteBlock('t', resolveThreadScope(s, 't'), s)
    expect(msg).toContain('p2-b1')
    expect(msg).toContain('boardId')
    expect(msg).toContain('video_workbench_switch_project')

    bindThreadBoard('t', 'p2-b2') // 钉了自己的段
    expect(unboundWriteBlock('t', resolveThreadScope(s, 't'), s)).toBeNull()

    // 落点没人占:放行(先让 t 退出,否则 p2-b2 正被它自己钉着)
    forgetThreadBinding('t')
    const s2 = state({ viewByProject: { p2: { boardId: 'p2-b2' } } })
    bindThreadProject('t2', 'p2')
    expect(unboundWriteBlock('t2', resolveThreadScope(s2, 't2'), s2)).toBeNull()
  })
})
