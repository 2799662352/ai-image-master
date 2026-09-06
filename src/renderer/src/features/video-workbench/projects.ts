// 「剧」(project)slice —— zustand slices 模式,合并进 useVideoWorkbenchStore。
//
// 这里只管剧的集合、当前剧、每部剧记住的视图;分段/卡片本体仍在 store.ts。
// 通过 get() 读 boards / cards 做过滤,不复制数据。凡是改动 projects/boards/cards
// 集合或顺序的动作都 revision+1 与 structureRevision+1(store.ts 的既有纪律);
// 纯 UI 状态(视图模式、折叠)两个都不动。

import type { StateCreator } from 'zustand'
import {
  WORKBENCH_PROJECT_SUMMARY_MAX,
  type VideoWorkbenchBoard,
  type VideoWorkbenchProject,
} from '../../../../types/videoWorkbench'
import { createId, isActiveStatus } from './cardSpec'
import { cancelPendingPersist } from './persistQueue'
import type { VideoWorkbenchState } from './store'
import { getWorkbenchDb } from './WorkbenchDb'

export type WorkbenchViewMode = 'overview' | 'board'
export interface ProjectView {
  mode: WorkbenchViewMode
  boardId?: string
}

export interface ProjectsSlice {
  projects: VideoWorkbenchProject[]
  activeProjectId: string
  /** 每部剧上次停在总览还是哪个分段。纯 UI 状态,不进撤销栈。 */
  viewByProject: Record<string, ProjectView>
  railCollapsed: boolean
  /** 新建剧(自带「分段 1」),切过去并停在总览。返回剧 id。 */
  addProject: (name?: string) => string
  /** 改名;trim 后为空拒绝;同名无操作;改名即视为「用户认领了这部剧」,清 legacy。 */
  renameProject: (id: string, name: string) => boolean
  /** 整体重排,必须给出全集(同 reorderCards)。 */
  reorderProjects: (ids: string[]) => boolean
  switchProject: (id: string) => void
  openOverview: () => void
  /** 打开某个分段;不属于当前剧则连剧一起切。 */
  openBoard: (boardId: string) => void
  /** 把分段搬到另一部剧;源剧会空出、目标不存在、分段不存在 → false。 */
  moveBoardToProject: (boardId: string, projectId: string) => boolean
  /** 深拷贝一部剧(分段 + 卡片,新 id;排队/生成中的卡重置为草稿)。返回新剧 id。 */
  duplicateProject: (id: string) => string | null
  /** 唯一一部剧、或有生成中卡片 → 拒绝。 */
  removeProject: (id: string) => { ok: boolean; reason?: string }
  /** agent 写的一行剧摘要;空串清除。不动 revision / structureRevision(见 setBoardSummary)。 */
  setProjectSummary: (id: string, summary: string) => boolean
  dismissLegacyNotice: (id: string) => void
  setRailCollapsed: (collapsed: boolean) => void
}

/** 当前激活「剧」的 localStorage 键(轻量元数据,不进 IndexedDB)。 */
export const ACTIVE_PROJECT_KEY = 'vw-active-project'
export const RAIL_COLLAPSED_KEY = 'vw-rail-collapsed'

export function nextProjectName(projects: readonly VideoWorkbenchProject[]): string {
  const taken = new Set(projects.map((p) => p.name))
  let n = projects.length + 1
  while (taken.has(`未命名剧 ${n}`)) n += 1
  return `未命名剧 ${n}`
}

/** 同一部剧内的「分段 N」;传入的 boards 必须已按剧过滤。 */
export function nextSegmentName(boards: readonly VideoWorkbenchBoard[]): string {
  const taken = new Set(boards.map((b) => b.name))
  let n = boards.length + 1
  while (taken.has(`分段 ${n}`)) n += 1
  return `分段 ${n}`
}

export function writeActiveProject(id: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_PROJECT_KEY, id)
  } catch {
    // localStorage 不可用时仅内存生效
  }
}

