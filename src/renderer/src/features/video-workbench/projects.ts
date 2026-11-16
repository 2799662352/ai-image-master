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
import {
  applyArrangement,
  normalizeGroupName,
  planAssignGroup,
  planDissolveGroup,
  planRenameGroup,
  type ArrangePlan,
} from './projectGroups'
import type { ImportPlan } from './projectFile'
import type { VideoWorkbenchState } from './store'
import { markBoard, markProject, type WorkbenchTrashEntry } from './trash'
import { expiredTrashIds, readTrashRetentionSince } from './trashRetention'
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
  /**
   * 新建剧(自带「分段 1」),切过去并停在总览。返回剧 id。
   * `opts.activate === false`:只建不切 —— agent 对话在后台开新剧时,别把用户正在看
   * (或别的对话正在填)的那部剧从屏幕上挪走。
   */
  addProject: (name?: string, opts?: { activate?: boolean }) => string
  /** 改名;trim 后为空拒绝;同名无操作;改名即视为「用户认领了这部剧」,清 legacy。 */
  renameProject: (id: string, name: string) => boolean
  /** 整体重排,必须给出全集(同 reorderCards)。 */
  reorderProjects: (ids: string[]) => boolean
  /**
   * 剧栏里一次摆放(拖动 / 菜单 / 键盘):按 `ArrangePlan` 一次改顺序 + 分组,**一步撤销、一次落库**
   * (只写 order 或 group 真变了的剧)。计划必须是全集、分组名必须是规整过的非空名;不合法 → false。
   * 摆完没有任何变化 → true 且不 bump revision。分组本身没有记录,见 VideoWorkbenchProject.group。
   */
  arrangeProjects: (plan: ArrangePlan) => boolean
  /** 把剧移进某个分组(`null` = 移出)。进已有分组排到组内最后;新名字 = 原位成组。返回是否合法(没变化也算合法)。 */
  assignProjectGroup: (id: string, group: string | null) => boolean
  /** 重命名分组;新名已存在 = 并入。本机暂存的空分组也能改。名字无效 → false。 */
  renameGroup: (from: string, to: string) => boolean
  /** 解散分组:成员回到未分组、位置不动;空分组则直接删掉。 */
  dissolveGroup: (name: string) => boolean
  /**
   * 本机暂存的空分组(用户点 ⊞ 新建、还没放进任何剧)。**纯界面偏好**:存 localStorage,不进库、
   * 不进撤销栈、不进备份 —— 第一部剧放进来之后,分组才真正存在于剧的 `group` 字段里。
   */
  emptyGroups: string[]
  /** 新建一个空分组;名字无效 / 已有同名分组 → 返回原因。 */
  createEmptyGroup: (name: string) => { ok: true; name: string } | { ok: false; reason: string }
  /** 折叠中的分组名。同 emptyGroups,纯界面偏好。 */
  collapsedGroups: string[]
  toggleGroupCollapsed: (name: string) => void
  /** 整体重排一部剧里的分段,必须给出这部剧的全部分段 id(同 reorderProjects);别的剧的分段不受影响。 */
  reorderBoards: (projectId: string, ids: string[]) => boolean
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
  /**
   * 清掉在回收站里躺满保留期(30 天)的条目,返回清掉的条数。打开工作台、水合完成后调一次
   * (见 trashRetention.ts:计时起点 / 时钟回拨保护)。和手动「彻底删除」走同一条路。
   */
  purgeExpiredTrash: (now?: number) => number
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
   * `group`(工程文件里的 `project.group`):规整后写在新剧上 = 自动并入本机同名分组,没有就新成一组;
   * 它是**那部剧此刻所在的分组**,不是对分组本身的描述,所以不会改动本机已有分组的任何东西。
   */
  importProject: (plan: ImportPlan, name: string, summary?: string, group?: string) => string
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

/** 分组的两份本机界面偏好:本机暂存的空分组、折叠中的分组(都是分组名列表)。 */
export const EMPTY_GROUPS_KEY = 'vw-groups-empty'
export const COLLAPSED_GROUPS_KEY = 'vw-groups-collapsed'

export function readGroupNames(key: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const v of parsed) {
      const n = normalizeGroupName(v)
      if (n && !out.includes(n)) out.push(n)
    }
    return out
  } catch {
    return []
  }
}

function writeGroupNames(key: string, names: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(names))
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

export type DropPlace = 'before' | 'after'

/** 把 dragId 挪到 targetId 的前面 / 后面。两者相同、或有一个不在 ids 里 → null。 */
export function moveIdNear(
  ids: readonly string[],
  dragId: string,
  targetId: string,
  place: DropPlace,
): string[] | null {
  if (dragId === targetId || !ids.includes(dragId) || !ids.includes(targetId)) return null
  const rest = ids.filter((id) => id !== dragId)
  const at = rest.indexOf(targetId)
  rest.splice(place === 'before' ? at : at + 1, 0, dragId)
  return rest
}

