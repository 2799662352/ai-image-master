// 「云备份」:自动备份开关 + 当前状态 + 立即备份 + 云端清单(恢复为新剧 / 删除云端副本)。
//
// 恢复一律是「导入为新剧」(与「导入工程」同一条路:加固解析 → planImport → importProject),
// 不覆盖本机已有的剧 —— 用户在备份面板里点一下不该把手上的东西改掉。
// 删除云端副本不可撤销,走两步内联确认(同回收站)。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuthStore } from '../../stores/useAuthStore'
import { useToastStore } from '../../stores/useToastStore'
import type { WorkbenchBackupItem } from '../../../../types/workbenchBackup'
import { fetchBackupFile, type BackupPassResult } from '../../features/video-workbench/cloudBackup'
import { useCloudBackupStore } from '../../features/video-workbench/cloudBackupStore'
import { describeBackupError, describeBackupStatus } from '../../features/video-workbench/cloudBackupStatus'
import { planImport, uniqueProjectName } from '../../features/video-workbench/projectFile'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { relativeTime } from './ProjectRail'
import { cloudBackupApi } from './useCloudBackup'

/** 两步确认的自动复位时间(同回收站)。 */
const CONFIRM_MS = 3500

const TONE_CLASS = {
  ok: 'vw-dialog-ok',
  info: 'vw-dialog-note',
  warn: 'vw-dialog-warn',
  error: 'vw-dialog-error',
} as const

export interface CloudBackupDialogProps {
  open: boolean
  onClose: () => void
  /** 立即备份一轮(来自 `useWorkbenchCloudBackup`)。 */
  onBackupNow: () => Promise<BackupPassResult | null>
}

