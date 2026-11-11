// 人像库页按计费来源选主体。
//
// 人像库只存在于平台余额这一侧;自填 Miau Key 模式没有人像库,页面只给一张提示卡片
// (以前这里是 vvdance 素材库那条老路,已随 vvdance 直连删除)。走错一边的后果是用户看到
// 一个空库、然后把已经在另一边的素材再传一遍,所以两边都要断言「不碰对面」。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetQuotaStoreForTesting, useQuotaStore } from '../../stores/useQuotaStore'
import { useTabStore } from '../../stores'
import PortraitLibraryPage from '../PortraitLibraryPage'

function mockBridge() {
  const list = vi.fn(async () =>
    ({ ok: true as const, data: { Items: [], TotalCount: 0, HiddenCount: 0, Truncated: false } }),
  )
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    portraitLibrary: { list },
  }
  return { list }
}

beforeEach(() => {
  useQuotaStore.setState({ selectedPool: { projectId: 42, producerProjectId: null } })
})

afterEach(() => {
  cleanup()
  useTabStore.setState({ activeTab: 'generate' })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  delete (window as unknown as { siteManagerTS?: unknown }).siteManagerTS
  __resetQuotaStoreForTesting()
  useQuotaStore.setState({ selectedPool: null, billingSource: 'own-key' })
  vi.restoreAllMocks()
})

describe('PortraitLibraryPage 数据源分叉', () => {
  it('平台余额 → 打 portraitLibrary.list,不出自填 Key 的提示卡片', async () => {
    const { list } = mockBridge()
    await act(async () => {
      useQuotaStore.setState({ billingSource: 'platform' })
    })
    render(<PortraitLibraryPage />)

    await screen.findByTestId('platform-portrait-library')
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(screen.queryByTestId('portrait-library-own-key-notice')).toBeNull()
  })

  it('自填 Key → 只显示「没有人像库」的提示卡片,一次都不碰平台人像库', async () => {
    const { list } = mockBridge()
    render(<PortraitLibraryPage />)

    const notice = await screen.findByTestId('portrait-library-own-key-notice')
    expect(notice.textContent).toContain(
      '自填 Miau Key 模式下没有人像库。登录账号并在「设置 → 账号」启用平台余额后即可使用人像库。',
    )
    expect(screen.queryByTestId('platform-portrait-library')).toBeNull()
    // 没有 vvdance 老路上的任何控件
    expect(screen.queryByTestId('portrait-upload-input')).toBeNull()
    expect(screen.queryByRole('button', { name: /上传素材/ })).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(list).not.toHaveBeenCalled()
  })

  it('自填 Key 的提示卡片:「前往设置」优先走经典壳设置模态框,否则切到设置页签', async () => {
    mockBridge()
    const openSettingsModal = vi.fn()
    ;(window as unknown as { siteManagerTS?: unknown }).siteManagerTS = { openSettingsModal }
    render(<PortraitLibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: '前往设置' }))
    expect(openSettingsModal).toHaveBeenCalledTimes(1)

    delete (window as unknown as { siteManagerTS?: unknown }).siteManagerTS
    expect(useTabStore.getState().activeTab).not.toBe('settings')
    fireEvent.click(screen.getByRole('button', { name: '前往设置' }))
    expect(useTabStore.getState().activeTab).toBe('settings')
  })

  it('计费来源在页面开着时切换,主体跟着切', async () => {
    mockBridge()
    render(<PortraitLibraryPage />)
    await screen.findByTestId('portrait-library-own-key-notice')

    await act(async () => {
      useQuotaStore.setState({ billingSource: 'platform' })
    })
    await screen.findByTestId('platform-portrait-library')
    expect(screen.queryByTestId('portrait-library-own-key-notice')).toBeNull()
  })
})
