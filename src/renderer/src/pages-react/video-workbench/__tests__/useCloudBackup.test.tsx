// 云备份接线:store 改动 → 防抖后上传;离开页面时 flush;没登录不发请求、登录后补上;换账号重新对账。
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_BACKUP_ENABLED_KEY, useCloudBackupStore } from '../../../features/video-workbench/cloudBackupStore'
import { BACKUP_DEBOUNCE_MS } from '../../../features/video-workbench/cloudBackupScheduler'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useAuthStore } from '../../../stores/useAuthStore'
import { useWorkbenchCloudBackup } from '../useCloudBackup'

const S = () => useVideoWorkbenchStore.getState()

const list = vi.fn()
const put = vi.fn()
const get = vi.fn()
const remove = vi.fn()

/**
 * 指纹用 crypto.subtle.digest(真异步,走线程池),光冲微任务等不到它;
 * 这里让出几轮真正的宏任务(setImmediate 没被 fake)。
 */
async function flushMicrotasks(): Promise<void> {
  const until = Date.now() + 60
  while (Date.now() < until) {
    await Promise.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

beforeEach(async () => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(CLOUD_BACKUP_ENABLED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  await S().ensureHydrated()
  useCloudBackupStore.setState({ enabled: true, pending: false, running: false, lastAt: null, last: null, lastError: null })
  useAuthStore.setState({ authenticated: true, username: 'alice' })
  for (const m of [list, put, get, remove]) m.mockReset()
  list.mockResolvedValue({ ok: true, data: { items: [] } })
  put.mockResolvedValue({ ok: true, data: { unchanged: false, version: 'v', bytes: 1, boards: 1, cards: 1 } })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    getAppVersion: async () => '4.9.23',
    videoWorkbench: { cloudBackup: { list, put, get, remove } },
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAuthStore.setState({ authenticated: false, username: null })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function seedDrama(): string {
  const pid = S().addProject('追车戏')
  S().addCards([{ prompt: '第一镜' }])
  return pid
}

describe('useWorkbenchCloudBackup', () => {
  it('改动后停手 30 秒才上传;上传的是这部剧、带它的 id 与名字', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    const pid = seedDrama()
    await act(async () => {
      vi.advanceTimersByTime(BACKUP_DEBOUNCE_MS - 1000)
      await flushMicrotasks()
    })
    expect(put).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await flushMicrotasks()
    })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toMatchObject({ dramaId: pid, name: '追车戏' })
    expect(useCloudBackupStore.getState().last?.uploaded).toBe(1)
  })

  it('离开页面(卸载)时有待传改动就立刻传,不等防抖', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { unmount } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    seedDrama()
    expect(put).not.toHaveBeenCalled()
    await act(async () => {
      unmount()
      await flushMicrotasks()
    })
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('没登录:不发任何请求;登录后补排一轮并上传', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useAuthStore.setState({ authenticated: false, username: null })
    renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    seedDrama()
    await act(async () => {
      vi.advanceTimersByTime(BACKUP_DEBOUNCE_MS * 2)
      await flushMicrotasks()
    })
    expect(list).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()

    await act(async () => {
      useAuthStore.setState({ authenticated: true, username: 'alice' })
      await flushMicrotasks()
    })
    await act(async () => {
      vi.advanceTimersByTime(BACKUP_DEBOUNCE_MS + 500)
      await flushMicrotasks()
    })
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('自动备份关着:改动不触发;手动 runNow 照常传', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useCloudBackupStore.setState({ enabled: false })
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    seedDrama()
    await act(async () => {
      vi.advanceTimersByTime(BACKUP_DEBOUNCE_MS * 2)
      await flushMicrotasks()
    })
    expect(put).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.runNow()
    })
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('换账号:同步状态重建,新账号云端没有就重新上传(不沿用上个账号的对账)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    seedDrama()
    await act(async () => {
      await result.current.runNow()
    })
    expect(put).toHaveBeenCalledTimes(1)
    // 同账号再来一轮:内容没变 → 不再传
    await act(async () => {
      await result.current.runNow()
    })
    expect(put).toHaveBeenCalledTimes(1)

    await act(async () => {
      useAuthStore.setState({ username: 'bob' })
      await flushMicrotasks()
    })
    await act(async () => {
      await result.current.runNow()
    })
    expect(list).toHaveBeenCalledTimes(2)
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('非桌面宿主(没有通道):什么都不发,也不抛', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    seedDrama()
    await act(async () => {
      expect(await result.current.runNow()).toBeNull()
    })
    expect(list).not.toHaveBeenCalled()
  })
})
