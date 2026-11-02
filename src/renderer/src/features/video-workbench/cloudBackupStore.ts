// 云备份的界面状态:开关(持久化)+ 最近一轮结果。只给界面读,不参与备份逻辑。

import { create } from 'zustand'
import type { BackupPassResult } from './cloudBackup'

/** localStorage 键。缺省(从没设过)= 开;只有显式存 '0' 才是关。 */
export const CLOUD_BACKUP_ENABLED_KEY = 'vw-cloud-backup-enabled'

export function readCloudBackupEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(CLOUD_BACKUP_ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

function writeCloudBackupEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(CLOUD_BACKUP_ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    // localStorage 不可用时仅本次会话生效
  }
}

export interface CloudBackupStoreState {
  enabled: boolean
  /** 有改动在防抖等待中。 */
  pending: boolean
  running: boolean
  /** 最近一轮跑完的时间与结果;从没跑过 = null。 */
  lastAt: number | null
  last: BackupPassResult | null
  /** 最近一轮抛了异常(不该发生,留给界面兜底显示)。 */
  lastError: string | null
  setEnabled: (enabled: boolean) => void
  setPending: (pending: boolean) => void
  markStart: () => void
  markResult: (result: BackupPassResult, at?: number) => void
  markError: (error: unknown) => void
  resetStatus: () => void
}

export const useCloudBackupStore = create<CloudBackupStoreState>((set) => ({
  enabled: readCloudBackupEnabled(),
  pending: false,
  running: false,
  lastAt: null,
  last: null,
  lastError: null,
  setEnabled: (enabled) => {
    writeCloudBackupEnabled(enabled)
    set({ enabled })
  },
  setPending: (pending) => set({ pending }),
  markStart: () => set({ running: true, lastError: null }),
  markResult: (result, at) => set({ running: false, last: result, lastAt: at ?? Date.now(), lastError: null }),
  markError: (error) => set({ running: false, lastError: error instanceof Error ? error.message : String(error) }),
  resetStatus: () => set({ pending: false, running: false, lastAt: null, last: null, lastError: null }),
}))
