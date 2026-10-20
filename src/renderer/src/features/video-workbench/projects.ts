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
  type VideoWorkbenchCard,
  type VideoWorkbenchProject,
  type VideoWorkbenchVersion,
} from '../../../../types/videoWorkbench'
import { buildCard, createId, isActiveStatus } from './cardSpec'
import { cancelPendingPersist } from './persistQueue'
import type { ImportPlan } from './projectFile'
import type { VideoWorkbenchState } from './store'
import { markBoard, markProject, type WorkbenchTrashEntry } from './trash'
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
  /** 唯一一部剧、或有生成中卡片 → 拒绝。**物理删除**,不进回收站(用户入口走 trashProject)。 */
  removeProject: (id: string) => { ok: boolean; reason?: string }
  /**
   * 回收站:内存里只放被删的剧 / 分段(连同它们的分段和卡片),活数据里看不到它们。
   * 新的在前。纯派生自库里的删除标记,重启后由水合重建(见 trash.ts)。
   */
  trash: WorkbenchTrashEntry[]
  /**
   * 用户删剧:**移入回收站**而不是抹掉。拒绝条件同 removeProject(唯一一部剧 / 有生成中卡片)。
   * 进撤销栈(revision+1),所以 Ctrl+Z 能直接救回来。
   */
  trashProject: (id: string) => { ok: boolean; reason?: string }
  /** 用户删分段:移入回收站。本剧仅剩一段 / 有生成中卡片 → 拒绝。 */
  trashBoard: (id: string) => { ok: boolean; reason?: string }
  /**
   * 从回收站恢复。剧:带回它当时的全部分段和卡片,排到剧栏末尾;分段:放回原来的剧末尾
   * (那部剧还在回收站里就拒绝并说明要先恢复哪部)。不切换当前视图。
   */
  restoreFromTrash: (id: string) => { ok: boolean; reason?: string }
  /** 彻底删除一条(不可恢复)。删剧会连它名下单独进过回收站的分段一并清掉。 */
  purgeFromTrash: (id: string) => boolean
  /** 清空回收站,返回清掉的条数。 */
  emptyTrash: () => number
  /** Fork 一个分段:紧跟在原段后面,卡片深拷贝(生成中的重置为草稿)。返回新段 id。不切换视图。 */
  duplicateBoard: (id: string) => string | null
  /** 置顶的剧 / 分段 id。纯界面偏好:存 localStorage,不进库、不进撤销栈、不动版本号。 */
  pinnedProjectIds: string[]
  pinnedBoardIds: string[]
  setProjectPinned: (id: string, pinned: boolean) => void
  setBoardPinned: (id: string, pinned: boolean) => void
  /**
   * 工程文件 → 一部**新**剧(全新 id;已完成/失败保留状态与云端地址,其余草稿),
   * 切过去停在总览。返回新剧 id。零分段的文件补一段「分段 1」。
   */
  importProject: (plan: ImportPlan, name: string, summary?: string) => string
  /** agent 写的一行剧摘要;空串清除。不动 revision / structureRevision(见 setBoardSummary)。 */
  setProjectSummary: (id: string, summary: string) => boolean
  dismissLegacyNotice: (id: string) => void
  setRailCollapsed: (collapsed: boolean) => void
}

/** 当前激活「剧」的 localStorage 键(轻量元数据,不进 IndexedDB)。 */
export const ACTIVE_PROJECT_KEY = 'vw-active-project'
export const RAIL_COLLAPSED_KEY = 'vw-rail-collapsed'
/** 当前激活「页」的 localStorage 键(轻量元数据,不进 IndexedDB)。store.ts 转出。 */
export const ACTIVE_BOARD_KEY = 'vw-active-board'

export function writeActiveBoard(id: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_BOARD_KEY, id)
  } catch {
    // localStorage 不可用时仅内存生效
  }
}

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

/** 置顶偏好(剧 + 分段 id)的 localStorage 键。 */
export const PINS_KEY = 'vw-pins'

interface StoredPins {
  projects: string[]
  boards: string[]
}

