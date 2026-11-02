// 云备份面板 × 回收站:云端已删除的冲突(继续备份)、云端回收站清单(取回为新剧 / 彻底删除两步确认)、软删除的提示。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import type { WorkbenchBackupItem, WorkbenchBackupTrashItem } from '../../../../../types/workbenchBackup'
import { buildCard } from '../../../features/video-workbench/cardSpec'
import type { BackupPassResult } from '../../../features/video-workbench/cloudBackup'
import { CLOUD_BACKUP_ENABLED_KEY, useCloudBackupStore } from '../../../features/video-workbench/cloudBackupStore'
import { buildProjectFile } from '../../../features/video-workbench/projectFile'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useAuthStore } from '../../../stores/useAuthStore'
import { useToastStore } from '../../../stores/useToastStore'
import { CloudBackupDialog } from '../CloudBackupDialog'

const S = () => useVideoWorkbenchStore.getState()
const DAY = 86_400_000

const project: VideoWorkbenchProject = { id: 'src', name: '追车戏', order: 0, createdAt: 1, updatedAt: 2 }
const boards: VideoWorkbenchBoard[] = [{ id: 'b1', projectId: 'src', name: '建立镜头', order: 0, createdAt: 1 }]

function cloudFile() {
  const r = buildProjectFile({
    project, boards,
    cards: [buildCard({ prompt: 'A' }, 0, 'b1'), buildCard({ prompt: 'B' }, 1, 'b1')],
    app: { name: 'CATIMATION', version: '4.9.24' },
    now: 0,
    resolve: () => 'skip',
  })
  if (!r.ok) throw new Error('fixture')
  return r.file
}

function item(over: Partial<WorkbenchBackupItem>): WorkbenchBackupItem {
  return {
    dramaId: 'src', name: '追车戏', version: 'v', sha256: 'x', bytes: 10, boards: 1, cards: 2,
    clientUpdatedAt: 1, serverUpdatedAt: Date.now() - 5 * 60_000, versions: 1, ...over,
  }
}

function trashItem(over: Partial<WorkbenchBackupTrashItem>): WorkbenchBackupTrashItem {
  return {
    ...item({}),
    trashId: 'src@1', deletedAt: Date.now() - 2 * DAY, purgeAfter: Date.now() + 58 * DAY, deletedBy: '小王的电脑',
    ...over,
  }
}

function passResult(over: Partial<BackupPassResult>): BackupPassResult {
  return {
    uploaded: 0, unchanged: 0, skipped: 0, failures: [], stopped: null, trashedRemote: 0, trashConflicts: [],
    ...over,
  } as BackupPassResult
}

const list = vi.fn()
const get = vi.fn()
const put = vi.fn()
const remove = vi.fn()
const trashList = vi.fn()
const trashGet = vi.fn()
const trashPurge = vi.fn()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(CLOUD_BACKUP_ENABLED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  useToastStore.getState().clearAll()
  useCloudBackupStore.setState({ enabled: true, pending: false, running: false, lastAt: null, last: null, lastError: null })
  useAuthStore.setState({ authenticated: true })
  for (const m of [list, get, put, remove, trashList, trashGet, trashPurge]) m.mockReset()
  list.mockResolvedValue({ ok: true, data: { items: [item({})] } })
  remove.mockResolvedValue({ ok: true, data: { removed: 2, trashed: true } })
  trashList.mockResolvedValue({ ok: true, data: { items: [] } })
  trashGet.mockResolvedValue({ ok: true, data: { file: cloudFile(), version: 'v1' } })
  trashPurge.mockResolvedValue({ ok: true, data: { removed: 2 } })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    videoWorkbench: { cloudBackup: { list, get, put, remove, trashList, trashGet, trashPurge } },
  }
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ authenticated: false })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

const noop = async () => null

