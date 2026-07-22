// PortraitPickerModal 单测:列表加载 / 多选 / 确认回填完整素材项 / 弹窗内直接上传。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceAssetItem } from '../../../../../types/seedance'
import { useToastStore } from '../../../stores/useToastStore'
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
  // 用可变引用,让「上传后刷新」测试能在两次 listAssets 间改变返回内容。
  const listState = { items }
  const listAssets = vi.fn(async () => ({
    items: listState.items,
    total: listState.items.length,
    page: 1,
    pageSize: 60,
    totalPages: 1,
  }))
  const importAsset = vi.fn(async (input: { name?: string }) => {
    const asset = makeAsset('new1', input.name ?? '新素材')
    listState.items = [...listState.items, asset]
    return { duplicated: false, asset }
  })
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
      importAsset,
      // usePortraitLibraryOverlay 的桥(空叠加层)
      getOverlay: vi.fn(async () => ({ entries: {}, groups: [] })),
      mutateOverlay: vi.fn(async () => ({ entries: {}, groups: [] })),
      onOverlayChanged: vi.fn(() => () => {}),
    },
  }
  return { listAssets, listOfficialMaterials, importAsset, listState }
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

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

  it('「我的素材」显示上传按钮;官方素材 tab 不显示', async () => {
    mockApi([makeAsset('a1', '赛博猫')])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await screen.findByTitle('赛博猫')
    expect(screen.getByRole('button', { name: /上传素材/ })).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: /官方素材/ }).click()
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /上传素材/ })).toBeNull())
  })

  it('弹窗内上传成功 → importAsset 按当前 tab 传 imageCategory,刷新列表并自动选中新素材', async () => {
    const { importAsset, listAssets } = mockApi([makeAsset('a1', '赛博猫')])
    const onConfirm = vi.fn()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={onConfirm} />)
    await screen.findByTitle('赛博猫')
    const listCallsBefore = listAssets.mock.calls.length

    const input = screen.getByTestId('vw-picker-upload-input')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], '新素材.png', { type: 'image/png' })] } })
    })

    await waitFor(() => expect(importAsset).toHaveBeenCalledTimes(1))
    // 默认在「人像」tab 上传 → image_people
    expect(importAsset.mock.calls[0][0]).toMatchObject({ kind: 'image', imageCategory: 'image_people' })
    // 上传成功后刷新列表(listAssets 再次调用)且新素材出现
    await waitFor(() => expect(listAssets.mock.calls.length).toBeGreaterThan(listCallsBefore))
    await screen.findByTitle('新素材.png')

    // 新素材已自动选中 → 直接可确认
    const confirmBtn = screen.getByRole('button', { name: /使用选中素材/ }) as HTMLButtonElement
    await waitFor(() => expect(confirmBtn.disabled).toBe(false))
    await act(async () => {
      confirmBtn.click()
    })
    const assets = onConfirm.mock.calls[0][0] as SeedanceAssetItem[]
    expect(assets.map((a) => a.assetId)).toEqual(['new1'])
  })

  it('弹窗内上传失败 → toast 错误,不选中任何素材', async () => {
    const api = mockApi([makeAsset('a1', '赛博猫')])
    api.importAsset.mockImplementation(async () => {
      throw new Error('审核不通过')
    })
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await screen.findByTitle('赛博猫')

    const input = screen.getByTestId('vw-picker-upload-input')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'bad.png', { type: 'image/png' })] } })
    })

    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.type === 'error' && t.message.includes('上传失败'))).toBe(true),
    )
    const confirmBtn = screen.getByRole('button', { name: /使用选中素材/ }) as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })
})
