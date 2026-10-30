// 剧栏「云备份」入口:没传回调(非桌面端)不出现;传了就出现并带状态点;点击交回回调。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCloudBackupStore } from '../../../features/video-workbench/cloudBackupStore'
import { ACTIVE_PROJECT_KEY, RAIL_COLLAPSED_KEY } from '../../../features/video-workbench/projects'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest } from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useAuthStore } from '../../../stores/useAuthStore'
import { ProjectRail } from '../ProjectRail'

function installBridge(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    videoWorkbench: { cloudBackup: { list: vi.fn(), put: vi.fn(), get: vi.fn(), remove: vi.fn() } },
  }
}

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(RAIL_COLLAPSED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  useCloudBackupStore.setState({ enabled: true, pending: false, running: false, lastAt: null, last: null, lastError: null })
  useAuthStore.setState({ authenticated: true })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ authenticated: false })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

const dotOf = () => screen.getByRole('button', { name: '云备份' }).querySelector('.vw-cloud-dot')

describe('ProjectRail 云备份入口', () => {
  it('没传回调:不出现入口', () => {
    installBridge()
    render(<ProjectRail />)
    expect(screen.queryByRole('button', { name: '云备份' })).toBeNull()
  })

  it('传了回调:出现入口,点击交回回调', () => {
    installBridge()
    const onRequestCloudBackup = vi.fn()
    render(<ProjectRail onRequestCloudBackup={onRequestCloudBackup} />)
    fireEvent.click(screen.getByRole('button', { name: '云备份' }))
    expect(onRequestCloudBackup).toHaveBeenCalledTimes(1)
  })

  it('状态点:没登录 / 关着 = 灰;进行中 = 黄;已备份 = 绿;有失败 = 红', () => {
    installBridge()
    useAuthStore.setState({ authenticated: false })
    const { rerender } = render(<ProjectRail onRequestCloudBackup={() => {}} />)
    expect(dotOf()?.className).not.toMatch(/vw-cloud-dot-(ok|busy|warn)/)

    useAuthStore.setState({ authenticated: true })
    useCloudBackupStore.setState({ running: true })
    rerender(<ProjectRail onRequestCloudBackup={() => {}} />)
    expect(dotOf()?.className).toContain('vw-cloud-dot-busy')

    useCloudBackupStore.setState({
      running: false,
      last: { uploaded: 1, unchanged: 0, empty: 0, localOnly: 0, failures: [], stopped: null },
    })
    rerender(<ProjectRail onRequestCloudBackup={() => {}} />)
    expect(dotOf()?.className).toContain('vw-cloud-dot-ok')

    useCloudBackupStore.setState({
      last: { uploaded: 0, unchanged: 0, empty: 0, localOnly: 0, failures: [], stopped: 'NOT_CONFIGURED' },
    })
    rerender(<ProjectRail onRequestCloudBackup={() => {}} />)
    expect(dotOf()?.className).toContain('vw-cloud-dot-warn')
  })
})
