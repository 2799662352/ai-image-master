// 人像库页按计费来源选数据源。
//
// 两条路的素材**互不可见**,所以走错一条不是「样式不太对」,是用户看到一个空库、
// 然后把已经在另一条路上的素材再传一遍。

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetQuotaStoreForTesting, useQuotaStore } from '../../stores/useQuotaStore'
import PortraitLibraryPage from '../PortraitLibraryPage'

function mockBothBridges() {
  const listAssets = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 24, totalPages: 1 }))
  const list = vi.fn(async () =>
    ({ ok: true as const, data: { Items: [], TotalCount: 0, HiddenCount: 0, Truncated: false } }),
  )
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    seedance: {
      getConfig: vi.fn(async () => ({ hasKey: true, hasSecret: true })),
      listAssets,
      getOverlay: vi.fn(async () => ({ entries: {}, groups: [] })),
      mutateOverlay: vi.fn(async () => ({ entries: {}, groups: [] })),
      onOverlayChanged: vi.fn(() => () => {}),
    },
    portraitLibrary: { list },
  }
  return { listAssets, list }
}

beforeEach(() => {
  useQuotaStore.setState({ selectedPool: { projectId: 42, producerProjectId: null } })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  __resetQuotaStoreForTesting()
  useQuotaStore.setState({ selectedPool: null, billingSource: 'own-key' })
  vi.restoreAllMocks()
})

describe('PortraitLibraryPage 数据源分叉', () => {
  it('平台余额 → 打 portraitLibrary.list,一次都不碰 vvdance', async () => {
    const { listAssets, list } = mockBothBridges()
    await act(async () => {
      useQuotaStore.setState({ billingSource: 'platform' })
    })
    render(<PortraitLibraryPage />)

    await screen.findByTestId('platform-portrait-library')
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(listAssets).not.toHaveBeenCalled()
  })

  it('自填 Key → 仍走 vvdance,一次都不碰平台人像库', async () => {
    const { listAssets, list } = mockBothBridges()
    render(<PortraitLibraryPage />)

    await waitFor(() => expect(listAssets).toHaveBeenCalled())
    expect(list).not.toHaveBeenCalled()
    expect(screen.queryByTestId('platform-portrait-library')).toBeNull()
  })
})