export function CloudBackupDialog({ open, onClose, onBackupNow }: CloudBackupDialogProps) {
  const enabled = useCloudBackupStore((s) => s.enabled)
  const pending = useCloudBackupStore((s) => s.pending)
  const running = useCloudBackupStore((s) => s.running)
  const last = useCloudBackupStore((s) => s.last)
  const lastAt = useCloudBackupStore((s) => s.lastAt)
  const lastError = useCloudBackupStore((s) => s.lastError)
  const setEnabled = useCloudBackupStore((s) => s.setEnabled)
  const authenticated = useAuthStore((s) => s.authenticated)
  const importProject = useVideoWorkbenchStore((s) => s.importProject)
  const addToast = useToastStore((s) => s.addToast)

  const api = cloudBackupApi()
  const [items, setItems] = useState<WorkbenchBackupItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const load = useCallback(async () => {
    if (!api || !authenticated) return
    const r = await api.list()
    if (!alive.current) return
    if (r.ok) {
      setItems([...r.data.items].sort((a, b) => b.serverUpdatedAt - a.serverUpdatedAt))
      setListError(null)
    } else {
      setListError(describeBackupError(r.code, r.message))
    }
    // api 每次渲染都是同一个桥对象,不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated])

  // 打开时、以及备份一轮跑完(lastAt 变)时刷新清单。
  useEffect(() => {
    if (!open) return
    setConfirming(null)
    setActionError(null)
    void load()
  }, [open, lastAt, load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const status = describeBackupStatus({
    available: !!api,
    authenticated,
    enabled,
    running,
    pending,
    last,
    lastError,
    ago: lastAt ? relativeTime(lastAt) : '',
  })

  const arm = (key: string): void => {
    setConfirming(key)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setConfirming(null), CONFIRM_MS)
  }

  const restore = async (item: WorkbenchBackupItem): Promise<void> => {
    if (!api) return
    setBusyId(item.dramaId)
    setActionError(null)
    const r = await fetchBackupFile(api, item.dramaId)
    if (!alive.current) return
    setBusyId(null)
    if (!r.ok) {
      setActionError(describeBackupError(r.code, r.message))
      return
    }
    const name = uniqueProjectName(
      r.file.project.name,
      useVideoWorkbenchStore.getState().projects.map((p) => p.name),
    )
    importProject(planImport(r.file), name, r.file.project.summary)
    addToast({
      type: 'success',
      message: `已从云端恢复「${name}」· ${r.summary.segments} 段 ${r.summary.cards} 镜`,
    })
    onClose()
  }

  const remove = async (item: WorkbenchBackupItem): Promise<void> => {
    if (!api) return
    setConfirming(null)
    setBusyId(item.dramaId)
    setActionError(null)
    const r = await api.remove(item.dramaId)
    if (!alive.current) return
    setBusyId(null)
    if (!r.ok) {
      setActionError(describeBackupError(r.code, r.message))
      return
    }
    addToast({ type: 'info', message: `已删除云端副本「${item.name}」` })
    void load()
  }

  const backupNow = async (): Promise<void> => {
    setActionError(null)
    await onBackupNow()
  }

  const usable = !!api && authenticated

  return createPortal(
    <div className="vw-palette-backdrop" onMouseDown={onClose}>
      <div
        className="vw-palette vw-dialog vw-dialog-trash"
        role="dialog"
        aria-label="云备份"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vw-dialog-title">云备份</div>
        <div className="vw-dialog-body vw-trash-body">
          <p className="vw-dialog-note">
            把每部剧(分段、镜头、提示词、云端素材的地址)按账号备份到云端;换电脑或清缓存后,登录同一账号即可在这里恢复。
            只备份工作台数据,不含任何密钥。
          </p>
          <p className={TONE_CLASS[status.tone]} role="status" aria-live="polite">
            {status.text}
          </p>
          <label className="vw-dialog-line flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!usable}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label="自动备份"
            />
            <span>自动备份(改动停手约 30 秒后,最迟 5 分钟内)</span>
          </label>
          {actionError && (
            <p className="vw-dialog-error" role="alert">
              {actionError}
            </p>
          )}
          {usable && listError && (
            <p className="vw-dialog-error" role="alert">
              读取云端清单失败:{listError}
            </p>
          )}
          {usable && !listError && items !== null && items.length === 0 && (
            <div className="vw-palette-empty" role="status">
              云端还没有备份
            </div>
          )}
          {usable && items !== null && items.length > 0 && (
            <ul className="vw-trash-list" aria-label="云端备份">
              {items.map((item) => {
                const armed = confirming === item.dramaId
                const busy = busyId === item.dramaId
                return (
                  <li key={item.dramaId} className="vw-trash-row">
                    <div className="vw-trash-meta">
                      <div className="vw-trash-name">
                        <span className="truncate" title={item.name}>{item.name}</span>
                      </div>
                      <div className="vw-trash-sub">
                        {item.boards} 段 · {item.cards} 镜 · 备份于 {relativeTime(item.serverUpdatedAt) || '刚刚'}
                        {item.versions > 1 ? ` · 保留 ${item.versions} 份历史` : ''}
                      </div>
                    </div>
                    <div className="vw-trash-actions">
                      <button
                        type="button"
                        className="vw-ghost"
                        disabled={busy}
                        aria-label={`恢复「${item.name}」为新剧`}
                        title="把云端这份导入为一部新剧(不会覆盖本机已有的剧)"
                        onClick={() => void restore(item)}
                      >
                        恢复为新剧
                      </button>
                      <button
                        type="button"
                        className={armed ? 'vw-danger vw-danger-armed' : 'vw-danger'}
                        disabled={busy}
                        aria-label={armed ? `确认删除云端副本「${item.name}」` : `删除云端副本「${item.name}」`}
                        title={
                          armed
                            ? '再点一次:永久删除云端这份(含历史版本)。本机的剧不受影响;若它还在本机,重启或有改动后会再次备份'
                            : '删除云端副本(需再确认一次)'
                        }
                        onClick={() => {
                          if (!armed) {
                            arm(item.dramaId)
                            return
                          }
                          void remove(item)
                        }}
                      >
                        {armed ? '确认删除' : '删除云端副本'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="vw-dialog-actions">
          <button
            type="button"
            className="vw-ghost"
            disabled={!usable || running}
            onClick={() => void backupNow()}
          >
            {running ? '正在备份…' : '立即备份'}
          </button>
          <span className="flex-1" />
          <button type="button" className="vw-primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
