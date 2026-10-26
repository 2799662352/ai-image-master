// src/renderer/src/features/video-workbench/threadScope.ts
/**
 * 对话线程 → 视频工作台「我在哪部剧里干活」的绑定。
 *
 * 为什么需要:工作台只有一个全局「当前剧 / 当前页」指针(用户在界面上看的那个),而
 * `video_workbench_*` 的隐式作用域(add_tasks 不给页、start 不给 cardIds、status 默认当前页…)
 * 全部读它。两个对话同时给两部剧填卡,各自 `switch_project` 就在抢这一个指针 ——
 * 谁切谁赢,另一个对话的下一次调用就写进了别人的剧,界面也跟着来回跳。
 *
 * 做法:codex 的每次 MCP 调用都带 `_meta.threadId`(openai/codex #18093),所以渲染层
 * 知道「是哪个对话在调」。每个对话各自记住自己绑定的剧,隐式作用域从它的绑定里解析,
 * 不再读全局指针;屏幕上的当前剧只在「没有别的对话在别的剧里干活」时才跟随。
 *
 * 纯内存:对话关了/应用重启后绑定自然消失,下一次 `switch_project` 重新绑。
 * 没有 threadId(渲染端直调 / 非 codex 路径)= 老行为,完全不看这里。
 */

import type { VideoWorkbenchBoard } from '../../../../types/videoWorkbench'
import { firstBoardOf } from './projects'

/** 一个对话多久没碰工作台就不再算「正在干活」(只影响屏幕跟随与未绑定写入的拦截)。 */
export const THREAD_SCOPE_LIVE_MS = 10 * 60 * 1000

/** 超过这么久的绑定直接丢掉,免得 Map 随对话数无限长。 */
const THREAD_SCOPE_PRUNE_MS = THREAD_SCOPE_LIVE_MS * 6

interface Binding {
  projectId: string
  /**
   * 对话钉在这部剧里的哪一段(一集 / 一幕)。可选:没钉 = 隐式作用域落在「该剧当前页」。
   *
   * 为什么要到分段这一层:同一部剧的几集常常由几个对话同时填,只绑到剧的话,它们不带
   * boardId 的写入全都落进同一个「当前页」(对在屏幕上的剧而言,那就是用户翻到哪页算哪页)。
   */
  boardId?: string
  touchedAt: number
}

const bindings = new Map<string, Binding>()

/** 解析作用域只需要 store 的这几个字段,测试可直接喂普通对象。 */
export interface ScopeState {
  projects: ReadonlyArray<{ id: string; name?: string }>
  boards: ReadonlyArray<VideoWorkbenchBoard>
  activeProjectId: string
  activeBoardId: string
  viewByProject: Record<string, { boardId?: string } | undefined>
}

export interface ResolvedScope {
  /** 这次调用作用的剧。 */
  projectId: string
  /** 这部剧里隐式作用的那一页(省略 boardId 时用它)。 */
  boardId: string
  /** 该剧就是用户屏幕上正在看的那部。 */
  onScreen: boolean
  /** 来自这个对话自己的绑定;false = 没绑过,回落到屏幕上的当前剧。 */
  bound: boolean
  /** `boardId` 来自这个对话自己钉的分段;false = 隐式落在该剧「当前页」。 */
  boardBound: boolean
}

function prune(now: number): void {
  for (const [id, b] of bindings) {
    if (now - b.touchedAt > THREAD_SCOPE_PRUNE_MS) bindings.delete(id)
  }
}

/** 把对话绑到一部剧(重复绑同一部只刷新时间)。无 threadId 时什么都不做。 */
export function bindThreadProject(
  threadId: string | undefined,
  projectId: string,
  now: number = Date.now(),
): void {
  if (!threadId) return
  prune(now)
  const prev = bindings.get(threadId)
  // 还在同一部剧:保留已钉的分段(重复 switch 不该把它冲掉);换剧:分段属于旧剧,作废。
  bindings.set(threadId, {
    projectId,
    ...(prev && prev.projectId === projectId && prev.boardId ? { boardId: prev.boardId } : {}),
    touchedAt: now,
  })
}

/** 把对话钉到(已绑定那部剧的)某一段。没绑过剧时什么都不做。 */
export function bindThreadBoard(
  threadId: string | undefined,
  boardId: string,
  now: number = Date.now(),
): void {
  if (!threadId) return
  const b = bindings.get(threadId)
  if (!b) return
  b.boardId = boardId
  b.touchedAt = now
}

/** 对话又碰了一次工作台:刷新「正在干活」时间。没绑过的不记。 */
export function touchThread(threadId: string | undefined, now: number = Date.now()): void {
  if (!threadId) return
  const b = bindings.get(threadId)
  if (b) b.touchedAt = now
}

export function forgetThreadBinding(threadId: string): void {
  bindings.delete(threadId)
}

export function resetThreadScopesForTest(): void {
  bindings.clear()
}

export interface OtherBinding {
  threadId: string
  projectId: string
  boardId?: string
}

