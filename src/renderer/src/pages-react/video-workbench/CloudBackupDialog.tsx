// 「云备份」:自动备份开关 + 当前状态 + 立即备份 + 云端清单(恢复为新剧 / 删除云端副本)
// + 「云端已删除」的冲突(继续备份)+ 云端回收站(取回为新剧 / 彻底删除)。
//
// 恢复一律是「导入为新剧」(与「导入工程」同一条路:加固解析 → planImport → importProject),
// 不覆盖本机已有的剧 —— 用户在备份面板里点一下不该把手上的东西改掉。
// 「删除云端副本」= 移入云端回收站(最长保留 60 天,期间可取回);只有回收站里的
// 「彻底删除」才不可撤销。两者都走两步内联确认(同本地回收站)。
// 别的设备删掉、本机还有的剧,备份会停在冲突上等用户点「继续备份」—— 不会被静默复活。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuthStore } from '../../stores/useAuthStore'
import { useToastStore } from '../../stores/useToastStore'
import type { WorkbenchBackupItem, WorkbenchBackupTrashItem } from '../../../../types/workbenchBackup'
import {
  fetchBackupFile,
  fetchTrashedBackupFile,
  type BackupPassResult,
  type FetchBackupResult,
  type ReviveBackupResult,
  type TrashConflict,
} from '../../features/video-workbench/cloudBackup'
import { useCloudBackupStore } from '../../features/video-workbench/cloudBackupStore'
import { describeBackupError, describeBackupStatus } from '../../features/video-workbench/cloudBackupStatus'
import { planImport, uniqueProjectName } from '../../features/video-workbench/projectFile'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { daysUntil } from '../../features/video-workbench/trashRetention'
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
  /** 对云端已删除的剧「继续备份」(来自 `useWorkbenchCloudBackup`)。不传 = 不显示这个按钮。 */
  onRevive?: (dramaId: string) => Promise<ReviveBackupResult | null>
}

