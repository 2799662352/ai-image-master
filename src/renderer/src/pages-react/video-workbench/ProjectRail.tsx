// 左侧「剧栏」:所有剧的常驻列表。行 = 封面 · 名 · 段/镜/花费 · 时间 · 三色条;
// 黄点 = 有卡生成中,红点 = 有失败。当前剧黄色左条。可折叠到 48px 只留封面。
// 视觉只用 workbench.css 的 .vw-rail-* 类与既有 token。
//
// 底部一行等分的四个入口:导入工程 / 导出当前剧 / 云备份 / 回收站(后两个由页面传回调才出现)。
// 导入、导出工程的入口只在这里有一份,剧总览头部不再重复放。
//
// 分组(文件夹):剧可以收进可折叠的分组。分组只是剧上的 `group` 字段(见 VideoWorkbenchProject.group),
// 剧栏的样子由 projectGroups.ts 从 order + group + 置顶推出来;所有摆放(拖动 / 菜单 / 键盘)都先算成一份
// ArrangePlan、再由 store 的 arrangeProjects 一次落地(一步撤销)。搜索中与折叠到 48px 时不显示分组结构。

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ChevronDown, ChevronRight, Cloud, Download, Folder, FolderOpen, FolderPlus, Trash2, Upload } from 'lucide-react'
import type { VideoWorkbenchProject } from '../../../../types/videoWorkbench'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { formatDuration, summarizeProject } from '../../features/video-workbench/projectStats'
import {
  buildRailEntries,
  flattenRailEntries,
  listGroupNames,
  planMoveGroup,
  planMoveProject,
  planNudge,
  type ArrangePlan,
  type GroupBlock,
} from '../../features/video-workbench/projectGroups'
import type { DropPlace } from '../../features/video-workbench/projects'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { isProjectFileName } from '../../features/video-workbench/importProject'
import { useToastStore } from '../../stores/useToastStore'
import { useContextMenu } from './ContextMenu'
import { CoverImage } from './CoverImage'
import { GroupPickDialog } from './GroupPickDialog'
import { SEGMENT_DRAG_MIME } from './ProjectOverview'
import { RenameDialog } from './RenameDialog'
import { useCloudBackupTone } from './useCloudBackup'
import { groupMenuItems, projectMenuItems } from './workbenchMenus'

function carriesSegment(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes(SEGMENT_DRAG_MIME)
}

/** 直接拖剧行调整剧的顺序时,dataTransfer 里放剧 id 用的类型(和分段卡的 SEGMENT_DRAG_MIME 互不相干)。 */
export const PROJECT_DRAG_MIME = 'application/x-catimation-project'
/** 直接拖分组标题挪整个分组时,dataTransfer 里放分组名用的类型。 */
export const GROUP_DRAG_MIME = 'application/x-catimation-group'

function carriesProject(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes(PROJECT_DRAG_MIME)
}

function carriesGroup(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes(GROUP_DRAG_MIME)
}

/** 拖动时的落点标记(决定画哪条黄线 / 哪个虚线框),同时就是算计划的入参。 */
type RailMark =
  | { kind: 'row'; id: string; place: DropPlace }
  | { kind: 'group'; name: string; zone: 'before' | 'into' | 'after' }
  | { kind: 'tail' }

function sameMark(a: RailMark | null, b: RailMark): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

export function relativeTime(ts: number | null, now = Date.now()): string {
  if (ts === null) return ''
  const m = Math.floor((now - ts) / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  return `${Math.floor(d / 7)} 周前`
}

export interface ProjectRailProps {
  onRequestImport?: () => void
  onRequestExport?: () => void
  /** 打开回收站(由页面挂 TrashDialog)。不传 = 不显示回收站入口。 */
  onRequestTrash?: () => void
  /** 打开云备份面板(由页面挂 CloudBackupDialog)。不传 = 不显示入口(非桌面端)。 */
  onRequestCloudBackup?: () => void
  /** 用户把一个 `*.catwb.json` 拖到了剧栏上:交回路径,由页面打开导入确认页。 */
  onDropProjectFile?: (path: string) => void
}

function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes('Files')
}

/** 拖进来的文件里第一个工程文件的真实路径(Electron 的 File 带 path;浏览器没有)。 */
function droppedProjectFilePath(e: DragEvent): string | null {
  for (const file of Array.from(e.dataTransfer.files ?? [])) {
    if (!isProjectFileName(file.name)) continue
    const api = (window as Window & { electronAPI?: { getFilePath?: (f: File) => string } }).electronAPI
    const p = api?.getFilePath?.(file) || (file as File & { path?: string }).path
    if (p) return p
  }
  return null
}