export function readRailCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(RAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** 一部剧下的第一个分段(按 order);没有则 undefined。 */
export function firstBoardOf(
  boards: readonly VideoWorkbenchBoard[],
  projectId: string,
): VideoWorkbenchBoard | undefined {
  return boards.filter((b) => b.projectId === projectId).sort((a, b) => a.order - b.order)[0]
}

function compactOrders<T extends { order: number }>(items: T[]): T[] {
  return items.map((it, i) => (it.order === i ? it : { ...it, order: i }))
}

export const createProjectsSlice: StateCreator<VideoWorkbenchState, [], [], ProjectsSlice> = (set, get) => ({
  projects: [],
  activeProjectId: '',
  viewByProject: {},
  railCollapsed: readRailCollapsed(),

  addProject: (name) => {
    const now = Date.now()
    const { projects } = get()
    const project: VideoWorkbenchProject = {
      id: createId(),
      name: name?.trim() || nextProjectName(projects),
      order: projects.length,
      createdAt: now,
      updatedAt: now,
    }
    // 每部剧至少一段:新剧自带「分段 1」,activeBoardId 这个硬不变量才始终有落点。
    const board: VideoWorkbenchBoard = {
      id: createId(),
      projectId: project.id,
      name: '分段 1',
      order: 0,
      createdAt: now,
    }
    set((s) => ({
      projects: [...s.projects, project],
      boards: [...s.boards, board],
      activeProjectId: project.id,
      activeBoardId: board.id,
      viewByProject: { ...s.viewByProject, [project.id]: { mode: 'overview' } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    writeActiveProject(project.id)
    const db = getWorkbenchDb()
    void db.putProject(project).catch(() => {})
    void db.putBoard(board).catch(() => {})
    return project.id
  },

  renameProject: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return false
    const cur = get().projects.find((p) => p.id === id)
    if (!cur) return false
    // 名字没变就是无操作:不 bump revision,也不重写库(输入框失焦提交同名很常见)。
    if (cur.name === trimmed) return true
    const { legacy: _drop, ...rest } = cur
    const next: VideoWorkbenchProject = { ...rest, name: trimmed, updatedAt: Date.now() }
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? next : p)),
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    void getWorkbenchDb().putProject(next).catch(() => {})
    return true
  },

  reorderProjects: (ids) => {
    const cur = get().projects
    if (ids.length !== cur.length || new Set(ids).size !== ids.length) return false
    const byId = new Map(cur.map((p) => [p.id, p]))
    if (!ids.every((id) => byId.has(id))) return false
    if (ids.every((id, i) => cur[i]?.id === id)) return true
    const next = compactOrders(ids.map((id) => byId.get(id)!))
    set((s) => ({ projects: next, revision: s.revision + 1, structureRevision: s.structureRevision + 1 }))
    const db = getWorkbenchDb()
    for (const p of next) void db.putProject(p).catch(() => {})
    return true
  },

  switchProject: (id) => {
    const { projects, boards, viewByProject } = get()
    if (!projects.some((p) => p.id === id)) return
    const view = viewByProject[id]
    const remembered =
      view?.boardId && boards.some((b) => b.id === view.boardId && b.projectId === id)
        ? view.boardId
        : firstBoardOf(boards, id)?.id
    set({
      activeProjectId: id,
      ...(remembered ? { activeBoardId: remembered } : {}),
      viewByProject: { ...viewByProject, [id]: view ?? { mode: 'overview' } },
      // 选中是当前分段的语境,切剧必须清
      selectedCardIds: [],
      selectionAnchorId: undefined,
    })
    writeActiveProject(id)
  },

  openOverview: () => {
    const id = get().activeProjectId
    set((s) => ({
      viewByProject: { ...s.viewByProject, [id]: { mode: 'overview' } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
    }))
  },

  openBoard: (boardId) => {
    const board = get().boards.find((b) => b.id === boardId)
    if (!board) return
    set((s) => ({
      activeProjectId: board.projectId,
      activeBoardId: boardId,
      viewByProject: { ...s.viewByProject, [board.projectId]: { mode: 'board', boardId } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
    }))
    writeActiveProject(board.projectId)
  },

  moveBoardToProject: (boardId, projectId) => {
    const { boards, projects, activeBoardId } = get()
    const board = boards.find((b) => b.id === boardId)
    if (!board || board.projectId === projectId || !projects.some((p) => p.id === projectId)) return false
    const sourceRest = boards.filter((b) => b.projectId === board.projectId && b.id !== boardId)
    if (sourceRest.length === 0) return false // 源剧不能空出(每部剧至少一段)
    const targetCount = boards.filter((b) => b.projectId === projectId).length
    const moved: VideoWorkbenchBoard = { ...board, projectId, order: targetCount }
    const sourceCompacted = compactOrders([...sourceRest].sort((a, b) => a.order - b.order))
    const changed = new Map<string, VideoWorkbenchBoard>([
      [moved.id, moved],
      ...sourceCompacted.map((b) => [b.id, b] as const),
    ])
    set((s) => ({
      boards: s.boards.map((b) => changed.get(b.id) ?? b),
      ...(activeBoardId === boardId
        ? {
            activeBoardId: sourceCompacted[0].id,
            viewByProject: { ...s.viewByProject, [board.projectId]: { mode: 'overview' } },
          }
        : {}),
      selectedCardIds: [],
      selectionAnchorId: undefined,
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    const db = getWorkbenchDb()
    for (const b of changed.values()) void db.putBoard(b).catch(() => {})
    return true
  },

  duplicateProject: (id) => {
    const { projects, boards, cards } = get()
    const src = projects.find((p) => p.id === id)
    if (!src) return null
    const now = Date.now()
    const { legacy: _drop, ...srcRest } = src
    const project: VideoWorkbenchProject = {
      ...srcRest,
      id: createId(),
      name: `${src.name} 副本`,
      order: projects.length,
      createdAt: now,
      updatedAt: now,
    }
    const boardIdMap = new Map<string, string>()
    const newBoards = boards
      .filter((b) => b.projectId === id)
      .map((b) => {
        const nid = createId()
        boardIdMap.set(b.id, nid)
        return { ...b, id: nid, projectId: project.id, createdAt: now }
      })
    const newCards = cards
      .filter((c) => c.boardId && boardIdMap.has(c.boardId))
      .map((c) => {
        const { clientId: _client, ...rest } = c
        const base = { ...rest, id: createId(), boardId: boardIdMap.get(c.boardId!)!, createdAt: now, updatedAt: now }
        if (!isActiveStatus(c.status)) return base
        // 排队/生成中的任务不属于副本:重置为草稿,任务号与错误一并丢掉
        const { taskId: _task, error: _err, ...draft } = base
        return { ...draft, status: 'draft' as const }
      })
    set((s) => ({
      projects: [...s.projects, project],
      boards: [...s.boards, ...newBoards],
      cards: [...s.cards, ...newCards],
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    const db = getWorkbenchDb()
    void db.putProject(project).catch(() => {})
    for (const b of newBoards) void db.putBoard(b).catch(() => {})
    for (const c of newCards) void db.put(c).catch(() => {})
    return project.id
  },

  removeProject: (id) => {
    const { projects, boards, cards, activeProjectId } = get()
    if (!projects.some((p) => p.id === id)) return { ok: false, reason: '剧不存在' }
    if (projects.length <= 1) return { ok: false, reason: '至少保留一部剧' }
    const boardIds = new Set(boards.filter((b) => b.projectId === id).map((b) => b.id))
    const own = cards.filter((c) => c.boardId && boardIds.has(c.boardId))
    if (own.some((c) => isActiveStatus(c.status))) return { ok: false, reason: '这部剧有卡片正在生成,请先取消' }
    const nextProjects = compactOrders(projects.filter((p) => p.id !== id))
    const nextBoards = boards.filter((b) => !boardIds.has(b.id))
    const nextActive = activeProjectId === id ? nextProjects[0].id : activeProjectId
    const nextActiveBoard = activeProjectId === id ? firstBoardOf(nextBoards, nextActive)?.id : undefined
    set((s) => {
      const { [id]: _drop, ...restViews } = s.viewByProject
      return {
        projects: nextProjects,
        boards: nextBoards,
        cards: s.cards.filter((c) => !(c.boardId && boardIds.has(c.boardId))),
        activeProjectId: nextActive,
        ...(nextActiveBoard ? { activeBoardId: nextActiveBoard } : {}),
        viewByProject: restViews,
        selectedCardIds: [],
        selectionAnchorId: undefined,
        revision: s.revision + 1,
        structureRevision: s.structureRevision + 1,
      }
    })
    writeActiveProject(nextActive)
    const db = getWorkbenchDb()
    void db.removeProject(id).catch(() => {})
    for (const p of nextProjects) void db.putProject(p).catch(() => {})
    for (const bid of boardIds) void db.removeBoard(bid).catch(() => {})
    for (const c of own) {
      cancelPendingPersist(c.id)
      void db.remove(c.id).catch(() => {})
    }
    return { ok: true }
  },

  setProjectSummary: (id, summary) => {
    // 同 setBoardSummary:工具层 zod 硬拒超长,这里只是渲染端直调时的最后兜底。
    const trimmed = summary.trim().slice(0, WORKBENCH_PROJECT_SUMMARY_MAX)
    const cur = get().projects.find((p) => p.id === id)
    if (!cur) return false
    if ((cur.summary ?? '') === trimmed) return true
    // 空串 = 清除,不留空字段占位。摘要是路标不是编排意图:两个令牌都不动,撤销栈不记。
    const next: VideoWorkbenchProject = trimmed
      ? { ...cur, summary: trimmed }
      : (({ summary: _drop, ...rest }) => rest)(cur)
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? next : p)) }))
    void getWorkbenchDb().putProject(next).catch(() => {})
    return true
  },

  dismissLegacyNotice: (id) => {
    const cur = get().projects.find((p) => p.id === id)
    if (!cur?.legacy) return
    const { legacy: _drop, ...next } = cur
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? next : p)) }))
    void getWorkbenchDb().putProject(next).catch(() => {})
  },

  setRailCollapsed: (collapsed) => {
    set({ railCollapsed: collapsed })
    try {
      globalThis.localStorage?.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // 仅内存生效
    }
  },
})