export function CloudBackupDialog({ open, onClose, onBackupNow, onRevive }: CloudBackupDialogProps) {
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
  const [trashItems, setTrashItems] = useState<WorkbenchBackupTrashItem[]>([])
  const [trashError, setTrashError] = useState<string | null>(null)
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

  // 云端回收站。旧后端 / 没有回收站接口时(NOT_FOUND)当作空,不报错;其它失败才给原因。
  const loadTrash = useCallback(async () => {
    if (!api || !authenticated || typeof api.trashList !== 'function') return
    const r = await api.trashList()
    if (!alive.current) return
    if (r.ok) {
      setTrashItems([...r.data.items].sort((a, b) => b.deletedAt - a.deletedAt))
      setTrashError(null)
    } else if (r.code === 'NOT_FOUND') {
      setTrashItems([])
      setTrashError(null)
    } else {
      setTrashError(describeBackupError(r.code, r.message))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated])

  // 打开时、以及备份一轮跑完(lastAt 变)时刷新清单。
  useEffect(() => {
    if (!open) return
    setConfirming(null)
    setActionError(null)
    void load()
    void loadTrash()
  }, [open, lastAt, load, loadTrash])

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

  /** 取回的云端文件 → 导入为新剧(活副本和回收站副本共用)。成功关面板,失败给原因。 */
  const adopt = (r: FetchBackupResult, verb: string): void => {
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
      message: `已从${verb}恢复「${name}」· ${r.summary.segments} 段 ${r.summary.cards} 镜`,
    })
    onClose()
  }

  const restore = async (item: WorkbenchBackupItem): Promise<void> => {
    if (!api) return
    setBusyId(item.dramaId)
    setActionError(null)
    const r = await fetchBackupFile(api, item.dramaId)
    if (!alive.current) return
    setBusyId(null)
    adopt(r, '云端')
  }

  const restoreTrashed = async (item: WorkbenchBackupTrashItem): Promise<void> => {
    if (!api) return
    setBusyId(item.trashId)
    setActionError(null)
    const r = await fetchTrashedBackupFile(api, item.trashId)
    if (!alive.current) return
    setBusyId(null)
    adopt(r, '云端回收站')
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
    addToast({
      type: 'info',
      message: r.data.trashed
        ? `已移入云端回收站「${item.name}」,最长保留 60 天,期间可以取回`
        : `已删除云端副本「${item.name}」`,
    })
    void load()
    void loadTrash()
  }

  const purgeTrashed = async (item: WorkbenchBackupTrashItem): Promise<void> => {
    if (!api) return
    setConfirming(null)
    setBusyId(item.trashId)
    setActionError(null)
    const r = await api.trashPurge(item.trashId)
    if (!alive.current) return
    setBusyId(null)
    if (!r.ok) {
      setActionError(describeBackupError(r.code, r.message))
      return
    }
    addToast({ type: 'info', message: `已彻底删除云端回收站里的「${item.name}」` })
    void loadTrash()
  }

  const revive = async (c: TrashConflict): Promise<void> => {
    if (!onRevive) return
    setBusyId(c.dramaId)
    setActionError(null)
    const r = await onRevive(c.dramaId)
    if (!alive.current) return
    setBusyId(null)
    if (!r) return
    if (!r.ok) {
      setActionError(describeBackupError(r.code, r.message))
      return
    }
    addToast({ type: 'success', message: `已继续备份「${c.name}」` })
    void load()
    void loadTrash()
  }

  const backupNow = async (): Promise<void> => {
    setActionError(null)
    await onBackupNow()
  }

  const usable = !!api && authenticated
  const conflicts = last?.trashConflicts ?? []

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
          {usable && onRevive && conflicts.length > 0 && (
            <>
              <p className="vw-dialog-warn">
                下面这些剧在云端已被删除(可能是你在别的设备上删的),本机还留着,所以没有继续备份。想保留就点「继续备份」;
                不想保留就在本机把它删掉。
              </p>
              <ul className="vw-trash-list" aria-label="云端已删除的剧">
                {conflicts.map((c) => (
                  <li key={c.dramaId} className="vw-trash-row">
                    <div className="vw-trash-meta">
                      <div className="vw-trash-name">
                        <span className="truncate" title={c.name}>{c.name}</span>
                      </div>
                      <div className="vw-trash-sub">
                        {c.deviceName ? `${c.deviceName} ` : ''}删除于 {relativeTime(c.deletedAt) || '刚刚'}
                        {' · '}云端还剩 {daysUntil(c.purgeAfter, Date.now())} 天
                      </div>
                    </div>
                    <div className="vw-trash-actions">
                      <button
                        type="button"
                        className="vw-ghost"
                        disabled={busyId === c.dramaId}
                        aria-label={`继续备份「${c.name}」`}
                        title="重新在云端建立这部剧的备份(以本机的内容为准)"
                        onClick={() => void revive(c)}
                      >
                        继续备份
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
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
                            ? '再点一次:把云端这份(含历史版本)移入云端回收站,最长保留 60 天,期间可以取回。本机的剧不受影响;若它还在本机,重启或有改动后会再次备份'
                            : '删除云端副本(需再确认一次;会先放进云端回收站)'
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
          {usable && trashError && (
            <p className="vw-dialog-error" role="alert">
              读取云端回收站失败:{trashError}
            </p>
          )}
          {usable && trashItems.length > 0 && (
            <>
              <p className="vw-dialog-note">
                云端回收站:删掉的备份先放在这里,最长保留 60 天(本机已经彻底删除的剧,只留 30 天)。期间可以取回为新剧。
              </p>
              <ul className="vw-trash-list" aria-label="云端回收站">
                {trashItems.map((item) => {
                  const armed = confirming === `trash:${item.trashId}`
                  const busy = busyId === item.trashId
                  return (
                    <li key={item.trashId} className="vw-trash-row">
                      <div className="vw-trash-meta">
                        <div className="vw-trash-name">
                          <span className="truncate" title={item.name}>{item.name}</span>
                        </div>
                        <div className="vw-trash-sub">
                          {item.boards} 段 · {item.cards} 镜 · {item.deletedBy ? `${item.deletedBy} ` : ''}删除于{' '}
                          {relativeTime(item.deletedAt) || '刚刚'} · 还剩 {daysUntil(item.purgeAfter, Date.now())} 天
                        </div>
                      </div>
                      <div className="vw-trash-actions">
                        <button
                          type="button"
                          className="vw-ghost"
                          disabled={busy}
                          aria-label={`取回「${item.name}」为新剧`}
                          title="把云端回收站里这份导入为一部新剧(不会覆盖本机已有的剧)"
                          onClick={() => void restoreTrashed(item)}
                        >
                          取回为新剧
                        </button>
                        <button
                          type="button"
                          className={armed ? 'vw-danger vw-danger-armed' : 'vw-danger'}
                          disabled={busy}
                          aria-label={
                            armed
                              ? `确认彻底删除云端回收站里的「${item.name}」`
                              : `彻底删除云端回收站里的「${item.name}」`
                          }
                          title={armed ? '再点一次:永久删除,无法找回' : '永久删除(需再确认一次)'}
                          onClick={() => {
                            if (!armed) {
                              arm(`trash:${item.trashId}`)
                              return
                            }
                            void purgeTrashed(item)
                          }}
                        >
                          {armed ? '确认彻底删除' : '彻底删除'}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
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
