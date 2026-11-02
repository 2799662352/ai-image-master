// 打开工作台页:回收站里躺满 30 天的剧被自动彻底删除,没到期的留着。
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_PROJECT_KEY, PINS_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { TRASH_RETENTION_SINCE_KEY } from '../../../features/video-workbench/trashRetention'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

const DAY = 86_400_000
const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(PINS_KEY)
  localStorage.removeItem(TRASH_RETENTION_SINCE_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function trashDrama(name: string, ageDays: number): string {
  const pid = S().addProject(name)
  S().addCards([{ prompt: '第一镜' }])
  expect(S().trashProject(pid)).toEqual({ ok: true })
  useVideoWorkbenchStore.setState({
    trash: S().trash.map((e) => (e.id === pid ? { ...e, deletedAt: Date.now() - ageDays * DAY } : e)),
  })
  return pid
}

describe('VideoWorkbenchPage:回收站 30 天保留期', () => {
  it('挂载后清掉满 30 天的,没满的留着', async () => {
    localStorage.setItem(TRASH_RETENTION_SINCE_KEY, String(Date.now() - 100 * DAY)) // 早就在计时
    const oldId = trashDrama('旧剧', 31)
    const freshId = trashDrama('新剧', 2)
    useVideoWorkbenchStore.setState({ hydrated: true })
    expect(S().trash.map((e) => e.id).sort()).toEqual([freshId, oldId].sort())

    render(<VideoWorkbenchPage />)
    await screen.findByText(/本段 \d+ 镜/)
    await waitFor(() => expect(S().trash.map((e) => e.id)).toEqual([freshId]))
  })

  it('刚升级、第一次打开:旧条目不会被一口气清掉(从这一刻起才开始数 30 天)', async () => {
    const oldId = trashDrama('旧剧', 200)
    useVideoWorkbenchStore.setState({ hydrated: true })

    render(<VideoWorkbenchPage />)
    await screen.findByText(/本段 \d+ 镜/)
    await waitFor(() => expect(localStorage.getItem(TRASH_RETENTION_SINCE_KEY)).not.toBeNull())
    expect(S().trash.map((e) => e.id)).toEqual([oldId])
  })
})
