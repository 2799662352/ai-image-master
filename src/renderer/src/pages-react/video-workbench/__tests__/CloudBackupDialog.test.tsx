// 云备份面板:没通道 / 没登录的如实说明、云端清单、恢复为新剧(不覆盖)、删除的两步确认、开关与立即备份。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import type { WorkbenchBackupItem } from '../../../../../types/workbenchBackup'
import { buildCard } from '../../../features/video-workbench/cardSpec'
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

const project: VideoWorkbenchProject = { id: 'src', name: '追车戏', order: 0, createdAt: 1, updatedAt: 2 }
const boards: VideoWorkbenchBoard[] = [{ id: 'b1', projectId: 'src', name: '建立镜头', order: 0, createdAt: 1 }]

function cloudFile() {
  const r = buildProjectFile({
    project, boards,
    cards: [buildCard({ prompt: 'A' }, 0, 'b1'), buildCard({ prompt: 'B' }, 1, 'b1')],
    app: { name: 'CATIMATION', version: '4.9.23' },
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

const list = vi.fn()
const get = vi.fn()
const put = vi.fn()
const remove = vi.fn()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(CLOUD_BACKUP_ENABLED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  useToastStore.getState().clearAll()
  useCloudBackupStore.setState({ enabled: true, pending: false, running: false, lastAt: null, last: null, lastError: null })
  useAuthStore.setState({ authenticated: true })
  for (const m of [list, get, put, remove]) m.mockReset()
  list.mockResolvedValue({ ok: true, data: { items: [item({})] } })
  get.mockResolvedValue({ ok: true, data: { file: cloudFile(), version: 'v1' } })
  remove.mockResolvedValue({ ok: true, data: { removed: 2 } })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    videoWorkbench: { cloudBackup: { list, get, put, remove } },
  }
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ authenticated: false })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

const noop = async () => null

describe('CloudBackupDialog', () => {
  it('关着不渲染', () => {
    render(<CloudBackupDialog open={false} onClose={() => {}} onBackupNow={noop} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('没有桌面通道:明说不支持,不去读清单,按钮不可用', () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    expect(screen.getByRole('status').textContent).toContain('不支持云备份')
    expect((screen.getByRole('button', { name: '立即备份' }) as HTMLButtonElement).disabled).toBe(true)
    expect(list).not.toHaveBeenCalled()
  })

  it('没登录:提示登录,不读清单;开关与立即备份不可用', () => {
    useAuthStore.setState({ authenticated: false })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    expect(screen.getByRole('status').textContent).toContain('登录')
    expect(list).not.toHaveBeenCalled()
    expect((screen.getByRole('checkbox', { name: '自动备份' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '立即备份' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('已登录:列出云端备份(新的在前),带段数 / 镜数 / 时间', async () => {
    list.mockResolvedValue({
      ok: true,
      data: {
        items: [
          item({ dramaId: 'old', name: '旧剧', serverUpdatedAt: Date.now() - 3 * 86_400_000 }),
          item({ dramaId: 'new', name: '新剧', boards: 3, cards: 9, versions: 4 }),
        ],
      },
    })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    const rows = within(await screen.findByRole('list', { name: '云端备份' })).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('新剧'),
      expect.stringContaining('旧剧'),
    ])
    expect(rows[0].textContent).toContain('3 段 · 9 镜')
    expect(rows[0].textContent).toContain('保留 4 份历史')
  })

  it('云端为空给空态;读清单失败给原因', async () => {
    list.mockResolvedValueOnce({ ok: true, data: { items: [] } })
    const { unmount } = render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    expect(await screen.findByText('云端还没有备份')).toBeTruthy()
    unmount()

    list.mockResolvedValueOnce({ ok: false, code: 'NOT_CONFIGURED', message: 'x' })
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    expect((await screen.findByRole('alert')).textContent).toContain('服务端暂未开通云备份')
  })

  it('恢复为新剧:本机已有同名剧时加「(2)」、不覆盖原剧、提示成功并关闭面板', async () => {
    S().addProject('追车戏')
    const before = S().projects.length
    const onClose = vi.fn()
    render(<CloudBackupDialog open onClose={onClose} onBackupNow={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: '恢复「追车戏」为新剧' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(get).toHaveBeenCalledWith('src', undefined)
    const names = S().projects.map((p) => p.name)
    expect(S().projects.length).toBe(before + 1)
    expect(names).toContain('追车戏')
    expect(names).toContain('追车戏 (2)')
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已从云端恢复「追车戏 (2)」'))).toBe(true)
  })

  it('恢复失败(云端副本损坏 / 已被删):给原因、不新增剧、面板不关', async () => {
    get.mockResolvedValueOnce({ ok: true, data: { file: { format: 'x', boards: [] }, version: 'v1' } })
    const onClose = vi.fn()
    render(<CloudBackupDialog open onClose={onClose} onBackupNow={noop} />)
    const before = S().projects.length
    fireEvent.click(await screen.findByRole('button', { name: '恢复「追车戏」为新剧' }))
    expect((await screen.findByRole('alert')).textContent).toContain('云端副本无法解析')
    expect(S().projects.length).toBe(before)
    expect(onClose).not.toHaveBeenCalled()

    get.mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', message: 'nf' })
    fireEvent.click(screen.getByRole('button', { name: '恢复「追车戏」为新剧' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('可能已被删除'))
  })

  it('删除云端副本要点两下:第一下只是武装,第二下才删;3.5 秒不点自动复位', async () => {
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    const first = await screen.findByRole('button', { name: '删除云端副本「追车戏」' })
    fireEvent.click(first)
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认删除云端副本「追车戏」' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('src'))
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已删除云端副本「追车戏」'))).toBe(true)
  })

  it('武装后超时自动复位,不会留着一颗随时能误触的「确认删除」', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
      fireEvent.click(await screen.findByRole('button', { name: '删除云端副本「追车戏」' }))
      expect(screen.getByRole('button', { name: '确认删除云端副本「追车戏」' })).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(3600)
      })
      expect(screen.queryByRole('button', { name: '确认删除云端副本「追车戏」' })).toBeNull()
      expect(remove).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('自动备份开关:写进 store 与 localStorage(关 = "0")', async () => {
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={noop} />)
    await screen.findByRole('list', { name: '云端备份' })
    fireEvent.click(screen.getByRole('checkbox', { name: '自动备份' }))
    expect(useCloudBackupStore.getState().enabled).toBe(false)
    expect(localStorage.getItem(CLOUD_BACKUP_ENABLED_KEY)).toBe('0')
    expect(screen.getByRole('status').textContent).toContain('已关闭')
  })

  it('立即备份:调用页面传来的 onBackupNow;进行中按钮变「正在备份…」且不可点', async () => {
    const onBackupNow = vi.fn(async () => null)
    render(<CloudBackupDialog open onClose={() => {}} onBackupNow={onBackupNow} />)
    await screen.findByRole('list', { name: '云端备份' })
    fireEvent.click(screen.getByRole('button', { name: '立即备份' }))
    expect(onBackupNow).toHaveBeenCalledTimes(1)
    act(() => useCloudBackupStore.setState({ running: true }))
    const busy = screen.getByRole('button', { name: '正在备份…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
  })

  it('Esc 关闭', async () => {
    const onClose = vi.fn()
    render(<CloudBackupDialog open onClose={onClose} onBackupNow={noop} />)
    await screen.findByRole('list', { name: '云端备份' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