describe('CloudBackupDialog × 云端回收站', () => {
  it('云端回收站为空:不显示这一节', async () => {
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    await screen.findByRole('list', { name: '云端备份' })
    await waitFor(() => expect(trashList).toHaveBeenCalled())
    expect(screen.queryByRole('list', { name: '云端回收站' })).toBeNull()
  })

  it('列出云端回收站(新删的在前):带删除者、还剩几天', async () => {
    trashList.mockResolvedValue({
      ok: true,
      data: {
        items: [
          trashItem({ trashId: 'old@1', dramaId: 'old', name: '旧剧', deletedAt: Date.now() - 20 * DAY, purgeAfter: Date.now() + 40 * DAY }),
          trashItem({ trashId: 'new@1', dramaId: 'new', name: '新剧', purgeAfter: Date.now() + 58 * DAY - 1000 }),
        ],
      },
    })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    const rows = within(await screen.findByRole('list', { name: '云端回收站' })).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('新剧'),
      expect.stringContaining('旧剧'),
    ])
    expect(rows[0].textContent).toContain('小王的电脑')
    expect(rows[0].textContent).toContain('还剩 58 天')
    expect(rows[1].textContent).toContain('还剩 40 天')
  })

  it('取回为新剧:按 trashId 取、同名加「(2)」、不覆盖、提示来自云端回收站并关闭面板', async () => {
    S().addProject('追车戏')
    const before = S().projects.length
    trashList.mockResolvedValue({ ok: true, data: { items: [trashItem({})] } })
    const onClose = vi.fn()
    render(<CloudBackupDialog open onClose={onClose} onBackupNow={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: '取回「追车戏」为新剧' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(trashGet).toHaveBeenCalledWith('src@1', undefined)
    expect(get).not.toHaveBeenCalled()
    expect(S().projects.length).toBe(before + 1)
    expect(S().projects.map((p) => p.name)).toContain('追车戏 (2)')
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已从云端回收站恢复「追车戏 (2)」'))).toBe(true)
  })

  it('取回失败(已过期被清):给原因,不新增剧,面板不关', async () => {
    trashList.mockResolvedValue({ ok: true, data: { items: [trashItem({})] } })
    trashGet.mockResolvedValue({ ok: false, code: 'NOT_FOUND', message: 'gone' })
    const onClose = vi.fn()
    render(<CloudBackupDialog open onClose={onClose} onBackupNow={noop} />)
    const before = S().projects.length
    fireEvent.click(await screen.findByRole('button', { name: '取回「追车戏」为新剧' }))
    expect((await screen.findByRole('alert')).textContent).toContain('可能已被删除')
    expect(S().projects.length).toBe(before)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('彻底删除要点两下:第一下只是武装,第二下才调 trashPurge,并刷新回收站', async () => {
    trashList.mockResolvedValue({ ok: true, data: { items: [trashItem({})] } })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除云端回收站里的「追车戏」' }))
    expect(trashPurge).not.toHaveBeenCalled()
    trashList.mockResolvedValue({ ok: true, data: { items: [] } })
    fireEvent.click(screen.getByRole('button', { name: '确认彻底删除云端回收站里的「追车戏」' }))
    await waitFor(() => expect(trashPurge).toHaveBeenCalledWith('src@1'))
    await waitFor(() => expect(screen.queryByRole('list', { name: '云端回收站' })).toBeNull())
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已彻底删除云端回收站里的「追车戏」'))).toBe(true)
  })

  it('武装后超时自动复位', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      trashList.mockResolvedValue({ ok: true, data: { items: [trashItem({})] } })
      render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
      fireEvent.click(await screen.findByRole('button', { name: '彻底删除云端回收站里的「追车戏」' }))
      expect(screen.getByRole('button', { name: '确认彻底删除云端回收站里的「追车戏」' })).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(3600)
      })
      expect(screen.queryByRole('button', { name: '确认彻底删除云端回收站里的「追车戏」' })).toBeNull()
      expect(trashPurge).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('读云端回收站失败给原因;接口不存在(旧后端)当空、不报错', async () => {
    trashList.mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', message: 'nf' })
    const first = render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    await screen.findByRole('list', { name: '云端备份' })
    await waitFor(() => expect(trashList).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
    first.unmount()

    trashList.mockResolvedValueOnce({ ok: false, code: 'NETWORK', message: 'boom' })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    expect((await screen.findByRole('alert')).textContent).toContain('读取云端回收站失败')
  })

  it('删除云端副本:软删除成功提示「移入云端回收站」;旧后端(trashed 缺省)仍提示「已删除」', async () => {
    const { unmount } = render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: '删除云端副本「追车戏」' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除云端副本「追车戏」' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('src'))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('已移入云端回收站「追车戏」'))).toBe(true),
    )
    unmount()

    useToastStore.getState().clearAll()
    remove.mockResolvedValue({ ok: true, data: { removed: 2 } })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: '删除云端副本「追车戏」' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除云端副本「追车戏」' }))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('已删除云端副本「追车戏」'))).toBe(true),
    )
  })
})

describe('CloudBackupDialog × 云端已删除的冲突', () => {
  const conflict = {
    dramaId: 'src', name: '追车戏', trashId: 'src@1', deletedAt: Date.now() - DAY, purgeAfter: Date.now() + 59 * DAY,
    deviceName: '小王的电脑',
  }

  it('有冲突且页面传了 onRevive:列出剧、谁删的、云端还剩几天,可点「继续备份」', async () => {
    useCloudBackupStore.setState({ last: passResult({ trashConflicts: [conflict] }), lastAt: Date.now() })
    const onRevive = vi.fn(async () => ({ ok: true as const, unchanged: false }))
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} onRevive={onRevive} />)
    const rows = within(await screen.findByRole('list', { name: '云端已删除的剧' })).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('追车戏')
    expect(rows[0].textContent).toContain('小王的电脑')
    expect(rows[0].textContent).toContain('云端还剩 59 天')

    fireEvent.click(screen.getByRole('button', { name: '继续备份「追车戏」' }))
    await waitFor(() => expect(onRevive).toHaveBeenCalledWith('src'))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('已继续备份「追车戏」'))).toBe(true),
    )
  })

  it('继续备份失败:给原因,不提示成功', async () => {
    useCloudBackupStore.setState({ last: passResult({ trashConflicts: [conflict] }), lastAt: Date.now() })
    const onRevive = vi.fn(async () => ({ ok: false as const, code: 'INVALID' as const, message: '没有镜头' }))
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} onRevive={onRevive} />)
    fireEvent.click(await screen.findByRole('button', { name: '继续备份「追车戏」' }))
    expect((await screen.findByRole('alert')).textContent).toBeTruthy()
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已继续备份'))).toBe(false)
  })

  it('没有冲突 / 没传 onRevive:不显示这一节', async () => {
    useCloudBackupStore.setState({ last: passResult({}), lastAt: Date.now() })
    const first = render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} onRevive={async () => null} />)
    await screen.findByRole('list', { name: '云端备份' })
    expect(screen.queryByRole('list', { name: '云端已删除的剧' })).toBeNull()
    first.unmount()

    useCloudBackupStore.setState({ last: passResult({ trashConflicts: [conflict] }), lastAt: Date.now() })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    await screen.findByRole('list', { name: '云端备份' })
    expect(screen.queryByRole('list', { name: '云端已删除的剧' })).toBeNull()
  })
})