export function ProjectRail({
  onRequestImport,
  onRequestExport,
  onRequestTrash,
  onRequestCloudBackup,
  onDropProjectFile,
}: ProjectRailProps) {
  const cloudTone = useCloudBackupTone()
  const projects = useVideoWorkbenchStore((s) => s.projects)
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const cards = useVideoWorkbenchStore((s) => s.cards)
  const activeProjectId = useVideoWorkbenchStore((s) => s.activeProjectId)
  const collapsed = useVideoWorkbenchStore((s) => s.railCollapsed)
  const setRailCollapsed = useVideoWorkbenchStore((s) => s.setRailCollapsed)
  const addProject = useVideoWorkbenchStore((s) => s.addProject)
  const switchProject = useVideoWorkbenchStore((s) => s.switchProject)
  const renameProject = useVideoWorkbenchStore((s) => s.renameProject)
  const moveBoardToProject = useVideoWorkbenchStore((s) => s.moveBoardToProject)
  const arrangeProjects = useVideoWorkbenchStore((s) => s.arrangeProjects)
  const assignProjectGroup = useVideoWorkbenchStore((s) => s.assignProjectGroup)
  const renameGroup = useVideoWorkbenchStore((s) => s.renameGroup)
  const createEmptyGroup = useVideoWorkbenchStore((s) => s.createEmptyGroup)
  const toggleGroupCollapsed = useVideoWorkbenchStore((s) => s.toggleGroupCollapsed)
  const emptyGroups = useVideoWorkbenchStore((s) => s.emptyGroups)
  const collapsedGroups = useVideoWorkbenchStore((s) => s.collapsedGroups)
  const pinnedProjectIds = useVideoWorkbenchStore((s) => s.pinnedProjectIds)
  const trashCount = useVideoWorkbenchStore((s) => s.trash.length)
  const menu = useContextMenu()
  /** 折叠态剧栏没有就地输入框,右键「重命名」改走小对话框。 */
  const [renamingInDialog, setRenamingInDialog] = useState<{ id: string; name: string } | null>(null)
  /** 正在重命名的分组(原名);null = 没有。 */
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  /** 「移到分组…」对话框要处理的那部剧。 */
  const [pickingGroupFor, setPickingGroupFor] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  /** 有分段卡正拖在剧栏上空:顶部露出「新建一部剧并移入」的投放框。 */
  const [dragOver, setDragOver] = useState(false)
  /** 分段卡正拖在哪部剧的行上(那一行亮虚线框 + 「移入此剧」);null = 没有可放的行。 */
  const [segmentTargetId, setSegmentTargetId] = useState<string | null>(null)
  /** 有系统文件正拖在剧栏上空(工程文件导入)。 */
  const [fileOver, setFileOver] = useState(false)
  // 直接拖剧行 / 分组标题调整顺序:真正被拖的 id / 分组名放 ref(dragover / drop 同步要读),
  // 变暗只是视觉,延后一拍再 setState(见 startProjectDrag)。同一时刻只会有一个在拖。
  const draggingProjectRef = useRef<string | null>(null)
  const draggingGroupRef = useRef<string | null>(null)
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null)
  const [draggingGroupName, setDraggingGroupName] = useState<string | null>(null)
  const dimTimerRef = useRef<number | null>(null)
  /** 落点标记:黄色插入线画在哪、哪个分组标题亮虚线框。 */
  const [dropMark, setDropMark] = useState<RailMark | null>(null)
  useEffect(
    () => () => {
      if (dimTimerRef.current !== null) window.clearTimeout(dimTimerRef.current)
    },
    [],
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editingId) nameInputRef.current?.focus()
  }, [editingId])

  // 分段卡的拖动在剧栏之外结束(松在不能放的地方 / Esc 取消)时,剧栏收不到 drop,也不一定收到 dragleave:
  // 高亮和顶部投放框会卡在那儿。dragend(来自被拖的卡,冒泡到 window)与 drop(冒泡阶段,在行 / 投放框自己的
  // 处理器之后)都是「这一趟结束了」的信号。
  const segmentDragLive = segmentTargetId !== null || dragOver
  useEffect(() => {
    if (!segmentDragLive) return
    const finish = () => {
      setSegmentTargetId(null)
      setDragOver(false)
    }
    window.addEventListener('dragend', finish)
    window.addEventListener('drop', finish)
    return () => {
      window.removeEventListener('dragend', finish)
      window.removeEventListener('drop', finish)
    }
  }, [segmentDragLive])

  // 底部入口的列数 = 实际渲染的按钮数(云备份只在桌面端有、回收站要页面接了才有)
  const footCols = 2 + (onRequestCloudBackup ? 1 : 0) + (onRequestTrash ? 1 : 0)

  const needle = query.trim().toLowerCase()
  /** 当前存储顺序(不含置顶 / 分组的显示重排)。所有摆放计划都在它上面算。 */
  const sorted = projects.slice().sort((a, b) => a.order - b.order)
  const statsById = new Map(sorted.map((p) => [p.id, summarizeProject(p.id, boards, cards)] as const))
  // 搜索过滤时列表只是子集、折叠态只剩 48px 的封面条也没有地方放分组标题:这两种情况不显示分组结构,也不开放排序
  // (子集里的「前后」没有明确含义)。
  const grouped = !collapsed && !needle
  const canReorder = grouped
  const entries = buildRailEntries(sorted, pinnedProjectIds, grouped ? emptyGroups : [])
  const flatRows = flattenRailEntries(entries).filter((p) => !needle || p.name.toLowerCase().includes(needle))
  const hasGroups = entries.some((e) => e.kind === 'group')

  const endRailDrag = () => {
    draggingProjectRef.current = null
    draggingGroupRef.current = null
    if (dimTimerRef.current !== null) {
      window.clearTimeout(dimTimerRef.current)
      dimTimerRef.current = null
    }
    setDraggingProjectId(null)
    setDraggingGroupName(null)
    setDropMark(null)
  }
  /** 浏览器在 dragstart 处理完之后才截拖影;React 会在处理器返回时同步刷 DOM,
   *  若此刻就把原行变暗,拖影也是暗的。延后一拍。 */
  const dimLater = (apply: () => void, stillDragging: () => boolean) => {
    dimTimerRef.current = window.setTimeout(() => {
      dimTimerRef.current = null
      if (stillDragging()) apply()
    }, 0)
  }
  const startProjectDrag = (e: DragEvent<HTMLElement>, id: string) => {
    // 行本身不可拖时(搜索 / 折叠 / 正在改名),冒到这里的 dragstart 是行内别的东西起的
    // (比如在改名框里拖选的文字):别认领,让浏览器按它自己的默认来。
    if (!canReorder || editingId === id) return
    e.dataTransfer.setData(PROJECT_DRAG_MIME, id)
    e.dataTransfer.effectAllowed = 'move'
    // 拖影用整行(从行内哪里抓起,拖影就以哪里为锚点)
    const row = e.currentTarget.closest<HTMLElement>('.vw-rail-row')
    if (row && typeof e.dataTransfer.setDragImage === 'function') {
      const r = row.getBoundingClientRect()
      e.dataTransfer.setDragImage(row, e.clientX - r.left, e.clientY - r.top)
    }
    draggingProjectRef.current = id
    dimLater(() => setDraggingProjectId(id), () => draggingProjectRef.current === id)
  }
  const startGroupDrag = (e: DragEvent<HTMLElement>, name: string) => {
    e.dataTransfer.setData(GROUP_DRAG_MIME, name)
    e.dataTransfer.effectAllowed = 'move'
    // 拖影用整个分组块(标题 + 成员)
    const block = e.currentTarget.closest<HTMLElement>('.vw-rail-group')
    if (block && typeof e.dataTransfer.setDragImage === 'function') {
      const r = block.getBoundingClientRect()
      e.dataTransfer.setDragImage(block, e.clientX - r.left, e.clientY - r.top)
    }
    draggingGroupRef.current = name
    dimLater(() => setDraggingGroupName(name), () => draggingGroupRef.current === name)
  }
  const placeOf = (e: DragEvent<HTMLElement>): DropPlace => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
  }
  /** 分组标题上:上 1/4 = 放到整块之前,下 1/4 = 之后,中间 = 放进这个分组。空分组整个标题都是「放进」。 */
  const zoneOfHeader = (e: DragEvent<HTMLElement>, empty: boolean): 'before' | 'into' | 'after' => {
    if (empty) return 'into'
    const r = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - r.top
    return y < r.height * 0.25 ? 'before' : y > r.height * 0.75 ? 'after' : 'into'
  }

  /** 这个落点会让剧栏变成什么样;不能放(自己 / 没变化 / 跨置顶 / 分组放进自己里)→ null。 */
  const planFor = (mark: RailMark): ArrangePlan | null => {
    const pid = draggingProjectRef.current
    if (pid) {
      if (mark.kind === 'row') return planMoveProject(sorted, pinnedProjectIds, pid, { kind: 'row', id: mark.id, place: mark.place })
      if (mark.kind === 'group') return planMoveProject(sorted, pinnedProjectIds, pid, { kind: 'group', name: mark.name, zone: mark.zone })
      return planMoveProject(sorted, pinnedProjectIds, pid, { kind: 'tail' })
    }
    const gname = draggingGroupRef.current
    if (gname) {
      if (mark.kind === 'row') return planMoveGroup(sorted, pinnedProjectIds, gname, { kind: 'row', id: mark.id, place: mark.place })
      if (mark.kind === 'group') {
        return mark.zone === 'into' ? null : planMoveGroup(sorted, pinnedProjectIds, gname, { kind: 'group', name: mark.name, place: mark.zone })
      }
      return planMoveGroup(sorted, pinnedProjectIds, gname, { kind: 'tail' })
    }
    return null
  }
  /**
   * 拖着剧(或分组)经过某个落点。`deferGroupDrag`:这个落点不接分组的拖动(分组里的成员行、分组标题),
   * 事件冒泡到外层的分组块,由它按「整块的前 / 后」处理。
   */
  const handleRailDragOver = (e: DragEvent<HTMLElement>, mark: RailMark, deferGroupDrag = false) => {
    const kind = draggingProjectRef.current && carriesProject(e) ? 'project' : draggingGroupRef.current && carriesGroup(e) ? 'group' : null
    if (!kind || (kind === 'group' && deferGroupDrag)) return
    const plan = planFor(mark)
    if (!plan) {
      // 不能放这里(自己 / 已相邻 / 跨置顶分组):不画线,不 preventDefault → 光标显示禁止
      e.dataTransfer.dropEffect = 'none'
      if (dropMark) setDropMark(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!sameMark(dropMark, mark)) setDropMark(mark)
  }
  const handleRailDrop = (e: DragEvent<HTMLElement>, mark: RailMark, deferGroupDrag = false) => {
    const kind = draggingProjectRef.current && carriesProject(e) ? 'project' : draggingGroupRef.current && carriesGroup(e) ? 'group' : null
    if (!kind || (kind === 'group' && deferGroupDrag)) return
    e.preventDefault()
    const plan = planFor(mark)
    endRailDrag()
    if (!plan) return
    arrangeProjects(plan)
    // 放进一个折叠着的分组:顺手展开,免得剧「消失」在里面
    if (mark.kind === 'group' && mark.zone === 'into' && collapsedGroups.includes(mark.name)) toggleGroupCollapsed(mark.name)
  }
  /** 把手获得焦点时 ↑ ↓ 挪一格(不用鼠标也能排序)。 */
  const nudge = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    who: { kind: 'project'; id: string } | { kind: 'group'; name: string },
  ) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    // 行按 key 复用、只是换位:React 提交后会把焦点还给原来聚焦的元素,所以可以连按 ↑ ↓ 一路挪。
    const plan = planNudge(sorted, pinnedProjectIds, who, e.key === 'ArrowUp' ? 'up' : 'down')
    if (plan) arrangeProjects(plan)
  }

  // ---- 把分段卡拖到剧栏:搬进别的剧 ----
  // 分段卡只出现在总览里,总览显示的就是当前剧 → 被拖的分段属于 activeProjectId。能搬走的条件与
  // moveBoardToProject 一致:目标不是它自己所在的剧,且源剧搬走后至少还剩一段(每部剧至少一段)。
  // dragover 里读不到 dataTransfer 的内容,只能靠这两条判断。
  const canMoveSegmentOut = boards.filter((b) => b.projectId === activeProjectId).length >= 2
  /** 分段卡经过某部剧的行:能放 → 那一行亮虚线框并接收;不能放 → 光标禁止,不亮。 */
  const handleSegmentOver = (e: DragEvent<HTMLElement>, projectId: string) => {
    if (!canMoveSegmentOut || projectId === activeProjectId) {
      e.dataTransfer.dropEffect = 'none'
      // 不能让列表级的 preventDefault 把它放行
      e.stopPropagation()
      if (segmentTargetId !== null) setSegmentTargetId(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (segmentTargetId !== projectId) setSegmentTargetId(projectId)
  }
  const handleSegmentDrop = (e: DragEvent<HTMLElement>, projectId: string) => {
    const boardId = e.dataTransfer.getData(SEGMENT_DRAG_MIME)
    if (!boardId) return
    e.preventDefault()
    setSegmentTargetId(null)
    setDragOver(false)
    moveBoardToProject(boardId, projectId)
  }

  const beginRename = (id: string, current: string) => {
    setEditingId(id)
    setDraft(current)
  }
  const openMenu = (e: ReactMouseEvent, id: string, name: string) =>
    menu.open(
      e,
      projectMenuItems(id, {
        onRename: () => (collapsed ? setRenamingInDialog({ id, name }) : beginRename(id, name)),
        onMoveToGroup: () => setPickingGroupFor(id),
      }),
    )
  const openGroupMenu = (e: ReactMouseEvent, group: GroupBlock<VideoWorkbenchProject>) =>
    menu.open(e, groupMenuItems(group.name, { empty: group.empty, onRename: () => setRenamingGroup(group.name) }))
  const commitRename = () => {
    if (editingId) renameProject(editingId, draft)
    setEditingId(null)
  }
  // 新建零表单:建完立刻进入改名,Esc 就保留默认名。
  const handleAdd = () => {
    const id = addProject()
    beginRename(id, useVideoWorkbenchStore.getState().projects.find((p) => p.id === id)?.name ?? '')
  }

  const renderProjectRow = (project: VideoWorkbenchProject, inGroup: boolean) => {
    const stats = statsById.get(project.id)!
    const isActive = project.id === activeProjectId
    const t = stats.totals
    const cost = formatCostParts(t.cost.usd, t.cost.cny)
    const pinned = pinnedProjectIds.includes(project.id)
    const mark = dropMark?.kind === 'row' && dropMark.id === project.id ? dropMark.place : null
    const segmentTarget = segmentTargetId === project.id
    return (
      <div
        key={project.id}
        role="listitem"
        className={[
          'vw-rail-row',
          isActive && 'vw-rail-row-active',
          draggingProjectId === project.id && 'vw-rail-row-dragging',
          segmentTarget && 'vw-rail-row-segdrop',
          mark === 'before' && 'vw-rail-drop-before',
          mark === 'after' && 'vw-rail-drop-after',
        ]
          .filter(Boolean)
          .join(' ')}
        // 整行都是拖动手柄:点按、双击改名、右键、分段卡投放都不受影响(浏览器要挪过几像素才起拖)。
        // 改名输入框打开时关掉 —— 否则在输入框里拖选文字会变成拖整行。
        draggable={canReorder && editingId !== project.id}
        onDragStart={(e) => startProjectDrag(e, project.id)}
        onDragEnd={endRailDrag}
        onContextMenu={(e) => openMenu(e, project.id, project.name)}
        // 分段卡(搬进这部剧)与剧 / 分组(调顺序)是两种拖动,各走各的;放在行上而不是行按钮上,
        // 这样经过行里的点阵、「⋯」时也算在这一行上。
        onDragOver={(e) =>
          carriesSegment(e)
            ? handleSegmentOver(e, project.id)
            : handleRailDragOver(e, { kind: 'row', id: project.id, place: placeOf(e) }, inGroup)
        }
        onDragLeave={(e) => {
          if (segmentTarget && !e.currentTarget.contains(e.relatedTarget as Node | null)) setSegmentTargetId(null)
        }}
        onDrop={(e) =>
          carriesSegment(e)
            ? handleSegmentDrop(e, project.id)
            : handleRailDrop(e, { kind: 'row', id: project.id, place: placeOf(e) }, inGroup)
        }
      >
        <button
          type="button"
          className="vw-rail-rowbtn"
          aria-label={`切换到剧 ${project.name}`}
          aria-current={isActive ? 'true' : undefined}
          title={collapsed ? `${project.name}${pinned ? '(已置顶)' : ''}` : undefined}
          onClick={() => switchProject(project.id)}
          onDoubleClick={() => !collapsed && beginRename(project.id, project.name)}
        >
          {collapsed && pinned && <span className="vw-pin-dot" aria-hidden="true" />}
          <div className="vw-rail-cover" aria-hidden="true">
            <CoverImage src={stats.cover} />
          </div>
          {!collapsed && (
            <div className="vw-rail-meta">
              <div className="vw-rail-name">
                {editingId === project.id ? (
                  <input
                    ref={nameInputRef}
                    aria-label="剧名"
                    className="vw-rail-nameinput"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="truncate">{project.name}</span>
                )}
                {pinned && editingId !== project.id && (
                  <span className="vw-pin" title="已置顶">PIN</span>
                )}
                {t.active > 0 && (
                  <span className="vw-dot vw-dot-yellow" title={`${t.active} 镜生成中`}>
                    {t.active}
                  </span>
                )}
                {t.failed > 0 && (
                  <span className="vw-dot vw-dot-red" title={`${t.failed} 镜失败`}>
                    {t.failed}
                  </span>
                )}
              </div>
              <div className="vw-rail-sub">
                {stats.segments.length} 段 · {t.total} 镜
                {cost ? ` · ${cost}` : ''}
                {t.doneSeconds > 0 ? ` · ${formatDuration(t.doneSeconds)}` : ''}
              </div>
              <div className="vw-strip" aria-hidden="true">
                {t.done > 0 && <div style={{ flex: t.done, background: '#22c55e' }} />}
                {t.active > 0 && <div style={{ flex: t.active, background: '#FCE300' }} />}
                {t.failed > 0 && <div style={{ flex: t.failed, background: '#f87171' }} />}
              </div>
            </div>
          )}
          {!collapsed && <div className="vw-rail-time">{relativeTime(t.lastActivityAt)}</div>}
        </button>
        {/* 分段卡拖到这一行上:告诉用户「放下就搬进这部剧」(折叠态没有地方放字,只剩虚线框) */}
        {segmentTarget && !collapsed && (
          <span className="vw-rail-segtip" aria-hidden="true">
            移入此剧
          </span>
        )}
        {/* 左侧的点阵:告诉你「这行能拖」,同时是键盘入口(Tab 聚焦后 ↑ ↓ 挪一格)。
            鼠标拖动不必抓它 —— 整行都能拖,拖这里等于拖整行(冒泡到行的 dragstart)。 */}
        {canReorder && (
          <button
            type="button"
            className="vw-rail-grip"
            aria-label={`拖动调整 ${project.name} 的位置`}
            title="整行都可以拖动调整顺序(可拖进分组),或聚焦后按 ↑ ↓;置顶的剧始终排在最上面"
            onKeyDown={(e) => nudge(e, { kind: 'project', id: project.id })}
          />
        )}
        {/* 与右键同一份菜单的可见入口;按钮并列在行按钮旁(按钮里不能再嵌按钮) */}
        {!collapsed && (
          <button
            type="button"
            className="vw-rail-more"
            aria-label={`剧菜单 ${project.name}`}
            aria-haspopup="menu"
            title="更多操作(也可以右键)"
            onClick={(e) => openMenu(e, project.id, project.name)}
          >
            ⋯
          </button>
        )}
      </div>
    )
  }

  const renderGroup = (group: GroupBlock<VideoWorkbenchProject>) => {
    const { name, members } = group
    const isCollapsed = !group.empty && collapsedGroups.includes(name)
    // 折叠着的分组里,当前正在看的那部剧仍露出来:别让用户「找不到自己在哪」
    const shown = isCollapsed ? members.filter((m) => m.id === activeProjectId) : members
    const doneSeconds = members.reduce((sum, m) => sum + (statsById.get(m.id)?.totals.doneSeconds ?? 0), 0)
    const mark = dropMark?.kind === 'group' && dropMark.name === name ? dropMark.zone : null
    const draggingThis = draggingGroupName === name
    return (
      <div
        key={`group:${name}`}
        role="listitem"
        className={[
          'vw-rail-group',
          draggingThis && 'vw-rail-group-dragging',
          mark === 'before' && 'vw-rail-drop-before',
          mark === 'after' && 'vw-rail-drop-after',
        ]
          .filter(Boolean)
          .join(' ')}
        // 拖整个分组时,整块上半 = 放到它之前,下半 = 之后(成员行和标题都把这类拖动交给这里)
        onDragOver={(e) => {
          if (draggingGroupRef.current) handleRailDragOver(e, { kind: 'group', name, zone: placeOf(e) })
        }}
        onDrop={(e) => {
          if (draggingGroupRef.current) handleRailDrop(e, { kind: 'group', name, zone: placeOf(e) })
        }}
      >
        <div
          className={['vw-rail-ghd', mark === 'into' && 'vw-rail-ghd-drop'].filter(Boolean).join(' ')}
          // 整个标题都能抓起来拖(空分组没有成员可挪,不开放);点标题仍是折叠 / 展开
          draggable={canReorder && !group.empty}
          onDragStart={(e) => startGroupDrag(e, name)}
          onDragEnd={endRailDrag}
          onContextMenu={(e) => openGroupMenu(e, group)}
          onDragOver={(e) => {
            // 分段卡不能放在分组标题上(它要放进某一部剧):明确显示禁止,而不是让列表级的 preventDefault 误放行
            if (carriesSegment(e)) {
              e.dataTransfer.dropEffect = 'none'
              e.stopPropagation()
              if (segmentTargetId !== null) setSegmentTargetId(null)
              return
            }
            handleRailDragOver(e, { kind: 'group', name, zone: zoneOfHeader(e, group.empty) }, true)
          }}
          onDrop={(e) => handleRailDrop(e, { kind: 'group', name, zone: zoneOfHeader(e, group.empty) }, true)}
        >
          <button
            type="button"
            className="vw-rail-gbtn"
            aria-expanded={group.empty ? undefined : !isCollapsed}
            aria-label={group.empty ? `分组 ${name}(空)` : `${isCollapsed ? '展开' : '折叠'}分组 ${name}`}
            title={group.empty ? '空分组:把剧拖进来,或在剧的菜单里选「移到分组…」' : undefined}
            onClick={() => !group.empty && toggleGroupCollapsed(name)}
          >
            {isCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
            {isCollapsed ? <Folder size={13} aria-hidden="true" /> : <FolderOpen size={13} aria-hidden="true" />}
            <span className="vw-rail-gname truncate">{name}</span>
            <span className="vw-rail-gcount">{members.length}</span>
            {group.empty ? (
              <span className="vw-rail-gagg">空 · 拖剧进来</span>
            ) : (
              doneSeconds > 0 && <span className="vw-rail-gagg">{formatDuration(doneSeconds)}</span>
            )}
          </button>
          {canReorder && !group.empty && (
            <button
              type="button"
              className="vw-rail-grip"
              aria-label={`拖动调整分组 ${name} 的位置`}
              title="拖动整个分组标题,或聚焦后按 ↑ ↓"
              onKeyDown={(e) => nudge(e, { kind: 'group', name })}
            />
          )}
          <button
            type="button"
            className="vw-rail-more"
            aria-label={`分组菜单 ${name}`}
            aria-haspopup="menu"
            title="更多操作(也可以右键)"
            onClick={(e) => openGroupMenu(e, group)}
          >
            ⋯
          </button>
        </div>
        {shown.length > 0 && (
          <div className="vw-rail-kids" role="list" aria-label={`分组 ${name} 里的剧`}>
            {shown.map((p) => renderProjectRow(p, true))}
          </div>
        )}
      </div>
    )
  }

  return (
    <aside
      className={`vw-rail ${collapsed ? 'vw-rail-collapsed' : ''} ${fileOver ? 'vw-rail-fileover' : ''}`}
      aria-label="剧栏"
      onDragEnter={(e) => {
        if (onDropProjectFile && carriesFiles(e)) {
          e.preventDefault()
          setFileOver(true)
        }
      }}
      onDragOver={(e) => {
        if (onDropProjectFile && carriesFiles(e)) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false)
      }}
      onDrop={(e) => {
        if (!onDropProjectFile || !carriesFiles(e)) return
        e.preventDefault()
        setFileOver(false)
        const p = droppedProjectFilePath(e)
        if (p) onDropProjectFile(p)
      }}
    >
      <div className="vw-rail-head">
        {!collapsed && <div className="vw-rail-title">SERIES · 剧</div>}
        <button
          type="button"
          className="vw-rail-iconbtn"
          aria-label={collapsed ? '展开剧栏' : '折叠剧栏'}
          title={collapsed ? '展开剧栏' : '折叠剧栏'}
          onClick={() => setRailCollapsed(!collapsed)}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      {!collapsed && (
        <div className="vw-rail-tools">
          <input
            className="vw-rail-search"
            placeholder="搜索剧"
            aria-label="搜索剧"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="vw-rail-addgroup"
            aria-label="新建分组"
            title="新建分组(把剧收进可折叠的文件夹)"
            onClick={() => setCreatingGroup(true)}
          >
            <FolderPlus size={14} aria-hidden="true" />
          </button>
          <button type="button" className="vw-rail-add" aria-label="新建剧" title="新建剧" onClick={handleAdd}>
            +
          </button>
        </div>
      )}
      <div
        className="vw-rail-list"
        role="list"
        onDragEnter={(e) => {
          // 源剧只剩一段时搬不走:既没有能放的行,也不露出「新建一部剧并移入」(放了只会白白多出一部空剧)
          if (carriesSegment(e) && canMoveSegmentOut) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragOver={(e) => {
          if (carriesSegment(e)) {
            // 行自己的处理器已经管过了(能放的亮、不能放的禁止并拦下冒泡);走到这里的要么是能放的行,
            // 要么是行外(空白 / 投放框)—— 行外没有行该亮着
            if (!(e.target as Element | null)?.closest?.('.vw-rail-row') && segmentTargetId !== null) setSegmentTargetId(null)
            if (canMoveSegmentOut) e.preventDefault()
            else e.dataTransfer.dropEffect = 'none'
          }
          // 列表自己(不是某一行)上空 = 行与行之外的空白:移出分组并排到最后
          else if (grouped && e.target === e.currentTarget) handleRailDragOver(e, { kind: 'tail' })
        }}
        onDrop={(e) => {
          if (grouped && e.target === e.currentTarget) handleRailDrop(e, { kind: 'tail' })
        }}
        onDragLeave={(e) => {
          // 只在真正离开列表时收起,子元素之间的 leave 不算
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOver(false)
            setDropMark(null)
            setSegmentTargetId(null)
          }
        }}
      >
        {dragOver && (
          <button
            type="button"
            className="vw-rail-drop"
            aria-label="放到这里:新建一部剧并移入"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const boardId = e.dataTransfer.getData(SEGMENT_DRAG_MIME)
              setDragOver(false)
              if (!boardId) return
              const id = addProject()
              moveBoardToProject(boardId, id)
            }}
          >
            ⊞ 放到这里:新建一部剧并移入
          </button>
        )}
        {grouped
          ? entries.map((entry) => (entry.kind === 'group' ? renderGroup(entry.group) : renderProjectRow(entry.item, false)))
          : flatRows.map((p) => renderProjectRow(p, false))}
        {grouped && hasGroups && (
          // 列表底部的一条空白:把剧拖到这里 = 移出分组并排到最后(全是分组时,这是唯一的「放回顶层」落点之一)
          <div
            className={['vw-rail-tail', dropMark?.kind === 'tail' && 'vw-rail-tail-on'].filter(Boolean).join(' ')}
            aria-hidden="true"
            onDragOver={(e) => handleRailDragOver(e, { kind: 'tail' })}
            onDrop={(e) => handleRailDrop(e, { kind: 'tail' })}
          />
        )}
      </div>
      {collapsed && onRequestTrash && (
        <button
          type="button"
          className="vw-rail-trash-mini"
          aria-label="回收站"
          title={trashCount > 0 ? `回收站(${trashCount})` : '回收站'}
          onClick={onRequestTrash}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      )}
      {!collapsed && (
        // 底部入口按剧栏宽度等分成一排(列数 = 按钮数)。导入/导出只在这里有一份 ——
        // 剧总览头部原来还有一份重复的,已删。
        <div className="vw-rail-foot" style={{ ['--vw-foot-cols' as string]: footCols }}>
          <button
            type="button"
            className="vw-ghost vw-rail-act"
            aria-label="导入工程"
            disabled={!onRequestImport}
            title={onRequestImport ? '导入 .catwb.json 工程文件(也可以直接拖到这里)' : '导入工程(当前环境不可用)'}
            onClick={onRequestImport}
          >
            <Upload size={15} aria-hidden="true" />
            导入
          </button>
          <button
            type="button"
            className="vw-ghost vw-rail-act"
            aria-label="导出当前剧"
            disabled={!onRequestExport}
            title={onRequestExport ? '把当前剧导出为 .catwb.json 工程文件' : '导出工程(当前环境不可用)'}
            onClick={onRequestExport}
          >
            <Download size={15} aria-hidden="true" />
            导出
          </button>
          {onRequestCloudBackup && (
            <button
              type="button"
              className="vw-ghost vw-rail-act"
              aria-label="云备份"
              title="把每部剧按账号备份到云端,换电脑后可恢复"
              onClick={onRequestCloudBackup}
            >
              {cloudTone && <span className={`vw-cloud-dot vw-cloud-dot-${cloudTone}`} aria-hidden="true" />}
              <Cloud size={15} aria-hidden="true" />
              云备份
            </button>
          )}
          {onRequestTrash && (
            <button
              type="button"
              className="vw-ghost vw-rail-act"
              aria-label="回收站"
              title={
                trashCount > 0
                  ? `回收站(${trashCount}):查看已删除的剧和分段,可恢复,或确认后彻底删除`
                  : '查看已删除的剧和分段:可恢复,或确认后彻底删除'
              }
              onClick={onRequestTrash}
            >
              {trashCount > 0 && (
                <span className="vw-rail-badge" aria-hidden="true">
                  {trashCount}
                </span>
              )}
              <Trash2 size={15} aria-hidden="true" />
              回收站
            </button>
          )}
        </div>
      )}
      {menu.node}
      <RenameDialog
        open={renamingInDialog !== null}
        title="重命名剧"
        initial={renamingInDialog?.name ?? ''}
        onCommit={(name) => (renamingInDialog ? renameProject(renamingInDialog.id, name) : false)}
        onClose={() => setRenamingInDialog(null)}
      />
      <RenameDialog
        open={renamingGroup !== null}
        title="重命名分组"
        initial={renamingGroup ?? ''}
        onCommit={(name) => (renamingGroup !== null ? renameGroup(renamingGroup, name) : false)}
        onClose={() => setRenamingGroup(null)}
      />
      <RenameDialog
        open={creatingGroup}
        title="新建分组"
        initial=""
        onCommit={(name) => {
          const r = createEmptyGroup(name)
          if (r.ok) return true
          useToastStore.getState().addToast({ message: r.reason, type: 'error', duration: 3500 })
          return false
        }}
        onClose={() => setCreatingGroup(false)}
      />
      <GroupPickDialog
        open={pickingGroupFor !== null}
        projectName={projects.find((p) => p.id === pickingGroupFor)?.name ?? ''}
        groups={listGroupNames(sorted, emptyGroups)}
        current={projects.find((p) => p.id === pickingGroupFor)?.group}
        onPick={(g) => (pickingGroupFor !== null ? assignProjectGroup(pickingGroupFor, g) : false)}
        onClose={() => setPickingGroupFor(null)}
      />
    </aside>
  )
}