export function readPins(): StoredPins {
  try {
    const raw = globalThis.localStorage?.getItem(PINS_KEY)
    if (!raw) return { projects: [], boards: [] }
    const parsed = JSON.parse(raw) as Partial<StoredPins>
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return { projects: strings(parsed.projects), boards: strings(parsed.boards) }
  } catch {
    return { projects: [], boards: [] }
  }
}

function writePins(pins: StoredPins): void {
  try {
    globalThis.localStorage?.setItem(PINS_KEY, JSON.stringify(pins))
  } catch {
    // 仅内存生效
  }
}

/** 置顶的排前面,其余保持原相对顺序(稳定)。id 取法由调用方给(分段统计行的 id 在 board.id 上)。 */
export function pinnedFirstBy<T>(
  items: readonly T[],
  pinnedIds: readonly string[],
  idOf: (item: T) => string,
): T[] {
  if (pinnedIds.length === 0) return [...items]
  const pinned = new Set(pinnedIds)
  return [...items.filter((it) => pinned.has(idOf(it))), ...items.filter((it) => !pinned.has(idOf(it)))]
}

export function pinnedFirst<T extends { id: string }>(items: readonly T[], pinnedIds: readonly string[]): T[] {
  return pinnedFirstBy(items, pinnedIds, (it) => it.id)
}

/** 「X 副本」,已被占用则「X 副本 2」「X 副本 3」…… */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = `${name} 副本`
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