/** 别的、最近还在碰工作台的对话各自绑在哪部剧。 */
export function otherLiveBindings(
  threadId: string | undefined,
  now: number = Date.now(),
): OtherBinding[] {
  const out: OtherBinding[] = []
  for (const [id, b] of bindings) {
    if (id === threadId) continue
    if (now - b.touchedAt > THREAD_SCOPE_LIVE_MS) continue
    out.push({ threadId: id, projectId: b.projectId, ...(b.boardId ? { boardId: b.boardId } : {}) })
  }
  return out
}

/** 别的、最近还在碰工作台的对话里,有没有谁把自己钉在这一段上。 */
export function boardHeldByOther(
  threadId: string | undefined,
  projectId: string,
  boardId: string,
  now: number = Date.now(),
): boolean {
  return otherLiveBindings(threadId, now).some((o) => o.projectId === projectId && o.boardId === boardId)
}

/**
 * 把 store 状态「看」成另一部剧是当前剧的样子(不改 store)。
 *
 * 当前页取该剧上次停的那页,没记录就第一页 —— 与 `switchProject` 的落点一致;
 * 选中态是屏幕上那部剧的语境,换剧看就清掉。剧就是屏幕上的当前剧时原样返回。
 */
export function scopedView<T extends ScopeState>(state: T, projectId: string, pinnedBoardId?: string): T {
  // 钉住的分段必须真在这部剧里,否则当没钉(分段被删 / 传错 id 不该把视图带到别处)。
  const pinned =
    pinnedBoardId && state.boards.some((b) => b.id === pinnedBoardId && b.projectId === projectId)
      ? pinnedBoardId
      : undefined
  if (projectId === state.activeProjectId && (!pinned || pinned === state.activeBoardId)) return state
  const remembered = state.viewByProject[projectId]?.boardId
  const boardId =
    pinned
    ?? (projectId === state.activeProjectId
      ? state.activeBoardId
      : remembered && state.boards.some((b) => b.id === remembered && b.projectId === projectId)
        ? remembered
        : (firstBoardOf(state.boards, projectId)?.id ?? state.activeBoardId))
  const selection = 'selectedCardIds' in state ? { selectedCardIds: [] as string[] } : {}
  return { ...state, activeProjectId: projectId, activeBoardId: boardId, ...selection }
}

/** 这个对话这次调用该在哪部剧、哪一页里干活。 */
export function resolveThreadScope(
  state: ScopeState,
  threadId: string | undefined,
): ResolvedScope {
  const binding = threadId ? bindings.get(threadId) : undefined
  const bound = !!binding && state.projects.some((p) => p.id === binding.projectId)
  const projectId = bound ? binding!.projectId : state.activeProjectId
  const boundBoard =
    bound && binding!.boardId && state.boards.some((b) => b.id === binding!.boardId && b.projectId === projectId)
      ? binding!.boardId
      : undefined
  return {
    projectId,
    boardId: scopedView(state, projectId, boundBoard).activeBoardId,
    onScreen: projectId === state.activeProjectId,
    bound,
    boardBound: !!boundBoard,
  }
}

/**
 * 没绑过剧的对话要做「隐式作用域」的写操作时的把关。
 *
 * 只在**别的对话正在别的剧里干活**时拦:这时全局指针属于别人,这个对话的隐式写入
 * 九成会落进人家的剧。单对话(没有竞争者)时放行 —— 与以前一模一样。
 * 返回 null = 放行;否则是给模型的一句话,照着先选剧。
 */
export function unboundWriteBlock(
  threadId: string | undefined,
  scope: ResolvedScope,
  state: Pick<ScopeState, 'projects'> & Partial<Pick<ScopeState, 'boards'>>,
  now: number = Date.now(),
): string | null {
  if (!threadId) return null
  // 分段这一层:没钉分段、而隐式落点正好是别的对话钉着的那一段 → 九成会写进人家的集里。
  // 已经钉了分段的对话(自己的选择)和点名了 boardId / cardIds 的写入不会走到这里。
  if (
    scope.bound
    && !scope.boardBound
    && boardHeldByOther(threadId, scope.projectId, scope.boardId, now)
  ) {
    const board = state.boards?.find((b) => b.id === scope.boardId)
    return (
      `这个对话还没钉定要写哪个分段,而隐式落点「${board?.name ?? scope.boardId}」(${scope.boardId})`
      + '已经被另一个对话占着,写进去会和人家的卡混在一起。请先 '
      + `video_workbench_switch_project({ projectId: "${scope.projectId}", boardId: "<你要写的分段>" }) 钉定,`
      + '(workbench.boards 里标了 inUseByOtherChat 的是别人占着的),或者这次写入里显式传 boardId / cardIds。'
    )
  }
  if (scope.bound) return null
  const others = otherLiveBindings(threadId, now)
  if (others.length === 0) return null
  const names = new Map(state.projects.map((p) => [p.id, p.name ?? p.id]))
  const busy = [...new Set(others.map((o) => o.projectId))]
    .map((id) => `${names.get(id) ?? id}(${id})`)
    .join('、')
  return (
    '这个对话还没选定要在哪部剧里干活,而另一个对话正在别的剧里填卡'
    + `(${busy})。隐式写入会落进人家的剧。请先 video_workbench_list_projects 看清有哪些剧,`
    + '再 video_workbench_switch_project(已有的剧)或 video_workbench_create_project(新剧)选定,然后再写。'
  )
}
