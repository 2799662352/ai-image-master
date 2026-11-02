// 云备份 × 回收站接线:本机删除 → 云端回收站;本机彻底删除 → 通知云端收紧保留期;继续备份(复活)。
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_BACKUP_ENABLED_KEY, useCloudBackupStore } from '../../../features/video-workbench/cloudBackupStore'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import type { WorkbenchTrashEntry } from '../../../features/video-workbench/trash'
import { TRASH_RETENTION_SINCE_KEY } from '../../../features/video-workbench/trashRetention'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useAuthStore } from '../../../stores/useAuthStore'
import { purgedProjectsBetween, trashedProjectsOf, useWorkbenchCloudBackup } from '../useCloudBackup'

const S = () => useVideoWorkbenchStore.getState()

const list = vi.fn()
const put = vi.fn()
const get = vi.fn()
const remove = vi.fn()
const trashList = vi.fn()
const trashConfirm = vi.fn()

/** 指纹用 crypto.subtle.digest(真异步),光冲微任务等不到它:让出几轮真正的宏任务。 */
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
  localStorage.removeItem(TRASH_RETENTION_SINCE_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  await S().ensureHydrated()
  useCloudBackupStore.setState({ enabled: true, pending: false, running: false, lastAt: null, last: null, lastError: null })
  useAuthStore.setState({ authenticated: true, username: 'alice' })
  for (const m of [list, put, get, remove, trashList, trashConfirm]) m.mockReset()
  list.mockResolvedValue({ ok: true, data: { items: [] } })
  put.mockResolvedValue({ ok: true, data: { unchanged: false, version: 'v', bytes: 1, boards: 1, cards: 1 } })
  remove.mockResolvedValue({ ok: true, data: { removed: 1, trashed: true } })
  trashList.mockResolvedValue({ ok: true, data: { items: [] } })
  trashConfirm.mockResolvedValue({ ok: true, data: { confirmed: true } })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    getAppVersion: async () => '4.9.24',
    videoWorkbench: { cloudBackup: { list, put, get, remove, trashList, trashConfirm } },
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

const entry = (id: string, kind: 'project' | 'board', deletedAt = 1, name = id): WorkbenchTrashEntry => ({
  id,
  kind,
  deletedAt,
  boards: [],
  cards: [],
  ...(kind === 'project'
    ? { project: { id, name, order: 0, createdAt: 1, updatedAt: 1 } }
    : { projectId: 'p' }),
})

describe('trashedProjectsOf / purgedProjectsBetween', () => {
  it('只取「剧」条目,分段条目不参与', () => {
    expect(trashedProjectsOf([entry('a', 'project', 5, '甲'), entry('b', 'board')])).toEqual([
      { id: 'a', name: '甲', deletedAt: 5 },
    ])
  })

  it('上一份有、这一份没有、也不在活剧里 = 彻底删除;恢复回剧栏的不算', () => {
    const prev = [entry('gone', 'project', 7, '没了'), entry('back', 'project'), entry('stay', 'project'), entry('seg', 'board')]
    const next = [entry('stay', 'project')]
    const purged = purgedProjectsBetween(prev, next, new Set(['back']), 99)
    expect(purged).toEqual([{ id: 'gone', name: '没了', deletedAt: 7, purgedAt: 99 }])
  })
})

describe('useWorkbenchCloudBackup × 回收站', () => {
  it('备份过的剧在本机删除 → 下一轮把云端副本移入云端回收站(软删除,不带 permanent)', async () => {
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    const pid = seedDrama()
    await act(async () => {
      await result.current.runNow()
    })
    expect(put).toHaveBeenCalledTimes(1)

    expect(S().trashProject(pid)).toEqual({ ok: true })
    await act(async () => {
      await result.current.runNow()
    })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(pid)
    expect(useCloudBackupStore.getState().last?.trashedRemote).toBe(1)
  })

  it('本机彻底删除(清空回收站)→ 通知云端:回收站里这部剧的保留期收紧', async () => {
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    const pid = seedDrama()
    await act(async () => {
      await result.current.runNow()
    })
    S().trashProject(pid)
    await act(async () => {
      await result.current.runNow()
    })
    trashList.mockResolvedValue({
      ok: true,
      data: {
        items: [{ trashId: `${pid}@1`, dramaId: pid, name: '追车戏', deletedAt: Date.now(), purgeAfter: Date.now() + 60 * 86_400_000 }],
      },
    })

    await act(async () => {
      S().emptyTrash()
      await flushMicrotasks()
    })
    expect(trashConfirm).toHaveBeenCalledTimes(1)
    expect(trashConfirm).toHaveBeenCalledWith(`${pid}@1`)
  })

  it('从回收站恢复(不是彻底删除)不会通知云端', async () => {
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    const pid = seedDrama()
    await act(async () => {
      await result.current.runNow()
    })
    S().trashProject(pid)
    await act(async () => {
      await flushMicrotasks()
    })
    await act(async () => {
      S().restoreFromTrash(pid)
      await flushMicrotasks()
    })
    expect(trashList).not.toHaveBeenCalled()
    expect(trashConfirm).not.toHaveBeenCalled()
  })

  it('自动备份关着:本机彻底删除不去碰云端', async () => {
    useCloudBackupStore.setState({ enabled: false })
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    const pid = seedDrama()
    await act(async () => {
      await result.current.runNow()
    })
    S().trashProject(pid)
    await act(async () => {
      S().emptyTrash()
      await flushMicrotasks()
    })
    expect(trashList).not.toHaveBeenCalled()
    expect(trashConfirm).not.toHaveBeenCalled()
  })

  it('没登录:本机彻底删除不去碰云端', async () => {
    useAuthStore.setState({ authenticated: false, username: null })
    renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    const pid = seedDrama()
    S().trashProject(pid)
    await act(async () => {
      S().emptyTrash()
      await flushMicrotasks()
    })
    expect(list).not.toHaveBeenCalled()
    expect(trashList).not.toHaveBeenCalled()
  })

  it('revive:带 revive 重发这部剧;不在本机的剧给 NOT_FOUND 且不发请求', async () => {
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    await act(async () => {
      await flushMicrotasks()
    })
    const pid = seedDrama()
    await act(async () => {
      await result.current.runNow()
    })
    put.mockClear()

    let r: Awaited<ReturnType<typeof result.current.revive>> = null
    await act(async () => {
      r = await result.current.revive(pid)
    })
    expect(r).toMatchObject({ ok: true })
    expect(put).toHaveBeenCalled()
    expect(put.mock.calls[0][0]).toMatchObject({ dramaId: pid, revive: true })

    put.mockClear()
    await act(async () => {
      r = await result.current.revive('nope')
    })
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(put).not.toHaveBeenCalled()
  })

  it('revive:没登录返回 null,不发请求', async () => {
    useAuthStore.setState({ authenticated: false, username: null })
    const { result } = renderHook(() => useWorkbenchCloudBackup())
    const pid = seedDrama()
    let r: unknown = 'unset'
    await act(async () => {
      r = await result.current.revive(pid)
    })
    expect(r).toBeNull()
    expect(put).not.toHaveBeenCalled()
  })
})
