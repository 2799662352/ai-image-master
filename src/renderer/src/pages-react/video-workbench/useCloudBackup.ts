// 把云备份接到工作台页:store 变了就通知调度器,调度器按节奏跑一轮,结果写进状态 store。
//
// 只在 Electron 里工作(要主进程代发请求并带平台账号的 JWT);浏览器宿主没有桥 → 整个 hook 空转。
// 账号(用户名)变了 → 同步状态整个重建 —— 云端指纹是按账号取的,不能带着上个账号的对账结果。

import { useEffect, useRef } from 'react'
import { useAuthStore } from '../../stores/useAuthStore'
import {
  createBackupSyncState,
  runBackupPass,
  type BackupPassResult,
  type CloudBackupBridge,
} from '../../features/video-workbench/cloudBackup'
import { createBackupScheduler, type BackupScheduler } from '../../features/video-workbench/cloudBackupScheduler'
import { useCloudBackupStore } from '../../features/video-workbench/cloudBackupStore'
import { describeBackupStatus } from '../../features/video-workbench/cloudBackupStatus'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

const APP_NAME = 'CATIMATION-Cyberpunk Master'

interface BackupBridge {
  getAppVersion?: () => Promise<string>
  videoWorkbench?: { cloudBackup?: CloudBackupBridge }
}

function bridge(): BackupBridge | undefined {
  return (window as Window & { electronAPI?: BackupBridge }).electronAPI
}

/** 云备份通道;非 Electron 宿主 = undefined。 */
export function cloudBackupApi(): CloudBackupBridge | undefined {
  return bridge()?.videoWorkbench?.cloudBackup
}

export type CloudBackupTone = 'ok' | 'busy' | 'warn' | 'off'

/** 剧栏「云备份」按钮上的小圆点:绿 = 已备份,黄 = 进行中 / 有待传,红 = 有问题,灰 = 关着 / 没登录。非 Electron = null。 */
export function useCloudBackupTone(): CloudBackupTone | null {
  const authenticated = useAuthStore((s) => s.authenticated)
  const enabled = useCloudBackupStore((s) => s.enabled)
  const pending = useCloudBackupStore((s) => s.pending)
  const running = useCloudBackupStore((s) => s.running)
  const last = useCloudBackupStore((s) => s.last)
  const lastError = useCloudBackupStore((s) => s.lastError)
  if (!cloudBackupApi()) return null
  if (!authenticated || !enabled) return 'off'
  if (running || pending) return 'busy'
  const line = describeBackupStatus({
    available: true, authenticated, enabled, running, pending, last, lastError, ago: '',
  })
  if (line.tone === 'ok') return 'ok'
  return line.tone === 'warn' || line.tone === 'error' ? 'warn' : 'off'
}

export function useWorkbenchCloudBackup(): { runNow: () => Promise<BackupPassResult | null> } {
  const authenticated = useAuthStore((s) => s.authenticated)
  const username = useAuthStore((s) => s.username)
  const schedulerRef = useRef<BackupScheduler | null>(null)
  const syncRef = useRef(createBackupSyncState())
  const appRef = useRef({ name: APP_NAME, version: '' })
  const authedRef = useRef(authenticated)
  authedRef.current = authenticated

  useEffect(() => {
    const api = cloudBackupApi()
    if (!api) return
    void bridge()
      ?.getAppVersion?.()
      .then((v) => {
        appRef.current = { name: APP_NAME, version: v ?? '' }
      })
      .catch(() => undefined)

    const status = useCloudBackupStore.getState
    const scheduler = createBackupScheduler({
      run: () => {
        const s = useVideoWorkbenchStore.getState()
        return runBackupPass({
          api,
          snapshot: { projects: s.projects, boards: s.boards, cards: s.cards },
          state: syncRef.current,
          app: appRef.current,
        })
      },
      isEnabled: () => status().enabled,
      canRun: () => authedRef.current,
      onStart: () => status().markStart(),
      onPending: (p) => status().setPending(p),
      onResult: (r) => status().markResult(r),
      onError: (e) => status().markError(e),
    })
    schedulerRef.current = scheduler

    const unsubscribe = useVideoWorkbenchStore.subscribe((s, prev) => {
      if (!s.hydrated) return
      if (s.projects !== prev.projects || s.boards !== prev.boards || s.cards !== prev.cards) scheduler.notify()
    })
    // 进页面(或刚恢复完)就排一轮:内容没变的话这一轮只是一次 list + 本地指纹比对。
    void useVideoWorkbenchStore.getState().ensureHydrated().then(() => scheduler.notify())

    return () => {
      unsubscribe()
      scheduler.flush()
      scheduler.dispose()
      schedulerRef.current = null
    }
  }, [])

  // 登录态 / 账号变化:丢掉旧账号的对账结果,已登录就重新排一轮。
  useEffect(() => {
    syncRef.current = createBackupSyncState()
    useCloudBackupStore.getState().resetStatus()
    const scheduler = schedulerRef.current
    if (!scheduler) return
    scheduler.reset()
    if (authenticated) scheduler.notify()
  }, [authenticated, username])

  return {
    runNow: async () => {
      const scheduler = schedulerRef.current
      return scheduler ? scheduler.runNow() : null
    },
  }
}
