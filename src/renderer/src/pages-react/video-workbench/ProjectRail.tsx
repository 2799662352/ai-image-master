// 左侧「剧栏」:所有剧的常驻列表。行 = 封面 · 名 · 段/镜/花费 · 时间 · 三色条;
// 黄点 = 有卡生成中,红点 = 有失败。当前剧黄色左条。可折叠到 48px 只留封面。
// 视觉只用 workbench.css 的 .vw-rail-* 类与既有 token。
//
// 底部一行等分的四个入口:导入工程 / 导出当前剧 / 云备份 / 回收站(后两个由页面传回调才出现)。
// 导入、导出工程的入口只在这里有一份,剧总览头部不再重复放。

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Cloud, Download, Trash2, Upload } from 'lucide-react'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { formatDuration, summarizeProject } from '../../features/video-workbench/projectStats'
import { pinnedFirstBy, planReorder, type DropPlace } from '../../features/video-workbench/projects'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { isProjectFileName } from '../../features/video-workbench/importProject'
import { useContextMenu } from './ContextMenu'
import { CoverImage } from './CoverImage'
import { SEGMENT_DRAG_MIME } from './ProjectOverview'
import { RenameDialog } from './RenameDialog'
import { useCloudBackupTone } from './useCloudBackup'
import { projectMenuItems } from './workbenchMenus'

function carriesSegment(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes(SEGMENT_DRAG_MIME)
}

/** 拖剧行左侧的把手调整剧的顺序时,dataTransfer 里放剧 id 用的类型(和分段卡的 SEGMENT_DRAG_MIME 互不相干)。 */
export const PROJECT_DRAG_MIME = 'application/x-catimation-project'

