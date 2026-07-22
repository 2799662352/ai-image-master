// PortraitLibraryPage 上传相关单测:
//  - 选中分组后上传 → 新素材自动归入该分组(mutateOverlay moveToGroup 断言)+ 归组提示可见;
//  - 切到「环境」类型 tab 上传 → importAsset 带 imageCategory: image_environment。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '../../stores/useToastStore'
import PortraitLibraryPage from '../PortraitLibraryPage'

function mockApi(opts: { groups?: string[] } = {}) {
  const listAssets = vi.fn(async () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 24,
    totalPages: 1,
  }))
  const importAsset = vi.fn(async (input: { name?: string }) => ({
    duplicated: false,
    asset: {
      id: 'row-n1',
      kind: 'image',
      name: input.name ?? 'n1',
      assetUrl: 'asset://n1',
      assetId: 'n1',
    },
  }))
  const mutateOverlay = vi.fn(async () => ({ entries: {}, groups: opts.groups ?? [] }))
  ;(window as any).electronAPI = {
    seedance: {
      getConfig: vi.fn(async () => ({ hasKey: true, hasSecret: true })),
      listAssets,
      importAsset,
      getOverlay: vi.fn(async () => ({ entries: {}, groups: opts.groups ?? [] })),
      mutateOverlay,
      onOverlayChanged: vi.fn(() => () => {}),
    },
  }
  return { listAssets, importAsset, mutateOverlay }
}

async function uploadPng(name = 'p.png') {
  const input = screen.getByTestId('portrait-upload-input')
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'image/png' })] } })
  })
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  delete (window as any).electronAPI
  vi.restoreAllMocks()
})

describe('PortraitLibraryPage 上传', () => {
  it('选中分组后上传 → 显示归组提示,导入成功后 mutateOverlay 归入该组', async () => {
    const { importAsset, mutateOverlay } = mockApi({ groups: ['道具锚'] })
    render(<PortraitLibraryPage />)

    // 等配置探测 + 分组 chip 出现后选中分组
    const groupChip = await screen.findByRole('button', { name: /道具锚/ })
    await act(async () => {
      groupChip.click()
    })
    // 上传按钮附近可见「将归入分组」提示
    expect(screen.getByText(/归入.*道具锚/)).toBeTruthy()

    await uploadPng()
    await waitFor(() => expect(importAsset).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(mutateOverlay).toHaveBeenCalledWith({ op: 'moveToGroup', assetIds: ['n1'], group: '道具锚' }),
    )
  })

  it('未选分组上传 → 不调 mutateOverlay,无归组提示', async () => {
    const { importAsset, mutateOverlay } = mockApi()
    render(<PortraitLibraryPage />)
    await screen.findByTestId('portrait-upload-input')
    expect(screen.queryByText(/归入分组/)).toBeNull()

    await uploadPng()
    await waitFor(() => expect(importAsset).toHaveBeenCalledTimes(1))
    expect(mutateOverlay).not.toHaveBeenCalled()
  })

  it('切到「环境」tab 上传 → importAsset 带 imageCategory: image_environment', async () => {
    const { importAsset } = mockApi()
    render(<PortraitLibraryPage />)
    const envTab = await screen.findByRole('button', { name: /环境/ })
    await act(async () => {
      envTab.click()
    })

    await uploadPng('scene.png')
    await waitFor(() => expect(importAsset).toHaveBeenCalledTimes(1))
    expect(importAsset.mock.calls[0][0]).toMatchObject({
      kind: 'image',
      imageCategory: 'image_environment',
      name: 'scene.png',
    })
  })
})
