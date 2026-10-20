// 回收站:被删的剧 / 分段(连同卡片)都在这里,可以恢复,或二次确认后彻底删除。
// 彻底删除不可撤销,所以用两步内联确认(同 BoardTabs 之前的做法,避开 window.confirm);
// 恢复被拒(例如分段所属的剧也在回收站里)时原因显示在列表上方。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { trashEntryName, type WorkbenchTrashEntry } from '../../features/video-workbench/trash'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { useToastStore } from '../../stores/useToastStore'
import { relativeTime } from './ProjectRail'

/** 两步确认的自动复位时间:3.5 秒内不点第二下就退回原状。 */
const CONFIRM_MS = 3500

function describe(entry: WorkbenchTrashEntry, homeName: string): string {
  const cards = entry.cards.length
  if (entry.kind === 'project') return `${entry.boards.length} 段 · ${cards} 镜`
  return `${cards} 镜${homeName ? ` · 来自剧「${homeName}」` : ''}`
}

export function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trash = useVideoWorkbenchStore((s) => s.trash)
  const projects = useVideoWorkbenchStore((s) => s.projects)
  const restoreFromTrash = useVideoWorkbenchStore((s) => s.restoreFromTrash)
  const purgeFromTrash = useVideoWorkbenchStore((s) => s.purgeFromTrash)
  const emptyTrash = useVideoWorkbenchStore((s) => s.emptyTrash)
  const addToast = useToastStore((s) => s.addToast)

  /** 正在二次确认的对象:某一项的 id,或 'all'(清空)。 */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) {
      setConfirming(null)
      setError(null)
    }
  }, [open])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const arm = (key: string): void => {
    setConfirming(key)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setConfirming(null), CONFIRM_MS)
  }

  const homeOf = (entry: WorkbenchTrashEntry): string => {
    if (entry.kind !== 'board') return ''
    return (
      projects.find((p) => p.id === entry.projectId)?.name
      ?? trash.find((e) => e.kind === 'project' && e.id === entry.projectId)?.project?.name
      ?? ''
    )
  }

  const restore = (entry: WorkbenchTrashEntry): void => {
    const r = restoreFromTrash(entry.id)
    if (!r.ok) {
      setError(r.reason ?? '恢复失败')
      return
    }
    setError(null)
    addToast({ message: `已恢复${entry.kind === 'project' ? '剧' : '分段'}「${trashEntryName(entry)}」`, type: 'success' })
  }

  return createPortal(
    <div className="vw-palette-backdrop" onMouseDown={onClose}>
      <div
        className="vw-palette vw-dialog vw-dialog-trash"
        role="dialog"
        aria-label="回收站"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vw-dialog-title">回收站</div>
        <div className="vw-dialog-body vw-trash-body">
          <p className="vw-dialog-note">
            删除的剧和分段会先放在这里,连同里面的全部镜头。恢复后原样回来;彻底删除后无法找回。
          </p>
          {error && (
            <p className="vw-dialog-error" role="alert">
              {error}
            </p>
          )}
          {trash.length === 0 ? (
            <div className="vw-palette-empty" role="status">
              回收站是空的
            </div>
          ) : (
            <ul className="vw-trash-list" aria-label="回收站内容">
              {trash.map((entry) => {
                const name = trashEntryName(entry)
                const armed = confirming === entry.id
                return (
                  <li key={entry.id} className="vw-trash-row">
                    <div className="vw-trash-meta">
                      <div className="vw-trash-name">
                        <span className="vw-chip">{entry.kind === 'project' ? '剧' : '分段'}</span>
                        <span className="truncate" title={name}>{name}</span>
                      </div>
                      <div className="vw-trash-sub">
                        {describe(entry, homeOf(entry))} · 删除于 {relativeTime(entry.deletedAt) || '刚刚'}
                      </div>
                    </div>
                    <div className="vw-trash-actions">
                      <button
                        type="button"
                        className="vw-ghost"
                        aria-label={`恢复「${name}」`}
                        onClick={() => restore(entry)}
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        className={armed ? 'vw-danger vw-danger-armed' : 'vw-danger'}
                        aria-label={armed ? `确认彻底删除「${name}」` : `彻底删除「${name}」`}
                        title={armed ? '再点一次:永久删除,无法找回' : '永久删除(需再确认一次)'}
                        onClick={() => {
                          if (!armed) {
                            arm(entry.id)
                            return
                          }
                          setConfirming(null)
                          setError(null)
                          purgeFromTrash(entry.id)
                        }}
                      >
                        {armed ? '确认彻底删除' : '彻底删除'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="vw-dialog-actions">
          {trash.length > 0 && (
            <button
              type="button"
              className={confirming === 'all' ? 'vw-danger vw-danger-armed' : 'vw-danger'}
              aria-label={confirming === 'all' ? '确认清空回收站' : '清空回收站'}
              title={confirming === 'all' ? '再点一次:全部永久删除,无法找回' : '全部永久删除(需再确认一次)'}
              onClick={() => {
                if (confirming !== 'all') {
                  arm('all')
                  return
                }
                setConfirming(null)
                setError(null)
                const n = emptyTrash()
                addToast({ message: `已清空回收站(${n} 项)`, type: 'info' })
              }}
            >
              {confirming === 'all' ? `确认清空(${trash.length} 项)` : '清空回收站'}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className="vw-primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