function carriesProject(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes(PROJECT_DRAG_MIME)
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
  const reorderProjects = useVideoWorkbenchStore((s) => s.reorderProjects)
  const pinnedProjectIds = useVideoWorkbenchStore((s) => s.pinnedProjectIds)
  const trashCount = useVideoWorkbenchStore((s) => s.trash.length)
  const menu = useContextMenu()
  /** 折叠态剧栏没有就地输入框,右键「重命名」改走小对话框。 */
  const [renamingInDialog, setRenamingInDialog] = useState<{ id: string; name: string } | null>(null)

  const [query, setQuery] = useState('')
  /** 有分段卡正拖在剧栏上空:顶部露出「新建一部剧并移入」的投放框。 */
  const [dragOver, setDragOver] = useState(false)
  /** 有系统文件正拖在剧栏上空(工程文件导入)。 */
  const [fileOver, setFileOver] = useState(false)
  // 拖剧行把手调整顺序:真正被拖的 id 放 ref(dragover / drop 同步要读),
  // 变暗只是视觉,延后一拍再 setState(见 startProjectDrag)。
  const draggingProjectRef = useRef<string | null>(null)
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null)
  const dimTimerRef = useRef<number | null>(null)
  /** 插入线:画在哪一行的上沿 / 下沿。 */
  const [dropMark, setDropMark] = useState<{ id: string; place: DropPlace } | null>(null)
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

  // 底部入口的列数 = 实际渲染的按钮数(云备份只在桌面端有、回收站要页面接了才有)
  const footCols = 2 + (onRequestCloudBackup ? 1 : 0) + (onRequestTrash ? 1 : 0)

  const needle = query.trim().toLowerCase()
  const rows = pinnedFirstBy(
    projects
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ project: p, stats: summarizeProject(p.id, boards, cards) }))
      .filter(({ project }) => !needle || project.name.toLowerCase().includes(needle)),
    pinnedProjectIds,
    (row) => row.project.id,
  )

  // 搜索过滤时列表只是子集、折叠态没有把手:这两种情况不开放排序(子集里的「前后」没有明确含义)。
  const canReorder = !collapsed && !needle
  /** 当前存储顺序(不含置顶重排)。拖拽排序在它上面挪,见 planReorder。 */
  const orderedIds = projects
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id)

  const endProjectDrag = () => {
    draggingProjectRef.current = null
    if (dimTimerRef.current !== null) {
      window.clearTimeout(dimTimerRef.current)
      dimTimerRef.current = null
    }
    setDraggingProjectId(null)
    setDropMark(null)
  }
  const startProjectDrag = (e: DragEvent<HTMLButtonElement>, id: string) => {
    e.dataTransfer.setData(PROJECT_DRAG_MIME, id)
    e.dataTransfer.effectAllowed = 'move'
    // 拖影用整行,不是那个 10px 的把手
    const row = e.currentTarget.closest<HTMLElement>('.vw-rail-row')
    if (row && typeof e.dataTransfer.setDragImage === 'function') {
      const r = row.getBoundingClientRect()
      e.dataTransfer.setDragImage(row, e.clientX - r.left, e.clientY - r.top)
    }
    draggingProjectRef.current = id
    // 浏览器在 dragstart 处理完之后才截拖影;React 会在处理器返回时同步刷 DOM,
    // 若此刻就把原行变暗,拖影也是暗的。延后一拍。
    dimTimerRef.current = window.setTimeout(() => {
      dimTimerRef.current = null
      if (draggingProjectRef.current === id) setDraggingProjectId(id)
    }, 0)
  }
  const placeOf = (e: DragEvent<HTMLElement>): DropPlace => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
  }
  const handleProjectDragOver = (e: DragEvent<HTMLElement>, targetId: string) => {
    const dragId = draggingProjectRef.current
    if (!dragId || !carriesProject(e)) return
    const place = placeOf(e)
    if (!planReorder(orderedIds, pinnedProjectIds, dragId, targetId, place)) {
      // 不能放这里(自己 / 已相邻 / 跨置顶分组):不画线,不 preventDefault → 光标显示禁止
      e.dataTransfer.dropEffect = 'none'
      if (dropMark) setDropMark(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropMark?.id !== targetId || dropMark.place !== place) setDropMark({ id: targetId, place })
  }
  const handleProjectDrop = (e: DragEvent<HTMLElement>, targetId: string) => {
    const dragId = draggingProjectRef.current
    if (!dragId || !carriesProject(e)) return
    e.preventDefault()
    const next = planReorder(orderedIds, pinnedProjectIds, dragId, targetId, placeOf(e))
    endProjectDrag()
    if (next) reorderProjects(next)
  }
  /** 把手获得焦点时 ↑ ↓ 挪一格(不用鼠标也能排序)。 */
  const nudgeProject = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const up = e.key === 'ArrowUp'
    const neighbour = rows[index + (up ? -1 : 1)]
    if (!neighbour) return
    const next = planReorder(
      orderedIds,
      pinnedProjectIds,
      rows[index].project.id,
      neighbour.project.id,
      up ? 'before' : 'after',
    )
    // 行按 key 复用、只是换位:React 提交后会把焦点还给原来聚焦的元素,所以可以连按 ↑ ↓ 一路挪。
    if (next) reorderProjects(next)
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
      }),
    )
  const commitRename = () => {
    if (editingId) renameProject(editingId, draft)
    setEditingId(null)
  }
  // 新建零表单:建完立刻进入改名,Esc 就保留默认名。
  const handleAdd = () => {
    const id = addProject()
    beginRename(id, useVideoWorkbenchStore.getState().projects.find((p) => p.id === id)?.name ?? '')
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
          <button type="button" className="vw-rail-add" aria-label="新建剧" title="新建剧" onClick={handleAdd}>
            +
          </button>
        </div>
      )}
      <div
        className="vw-rail-list"
        role="list"
        onDragEnter={(e) => {
          if (carriesSegment(e)) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragOver={(e) => {
          if (carriesSegment(e)) e.preventDefault()
        }}
        onDragLeave={(e) => {
          // 只在真正离开列表时收起,子元素之间的 leave 不算
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOver(false)
            setDropMark(null)
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
        {rows.map(({ project, stats }, index) => {
          const isActive = project.id === activeProjectId
          const t = stats.totals
          const cost = formatCostParts(t.cost.usd, t.cost.cny)
          const pinned = pinnedProjectIds.includes(project.id)
          const mark = dropMark?.id === project.id ? dropMark.place : null
          return (
            <div
              key={project.id}
              role="listitem"
              className={[
                'vw-rail-row',
                isActive && 'vw-rail-row-active',
                draggingProjectId === project.id && 'vw-rail-row-dragging',
                mark === 'before' && 'vw-rail-drop-before',
                mark === 'after' && 'vw-rail-drop-after',
              ]
                .filter(Boolean)
                .join(' ')}
              onContextMenu={(e) => openMenu(e, project.id, project.name)}
              onDragOver={(e) => handleProjectDragOver(e, project.id)}
              onDrop={(e) => handleProjectDrop(e, project.id)}
            >
              <button
                type="button"
                className="vw-rail-rowbtn"
                aria-label={`切换到剧 ${project.name}`}
                aria-current={isActive ? 'true' : undefined}
                title={collapsed ? `${project.name}${pinned ? '(已置顶)' : ''}` : undefined}
                onClick={() => switchProject(project.id)}
                onDoubleClick={() => !collapsed && beginRename(project.id, project.name)}
                onDragOver={(e) => {
                  if (carriesSegment(e)) e.preventDefault()
                }}
                onDrop={(e) => {
                  const boardId = e.dataTransfer.getData(SEGMENT_DRAG_MIME)
                  if (!boardId) return
                  e.preventDefault()
                  setDragOver(false)
                  moveBoardToProject(boardId, project.id)
                }}
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
              {/* 左侧把手:拖它调整剧的顺序(整行不可拖,免得和点击 / 双击改名 / 分段投放抢手势) */}
              {canReorder && (
                <button
                  type="button"
                  className="vw-rail-grip"
                  draggable
                  aria-label={`拖动调整 ${project.name} 的位置`}
                  title="拖动调整顺序,或聚焦后按 ↑ ↓;置顶的剧始终排在最上面"
                  onDragStart={(e) => startProjectDrag(e, project.id)}
                  onDragEnd={endProjectDrag}
                  onKeyDown={(e) => nudgeProject(e, index)}
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
        })}
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
    </aside>
  )
}
