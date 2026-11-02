// 云备份的触发节奏:防抖 + 最长等待 + 单飞。纯逻辑,定时器可注入,测试不用真等。
//
// - 改动停 `debounceMs` 后才传 —— 用户在提示词框里逐字输入时不该每个字符一次请求。
// - 但**最长等 `maxWaitMs`**:生成中的卡片每几秒回流一次进度,纯防抖会被它一直顶着、永远不传。
// - 单飞:一轮没跑完又来改动 → 记一笔「还要再来一轮」,跑完立刻补,不并发。
// - 服务端没开(NOT_CONFIGURED)本会话不再自动试;手动「立即备份」会解除这个封印再试一次。

import type { WorkbenchBackupErrorCode } from '../../../../types/workbenchBackup'
import type { BackupPassResult } from './cloudBackup'

export const BACKUP_DEBOUNCE_MS = 30_000
export const BACKUP_MAX_WAIT_MS = 5 * 60_000

export interface SchedulerTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  now: () => number
}

const realTimers: SchedulerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export interface BackupSchedulerOptions {
  /** 跑一轮;实现里在调用时刻取快照。 */
  run: () => Promise<BackupPassResult>
  /** 自动备份开关(手动立即备份不看它)。 */
  isEnabled: () => boolean
  /** 当前能不能备份(例如没登录)。false 时 notify 直接忽略,不起定时器。 */
  canRun?: () => boolean
  onStart?: () => void
  onPending?: (pending: boolean) => void
  onResult?: (result: BackupPassResult) => void
  onError?: (error: unknown) => void
  debounceMs?: number
  maxWaitMs?: number
  timers?: SchedulerTimers
}

export interface BackupScheduler {
  /** 数据有改动(或刚进入页面):排一轮。 */
  notify: () => void
  /** 手动立即跑一轮。正在跑时只记「再来一轮」,返回 null。 */
  runNow: () => Promise<BackupPassResult | null>
  /** 离开页面时:有待传的改动就马上起一轮(不等防抖),不等结果。 */
  flush: () => void
  /** 账号变了:解除封印、丢弃待传状态(同步状态由调用方重建)。 */
  reset: () => void
  dispose: () => void
}

export function createBackupScheduler(opts: BackupSchedulerOptions): BackupScheduler {
  const timers = opts.timers ?? realTimers
  const debounceMs = opts.debounceMs ?? BACKUP_DEBOUNCE_MS
  const maxWaitMs = opts.maxWaitMs ?? BACKUP_MAX_WAIT_MS

  let handle: unknown = null
  let firstDirtyAt: number | null = null
  let running = false
  let again = false
  let sealed: WorkbenchBackupErrorCode | null = null
  let disposed = false

  const setPending = (pending: boolean): void => opts.onPending?.(pending)

  const clearTimer = (): void => {
    if (handle !== null) timers.clear(handle)
    handle = null
  }

  const execute = async (): Promise<BackupPassResult | null> => {
    if (running) {
      again = true
      return null
    }
    running = true
    opts.onStart?.()
    let result: BackupPassResult | null = null
    try {
      result = await opts.run()
      if (result.stopped === 'NOT_CONFIGURED') sealed = 'NOT_CONFIGURED'
      opts.onResult?.(result)
    } catch (e) {
      opts.onError?.(e)
    } finally {
      running = false
    }
    if (again && !disposed) {
      again = false
      schedule()
    }
    return result
  }

  const fire = (): void => {
    handle = null
    firstDirtyAt = null
    setPending(false)
    void execute()
  }

  function schedule(): void {
    if (disposed || sealed || !opts.isEnabled()) return
    if (opts.canRun && !opts.canRun()) return
    const now = timers.now()
    if (firstDirtyAt === null) firstDirtyAt = now
    const remainingMax = Math.max(0, maxWaitMs - (now - firstDirtyAt))
    clearTimer()
    handle = timers.set(fire, Math.min(debounceMs, remainingMax))
    setPending(true)
  }

  return {
    notify: schedule,
    runNow: () => {
      sealed = null
      clearTimer()
      firstDirtyAt = null
      setPending(false)
      return execute()
    },
    flush: () => {
      if (handle === null || sealed || !opts.isEnabled()) return
      if (opts.canRun && !opts.canRun()) return
      clearTimer()
      firstDirtyAt = null
      setPending(false)
      void execute()
    },
    reset: () => {
      sealed = null
      again = false
      clearTimer()
      firstDirtyAt = null
      setPending(false)
    },
    dispose: () => {
      disposed = true
      clearTimer()
      setPending(false)
    },
  }
}