/**
 * 拖拽排序:把 dragId 放到 targetId 的前面 / 后面,返回新的**全量**顺序(给 `reorderProjects` /
 * `reorderBoards` 这类要整组 id 的接口);不该动就返回 null。
 *
 * - 置顶的永远排在不置顶的前面(显示顺序 = pinnedFirstBy(存储顺序)),所以**不允许跨组**:
 *   想放到最上面,先置顶。
 * - 在**存储顺序**(ids)上挪,不是在显示顺序上:另一组的相对位置原样不动,取消置顶后各回各位。
 * - 挪完显示顺序没变(放到自己旁边、本来就相邻)也返回 null,调用方不必 bump revision、重写库。
 */
export function planReorder(
  ids: readonly string[],
  pinnedIds: readonly string[],
  dragId: string,
  targetId: string,
  place: DropPlace,
): string[] | null {
  const pinned = new Set(pinnedIds)
  if (pinned.has(dragId) !== pinned.has(targetId)) return null
  const next = moveIdNear(ids, dragId, targetId, place)
  if (!next) return null
  const shownNow = pinnedFirstBy(ids, pinnedIds, (id) => id)
  const shownNext = pinnedFirstBy(next, pinnedIds, (id) => id)
  return shownNext.every((id, i) => id === shownNow[i]) ? null : next
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
  emptyGroups: readGroupNames(EMPTY_GROUPS_KEY),
  collapsedGroups: readGroupNames(COLLAPSED_GROUPS_KEY),

  addProject: (name, opts) => {
    const activate = opts?.activate !== false
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
      // 只建不切时,屏幕指针与选中态都留给正在看的那部剧。
      ...(activate
        ? {
            activeProjectId: project.id,
            activeBoardId: board.id,
            selectedCardIds: [],
            selectionAnchorId: undefined,
          }
        : {}),
      viewByProject: { ...s.viewByProject, [project.id]: { mode: 'overview' } },
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    if (activate) writeActiveProject(project.id)
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

  arrangeProjects: (plan) => {
    const cur = [...get().projects].sort((a, b) => a.order - b.order)
    if (plan.ids.length !== cur.length || new Set(plan.ids).size !== plan.ids.length) return false
    const byId = new Map(cur.map((p) => [p.id, p]))
    if (!plan.ids.every((id) => byId.has(id))) return false
    const groups: Record<string, string | null> = {}
    for (const [id, g] of Object.entries(plan.groups)) {
      if (!byId.has(id)) return false
      if (g === null) {
        groups[id] = null
        continue
      }
      // 分组名必须是规整过的:不在这里悄悄改写,免得计划和落地对不上
      if (normalizeGroupName(g) !== g) return false
      groups[id] = g
    }
    const arranged = compactOrders(applyArrangement(cur, { ids: plan.ids, groups }))
    // 只有 order 或 group 真变了的剧才换新对象、才写库
    const changed = arranged.filter((p) => p !== byId.get(p.id))
    if (changed.length === 0) return true
    // 本机暂存的空分组一旦有了成员,就不再是「暂存」了
    const used = new Set(arranged.flatMap((p) => (p.group ? [p.group] : [])))
    const prevEmpty = get().emptyGroups
    const nextEmpty = prevEmpty.filter((n) => !used.has(n))
    const emptyChanged = nextEmpty.length !== prevEmpty.length
    set((s) => ({
      projects: arranged,
      ...(emptyChanged ? { emptyGroups: nextEmpty } : {}),
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    if (emptyChanged) writeGroupNames(EMPTY_GROUPS_KEY, nextEmpty)
    const db = getWorkbenchDb()
    for (const p of changed) void db.putProject(p).catch(() => {})
    return true
  },

  assignProjectGroup: (id, group) => {
    const name = group === null ? null : (normalizeGroupName(group) ?? undefined)
    if (name === undefined) return false
    const items = [...get().projects].sort((a, b) => a.order - b.order)
    if (!items.some((p) => p.id === id)) return false
    const plan = planAssignGroup(items, get().pinnedProjectIds, id, name)
    return plan ? get().arrangeProjects(plan) : true
  },

  renameGroup: (from, to) => {
    const next = normalizeGroupName(to)
    if (!next) return false
    const items = [...get().projects].sort((a, b) => a.order - b.order)
    if (items.some((p) => p.group === from)) {
      const plan = planRenameGroup(items, get().pinnedProjectIds, from, next)
      if (plan && !get().arrangeProjects(plan)) return false
    } else if (get().emptyGroups.includes(from)) {
      if (next === from) return true
      const { emptyGroups } = get()
      // 改成一个已经存在的名字 = 并入它(空分组没有成员,并入就是它自己消失)
      const exists = items.some((p) => p.group === next) || emptyGroups.includes(next)
      const nextEmpty = exists ? emptyGroups.filter((n) => n !== from) : emptyGroups.map((n) => (n === from ? next : n))
      set({ emptyGroups: nextEmpty })
      writeGroupNames(EMPTY_GROUPS_KEY, nextEmpty)
    } else {
      return false
    }
    // 折叠状态跟着名字走
    const { collapsedGroups } = get()
    if (next !== from && collapsedGroups.includes(from)) {
      const moved = collapsedGroups.filter((n) => n !== from)
      if (!moved.includes(next)) moved.push(next)
      set({ collapsedGroups: moved })
      writeGroupNames(COLLAPSED_GROUPS_KEY, moved)
    }
    return true
  },

  dissolveGroup: (name) => {
    const items = [...get().projects].sort((a, b) => a.order - b.order)
    if (items.some((p) => p.group === name)) {
      const plan = planDissolveGroup(items, get().pinnedProjectIds, name)
      if (plan && !get().arrangeProjects(plan)) return false
    } else if (get().emptyGroups.includes(name)) {
      const nextEmpty = get().emptyGroups.filter((n) => n !== name)
      set({ emptyGroups: nextEmpty })
      writeGroupNames(EMPTY_GROUPS_KEY, nextEmpty)
    } else {
      return false
    }
    const { collapsedGroups } = get()
    if (collapsedGroups.includes(name)) {
      const nextCollapsed = collapsedGroups.filter((n) => n !== name)
      set({ collapsedGroups: nextCollapsed })
      writeGroupNames(COLLAPSED_GROUPS_KEY, nextCollapsed)
    }
    return true
  },

  createEmptyGroup: (name) => {
    const n = normalizeGroupName(name)
    if (!n) return { ok: false, reason: '分组名不能为空' }
    const { projects, emptyGroups } = get()
    if (projects.some((p) => p.group === n) || emptyGroups.includes(n)) return { ok: false, reason: '已有同名分组' }
    const next = [...emptyGroups, n]
    set({ emptyGroups: next })
    writeGroupNames(EMPTY_GROUPS_KEY, next)
    return { ok: true, name: n }
  },

  toggleGroupCollapsed: (name) => {
    const { collapsedGroups } = get()
    const next = collapsedGroups.includes(name) ? collapsedGroups.filter((n) => n !== name) : [...collapsedGroups, name]
    set({ collapsedGroups: next })
    writeGroupNames(COLLAPSED_GROUPS_KEY, next)
  },

  reorderBoards: (projectId, ids) => {
    const own = get()
      .boards.filter((b) => b.projectId === projectId)
      .sort((a, b) => a.order - b.order)
    if (own.length === 0 || ids.length !== own.length || new Set(ids).size !== ids.length) return false
    const byId = new Map(own.map((b) => [b.id, b]))
    if (!ids.every((id) => byId.has(id))) return false
    if (ids.every((id, i) => own[i].id === id)) return true
    // 只有 order 真变了的分段才换新对象、才写库
    const reordered = compactOrders(ids.map((id) => byId.get(id)!))
    const changed = new Map(reordered.filter((b) => b !== byId.get(b.id)).map((b) => [b.id, b]))
    set((s) => ({
      boards: s.boards.map((b) => changed.get(b.id) ?? b),
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    const db = getWorkbenchDb()
    for (const b of changed.values()) void db.putBoard(b).catch(() => {})
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

  importProject: (plan, name, summary, group) => {
    const now = Date.now()
    const { projects, emptyGroups } = get()
    const trimmedSummary = summary?.trim().slice(0, WORKBENCH_PROJECT_SUMMARY_MAX)
    // 文件里带分组名 → 自动并入本机同名分组(没有就新成一组);order 排在最后 = 组内最后一部
    const groupName = normalizeGroupName(group)
    const project: VideoWorkbenchProject = {
      id: createId(),
      name: name.trim() || '导入的剧',
      order: projects.length,
      createdAt: now,
      updatedAt: now,
      ...(trimmedSummary ? { summary: trimmedSummary } : {}),
      ...(groupName ? { group: groupName } : {}),
    }
    const nextEmpty = groupName && emptyGroups.includes(groupName) ? emptyGroups.filter((n) => n !== groupName) : emptyGroups
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
      ...(nextEmpty !== emptyGroups ? { emptyGroups: nextEmpty } : {}),
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    if (nextEmpty !== emptyGroups) writeGroupNames(EMPTY_GROUPS_KEY, nextEmpty)
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

  purgeExpiredTrash: (now = Date.now()) => {
    const ids = expiredTrashIds(get().trash, now, readTrashRetentionSince(now))
    let purged = 0
    // 删剧会连带清走它名下单独进回收站的分段条目,后面再 purge 就是 no-op(返回 false)
    for (const id of ids) if (get().purgeFromTrash(id)) purged += 1
    return purged
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