/** 深拷贝一张卡到新分段:去掉 clientId;排队/生成中的任务不属于副本,重置为草稿。 */
function cloneCardTo(c: VideoWorkbenchCard, boardId: string, now: number): VideoWorkbenchCard {
  const { clientId: _client, ...rest } = c
  const base = { ...rest, id: createId(), boardId, createdAt: now, updatedAt: now }
  if (!isActiveStatus(c.status)) return base
  const { taskId: _task, error: _err, ...draft } = base
  return { ...draft, status: 'draft' as const }
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

/**
 * 工程文件里的一张卡 → store 卡片。规格经 buildCard/normalizeSpec 补默认;结果只认
 * 已完成(带云端地址)/失败,其余一律草稿 —— 文件里本来就没有任务号可接。
 */
function importedCard(plan: ImportPlan['boards'][number]['cards'][number], order: number, boardId: string): VideoWorkbenchCard {
  const card = buildCard(plan.input, order, boardId)
  const withSummary: VideoWorkbenchCard = plan.summary ? { ...card, summary: plan.summary } : card
  const r = plan.result
  if (!r) return withSummary
  if (r.status === 'failed') {
    return { ...withSummary, status: 'failed', ...(r.error ? { error: r.error } : {}) }
  }
  if (r.status !== 'succeeded' || !r.remoteUrl) return withSummary
  const versions: VideoWorkbenchVersion[] = (r.versions ?? []).map((v) => ({
    id: createId(),
    seq: v.seq,
    createdAt: card.createdAt,
    ...(v.remoteUrl ? { remoteUrl: v.remoteUrl } : {}),
    spec: {
      prompt: v.prompt,
      model: card.model,
      resolution: card.resolution,
      ratio: card.ratio,
      duration: card.duration,
      generateAudio: card.generateAudio,
      mode: card.mode,
      ...(card.seed !== undefined ? { seed: card.seed } : {}),
      webSearch: card.webSearch,
      referenceBrief: {
        images: card.referenceImages.map((m) => m.name),
        videos: card.referenceVideos.map((m) => m.name),
        audios: card.referenceAudios.map((m) => m.name),
      },
    },
  }))
  return {
    ...withSummary,
    status: 'succeeded',
    remoteUrl: r.remoteUrl,
    persistence: 'done',
    ...(versions.length > 0 ? { versions } : {}),
  }
}

export const createProjectsSlice: StateCreator<VideoWorkbenchState, [], [], ProjectsSlice> = (set, get) => ({
  projects: [],
  activeProjectId: '',
  viewByProject: {},
  railCollapsed: readRailCollapsed(),
  trash: [],
  pinnedProjectIds: readPins().projects,
  pinnedBoardIds: readPins().boards,

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
      .map((c) => cloneCardTo(c, boardIdMap.get(c.boardId!)!, now))
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

  importProject: (plan, name, summary) => {
    const now = Date.now()
    const { projects } = get()
    const trimmedSummary = summary?.trim().slice(0, WORKBENCH_PROJECT_SUMMARY_MAX)
    const project: VideoWorkbenchProject = {
      id: createId(),
      name: name.trim() || '导入的剧',
      order: projects.length,
      createdAt: now,
      updatedAt: now,
      ...(trimmedSummary ? { summary: trimmedSummary } : {}),
    }
    const newBoards: VideoWorkbenchBoard[] = []
    const newCards: VideoWorkbenchCard[] = []
    plan.boards.forEach((b, order) => {
      const board: VideoWorkbenchBoard = {
        id: createId(),
        projectId: project.id,
        name: b.name.trim() || `分段 ${order + 1}`,
        ...(b.summary ? { summary: b.summary } : {}),
        order,
        createdAt: now,
      }
      newBoards.push(board)
      b.cards.forEach((c, cardOrder) => {
        newCards.push(importedCard(c, cardOrder, board.id))
      })
    })
    // 每部剧至少一段:文件里没分段也得有个落点,activeBoardId 是硬不变量。
    if (newBoards.length === 0) {
      newBoards.push({ id: createId(), projectId: project.id, name: '分段 1', order: 0, createdAt: now })
    }
    set((s) => ({
      projects: [...s.projects, project],
      boards: [...s.boards, ...newBoards],
      cards: [...s.cards, ...newCards],
      activeProjectId: project.id,
      activeBoardId: newBoards[0].id,
      viewByProject: { ...s.viewByProject, [project.id]: { mode: 'overview' } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    writeActiveProject(project.id)
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

  trashProject: (id) => {
    const { projects, boards, cards, activeProjectId } = get()
    const project = projects.find((p) => p.id === id)
    if (!project) return { ok: false, reason: '剧不存在' }
    if (projects.length <= 1) return { ok: false, reason: '至少保留一部剧' }
    const own = boards.filter((b) => b.projectId === id).sort((a, b) => a.order - b.order)
    const boardIds = new Set(own.map((b) => b.id))
    const ownCards = cards.filter((c) => c.boardId && boardIds.has(c.boardId))
    if (ownCards.some((c) => isActiveStatus(c.status))) {
      return { ok: false, reason: '这部剧有卡片正在生成,请先取消' }
    }
    const now = Date.now()
    const entry: WorkbenchTrashEntry = { id, kind: 'project', deletedAt: now, project, boards: own, cards: ownCards }
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
        trash: [entry, ...s.trash.filter((e) => e.id !== id)],
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
    // 库里只给原记录打删除标记:剧、它的分段;卡片记录不动(靠 boardId 指回被标记的分段)。
    void db.putProject(markProject(project, now)).catch(() => {})
    for (const p of nextProjects) void db.putProject(p).catch(() => {})
    for (const b of own) void db.putBoard(markBoard(b, now, true)).catch(() => {})
    // 掐掉待落盘的防抖写再立刻写一次最新内容:否则回收站里躺的是 500ms 前的旧卡。
    for (const c of ownCards) {
      cancelPendingPersist(c.id)
      void db.put(c).catch(() => {})
    }
    return { ok: true }
  },

  trashBoard: (id) => {
    const state = get()
    const target = state.boards.find((b) => b.id === id)
    if (!target) return { ok: false, reason: '分段不存在' }
    const own = state.boards.filter((b) => b.projectId === target.projectId)
    if (own.length <= 1) return { ok: false, reason: '每部剧至少保留一个分段' }
    const removedCards = state.cards.filter((c) => c.boardId === id)
    if (removedCards.some((c) => isActiveStatus(c.status))) {
      return { ok: false, reason: '这个分段有卡片正在生成,请先取消' }
    }
    const now = Date.now()
    const entry: WorkbenchTrashEntry = {
      id,
      kind: 'board',
      deletedAt: now,
      boards: [target],
      cards: removedCards,
      projectId: target.projectId,
    }
    const ownRest = own.filter((b) => b.id !== id).sort((a, b) => a.order - b.order)
    const compacted = new Map(ownRest.map((b, i) => [b.id, b.order === i ? b : { ...b, order: i }]))
    const boards = state.boards.filter((b) => b.id !== id).map((b) => compacted.get(b.id) ?? b)
    const removedActive = state.activeBoardId === id
    const activeBoardId = removedActive ? ownRest[0].id : state.activeBoardId
    set({
      boards,
      activeBoardId,
      // 删的是当前段 → 回这部剧的总览,别把用户扔进一个他没选的段
      ...(removedActive
        ? { viewByProject: { ...state.viewByProject, [target.projectId]: { mode: 'overview' } } }
        : {}),
      cards: state.cards.filter((c) => c.boardId !== id),
      trash: [entry, ...state.trash.filter((e) => e.id !== id)],
      selectedCardIds: [],
      selectionAnchorId: undefined,
      revision: state.revision + 1,
      structureRevision: state.structureRevision + 1,
    })
    writeActiveBoard(activeBoardId)
    const db = getWorkbenchDb()
    void db.putBoard(markBoard(target, now, false)).catch(() => {})
    for (const b of compacted.values()) void db.putBoard(b).catch(() => {})
    for (const c of removedCards) {
      cancelPendingPersist(c.id)
      void db.put(c).catch(() => {})
    }
    return { ok: true }
  },

  restoreFromTrash: (id) => {
    const { trash, projects, boards } = get()
    const entry = trash.find((e) => e.id === id)
    if (!entry) return { ok: false, reason: '回收站里没有这一项' }
    const db = getWorkbenchDb()
    if (entry.kind === 'project' && entry.project) {
      if (projects.some((p) => p.id === id)) return { ok: false, reason: '同一部剧已经在剧栏里了' }
      const project: VideoWorkbenchProject = { ...entry.project, order: projects.length }
      set((s) => ({
        projects: [...s.projects, project],
        boards: [...s.boards, ...entry.boards],
        cards: [...s.cards, ...entry.cards],
        trash: s.trash.filter((e) => e.id !== id),
        revision: s.revision + 1,
        structureRevision: s.structureRevision + 1,
      }))
      // 整条记录覆盖写回:删除标记随之消失
      void db.putProject(project).catch(() => {})
      for (const b of entry.boards) void db.putBoard(b).catch(() => {})
      for (const c of entry.cards) void db.put(c).catch(() => {})
      return { ok: true }
    }

    const src = entry.boards[0]
    if (!src) return { ok: false, reason: '回收站里没有这一项' }
    const home = projects.find((p) => p.id === entry.projectId)
    if (!home) {
      const parent = trash.find((e) => e.kind === 'project' && e.id === entry.projectId)
      return {
        ok: false,
        reason: parent
          ? `它所属的剧「${parent.project?.name ?? ''}」也在回收站里,请先恢复那部剧`
          : '它所属的剧已不存在,无法恢复',
      }
    }
    if (boards.some((b) => b.id === id)) return { ok: false, reason: '同一个分段已经在剧里了' }
    const order = boards.filter((b) => b.projectId === home.id).length
    const board: VideoWorkbenchBoard = { ...src, projectId: home.id, order }
    set((s) => ({
      boards: [...s.boards, board],
      cards: [...s.cards, ...entry.cards],
      trash: s.trash.filter((e) => e.id !== id),
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    void db.putBoard(board).catch(() => {})
    for (const c of entry.cards) void db.put(c).catch(() => {})
    return { ok: true }
  },

  purgeFromTrash: (id) => {
    const { trash } = get()
    const entry = trash.find((e) => e.id === id)
    if (!entry) return false
    // 删剧:它名下之前单独进回收站的分段也没有「家」了,一并清掉
    const doomed =
      entry.kind === 'project'
        ? [entry, ...trash.filter((e) => e.kind === 'board' && e.projectId === id)]
        : [entry]
    const doomedIds = new Set(doomed.map((e) => e.id))
    set((s) => ({ trash: s.trash.filter((e) => !doomedIds.has(e.id)) }))
    const db = getWorkbenchDb()
    for (const e of doomed) {
      if (e.kind === 'project') void db.removeProject(e.id).catch(() => {})
      for (const b of e.boards) void db.removeBoard(b.id).catch(() => {})
      for (const c of e.cards) {
        cancelPendingPersist(c.id)
        void db.remove(c.id).catch(() => {})
      }
    }
    // 顺手清掉这些 id 的置顶记录,别在 localStorage 里越攒越多
    const { pinnedProjectIds, pinnedBoardIds } = get()
    const gone = new Set(doomed.flatMap((e) => [e.id, ...e.boards.map((b) => b.id)]))
    const nextProjectPins = pinnedProjectIds.filter((p) => !gone.has(p))
    const nextBoardPins = pinnedBoardIds.filter((b) => !gone.has(b))
    if (nextProjectPins.length !== pinnedProjectIds.length || nextBoardPins.length !== pinnedBoardIds.length) {
      set({ pinnedProjectIds: nextProjectPins, pinnedBoardIds: nextBoardPins })
      writePins({ projects: nextProjectPins, boards: nextBoardPins })
    }
    return true
  },

  emptyTrash: () => {
    const ids = get().trash.map((e) => e.id)
    // 返回清掉的条目数。先删剧会连带清走它名下的分段条目,后面再 purge 就是 no-op,
    // 所以数的是清之前的条数,不是 purge 成功的次数。
    for (const id of ids) get().purgeFromTrash(id)
    return ids.length
  },

  duplicateBoard: (id) => {
    const { boards, cards } = get()
    const src = boards.find((b) => b.id === id)
    if (!src) return null
    const now = Date.now()
    const own = boards.filter((b) => b.projectId === src.projectId).sort((a, b) => a.order - b.order)
    const at = own.findIndex((b) => b.id === id)
    const copy: VideoWorkbenchBoard = {
      ...src,
      id: createId(),
      name: copyName(src.name, own.map((b) => b.name)),
      createdAt: now,
    }
    // 紧跟在原段后面;其后各段顺延(只改真变了的 order)
    const ordered = compactOrders([...own.slice(0, at + 1), copy, ...own.slice(at + 1)])
    const changed = new Map(ordered.map((b) => [b.id, b]))
    const newCards = cards
      .filter((c) => c.boardId === id)
      .map((c) => cloneCardTo(c, copy.id, now))
    set((s) => ({
      // 保持 boards 数组里原有的相对位置,只在原段后面插入副本、改变了的 order 换新
      boards: s.boards.flatMap((b) =>
        b.id === id
          ? [changed.get(b.id) ?? b, changed.get(copy.id) ?? copy]
          : [changed.get(b.id) ?? b],
      ),
      cards: [...s.cards, ...newCards],
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    const db = getWorkbenchDb()
    for (const b of ordered) {
      if (b.id === copy.id || own.find((o) => o.id === b.id)?.order !== b.order) {
        void db.putBoard(changed.get(b.id)!).catch(() => {})
      }
    }
    for (const c of newCards) void db.put(c).catch(() => {})
    return copy.id
  },

  setProjectPinned: (id, pinned) => {
    const { pinnedProjectIds, pinnedBoardIds, projects } = get()
    if (!projects.some((p) => p.id === id)) return
    if (pinnedProjectIds.includes(id) === pinned) return
    const next = pinned ? [...pinnedProjectIds, id] : pinnedProjectIds.filter((p) => p !== id)
    set({ pinnedProjectIds: next })
    writePins({ projects: next, boards: pinnedBoardIds })
  },

  setBoardPinned: (id, pinned) => {
    const { pinnedProjectIds, pinnedBoardIds, boards } = get()
    if (!boards.some((b) => b.id === id)) return
    if (pinnedBoardIds.includes(id) === pinned) return
    const next = pinned ? [...pinnedBoardIds, id] : pinnedBoardIds.filter((b) => b !== id)
    set({ pinnedBoardIds: next })
    writePins({ projects: pinnedProjectIds, boards: next })
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
