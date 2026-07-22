// PortraitPickerModal 单测:列表加载 / 多选 / 确认回填完整素材项。

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceAssetItem } from '../../../../../types/seedance'
import { PortraitPickerModal } from '../PortraitPickerModal'

function makeAsset(id: string, name: string): SeedanceAssetItem {
  return {
    id: `row-${id}`,
    kind: 'image',
    name,
    assetUrl: `asset://${id}`,
    assetId: id,
    previewUrl: `https://cdn.example.com/${id}.jpg`,
  }
}

function mockApi(items: SeedanceAssetItem[], officialItems: object[] = []) {
  const listAssets = vi.fn(async () => ({
    items,
    total: items.length,
    page: 1,
    pageSize: 60,
    totalPages: 1,
  }))
  const listOfficialMaterials = vi.fn(async () => ({
    items: officialItems,
    total: officialItems.length,
    page: 1,
    pageSize: 60,
    totalPages: 1,
  }))
  ;(window as any).electronAPI = {
    seedance: {
      listAssets,
      listOfficialMaterials,
      // usePortraitLibraryOverlay 的桥(空叠加层)
      getOverlay: vi.fn(async () => ({ entries: {}, groups: [] })),
      mutateOverlay: vi.fn(async () => ({ entries: {}, groups: [] })),
      onOverlayChanged: vi.fn(() => () => {}),
    },
  }
  return { listAssets, listOfficialMaterials }
}

afterEach(() => {
  cleanup()
  delete (window as any).electronAPI
})

describe('PortraitPickerModal', () => {
  it('open=false 不渲染;open=true 拉取素材并展示', async () => {
    const { listAssets } = mockApi([makeAsset('a1', '赛博猫'), makeAsset('a2', '机械狗')])
    const { rerender } = render(<PortraitPickerModal open={false} onClose={() => {}} onConfirm={() => {}} />)
    expect(screen.queryByTestId('vw-portrait-picker')).toBeNull()

    rerender(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await waitFor(() => expect(listAssets).toHaveBeenCalled())
    expect(await screen.findByTitle('赛博猫')).toBeTruthy()
    expect(screen.getByTitle('机械狗')).toBeTruthy()
  })

  it('多选后确认 → onConfirm 收到完整素材项并关闭', async () => {
    mockApi([makeAsset('a1', '赛博猫'), makeAsset('a2', '机械狗')])
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<PortraitPickerModal open onClose={onClose} onConfirm={onConfirm} />)

    const cat = await screen.findByTitle('赛博猫')
    const dog = screen.getByTitle('机械狗')
    await act(async () => {
      cat.click()
      dog.click()
    })
    const confirmBtn = screen.getByRole('button', { name: /使用选中素材/ })
    await act(async () => {
      confirmBtn.click()
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const assets = onConfirm.mock.calls[0][0] as SeedanceAssetItem[]
    expect(assets.map((a) => a.assetId).sort()).toEqual(['a1', 'a2'])
    expect(assets[0].assetUrl.startsWith('asset://')).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('未选任何素材时确认按钮禁用', async () => {
    mockApi([makeAsset('a1', '赛博猫')])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await screen.findByTitle('赛博猫')
    const confirmBtn = screen.getByRole('button', { name: /使用选中素材/ })
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('切到「官方素材」tab → 走 listOfficialMaterials,选中回填 https 地址(文档 5.4)', async () => {
    const { listOfficialMaterials } = mockApi(
      [makeAsset('a1', '赛博猫')],
      [
        {
          id: 'volc-material-video-urban-walk-001',
          kind: 'video',
          name: '都市街拍走路镜头',
          previewUrl: 'https://cdn/urban-walk-preview.mp4',
          sourceUrl: 'https://cdn/urban-walk.mp4',
          assetUrl: 'https://cdn/urban-walk.mp4',
          assetId: null,
          sourceKind: 'official_library',
        },
      ],
    )
    const onConfirm = vi.fn()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={onConfirm} />)
    await screen.findByTitle('赛博猫')

    await act(async () => {
      screen.getByRole('button', { name: /官方素材/ }).click()
    })
    await waitFor(() =>
      expect(listOfficialMaterials).toHaveBeenCalledWith(
        expect.objectContaining({ library: 'materials' }),
      ),
    )
    const item = await screen.findByTitle('都市街拍走路镜头')
    await act(async () => {
      item.click()
    })
    await act(async () => {
      screen.getByRole('button', { name: /使用选中素材/ }).click()
    })
    const assets = onConfirm.mock.calls[0][0] as SeedanceAssetItem[]
    expect(assets).toHaveLength(1)
    // 官方素材没有 asset://,回填原始 https 地址
    expect(assets[0].assetUrl).toBe('https://cdn/urban-walk.mp4')
    expect(assets[0].kind).toBe('video')
  })

  it('切到「虚拟人像」tab → library=avatars', async () => {
    const { listOfficialMaterials } = mockApi([], [])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await act(async () => {
      screen.getByRole('button', { name: /虚拟人像/ }).click()
    })
    await waitFor(() =>
      expect(listOfficialMaterials).toHaveBeenCalledWith(
        expect.objectContaining({ library: 'avatars' }),
      ),
    )
  })
})
