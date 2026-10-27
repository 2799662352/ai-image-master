// 左侧「剧栏」:所有剧的常驻列表。行 = 封面 · 名 · 段/镜/花费 · 时间 · 三色条;
// 黄点 = 有卡生成中,红点 = 有失败。当前剧黄色左条。可折叠到 48px 只留封面。
// 视觉只用 workbench.css 的 .vw-rail-* 类与既有 token。
//
// 导入/导出两颗按钮本期只占位(disabled + title「即将推出」),真正的流程在
// 「工程文件导入/导出」那份计划里接进来 —— 不做假实现。

import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { formatDuration, summarizeProject } from '../../features/video-workbench/projectStats'
import { pinnedFirstBy } from '../../features/video-workbench/projects'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { isProjectFileName } from '../../features/video-workbench/importProject'
import { useContextMenu } from './ContextMenu'
import { CoverImage } from './CoverImage'
import { SEGMENT_DRAG_MIME } from './ProjectOverview'
import { RenameDialog } from './RenameDialog'
import { projectMenuItems } from './workbenchMenus'

function carriesSegment(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes(SEGMENT_DRAG_MIME)
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

export function ProjectRail({ onRequestImport, onRequestExport, onRequestTrash, onDropProjectFile }: ProjectRailProps) {
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editingId) nameInputRef.current?.focus()
  }, [editingId])

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
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
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
        {rows.map(({ project, stats }) => {
          const isActive = project.id === activeProjectId
          const t = stats.totals
          const cost = formatCostParts(t.cost.usd, t.cost.cny)
          const pinned = pinnedProjectIds.includes(project.id)
          return (
            <div
              key={project.id}
              role="listitem"
              className={`vw-rail-row ${isActive ? 'vw-rail-row-active' : ''}`}
              onContextMenu={(e) => openMenu(e, project.id, project.name)}
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
        <div className="vw-rail-foot">
          <button
            type="button"
            className="vw-ghost"
            disabled={!onRequestImport}
            title={onRequestImport ? '导入 .catwb.json 工程文件(也可以直接拖到这里)' : '导入工程(当前环境不可用)'}
            onClick={onRequestImport}
          >
            导入工程
          </button>
          <button
            type="button"
            className="vw-ghost"
            disabled={!onRequestExport}
            title={onRequestExport ? '把当前剧导出为 .catwb.json 工程文件' : '导出工程(当前环境不可用)'}
            onClick={onRequestExport}
          >
            导出当前剧
          </button>
          {onRequestTrash && (
            <button
              type="button"
              className="vw-ghost vw-rail-trash"
              aria-label="回收站"
              title="查看已删除的剧和分段:可恢复,或确认后彻底删除"
              onClick={onRequestTrash}
            >
              <Trash2 size={12} aria-hidden="true" />
              回收站{trashCount > 0 ? ` (${trashCount})` : ''}
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
