// 「从人像库选择」弹窗在**平台计费**模式下的行为(人像库只存在于这一侧)。
//
// 自填 Miau Key 模式没有人像库,弹窗只给一句提示 —— 那条路在
// `PortraitPickerModal.test.tsx` 里,两边分开测,免得分不清是哪条路坏了。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortraitAsset } from '../../../../../types/portraitApi'
import type { PortraitAssetItem } from '../../../features/portrait-library/portraitLibraryShared'
import { useToastStore } from '../../../stores/useToastStore'
import { __resetQuotaStoreForTesting, useQuotaStore } from '../../../stores/useQuotaStore'
import { PortraitPickerModal } from '../PortraitPickerModal'

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/portrait'

const okEnvelope = <T,>(data: T) => ({ ok: true as const, data })

function asset(over: Partial<PortraitAsset> & { Id: string }): PortraitAsset {
  return { Status: 'Active', AssetType: 'Image', URL: `${COS}/${over.Id}.png`, ...over }
}

function mockBridges(items: PortraitAsset[]) {
  // 形参写出来是为了让 `mock.calls[0][n]` 有类型可索引(无参 mock 的 calls 是 `[]`)。
  const list = vi.fn(async (_scope: unknown, _options?: unknown) =>
    okEnvelope({ Items: items, TotalCount: items.length, HiddenCount: 0, Truncated: false }),
  )
  const bridge = {
    list,
    poll: vi.fn(() => new Promise(() => {}) as never),
    upload: vi.fn(async (_scope: unknown, _file: unknown) =>
      okEnvelope({ url: `${COS}/new.png`, cosKey: 'k', fileSize: 1, assetType: 'Image' }),
    ),
    register: vi.fn(async () =>
      okEnvelope({ Id: 'new-1', URL: `${COS}/new.png`, PreviewUrl: `${COS}/new.png`, cosUrl: `${COS}/new.png` }),
    ),
  }
  // 只挂 portraitLibrary 桥 —— 弹窗不该再依赖 `electronAPI.seedance` 里的任何东西。
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { portraitLibrary: bridge }
  return bridge
}

function pngFile(name: string, size: number): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: size })
  Object.defineProperty(file, 'arrayBuffer', {
    value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  })
  return file
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  useQuotaStore.setState({
    billingSource: 'platform',
    selectedPool: { projectId: 42, producerProjectId: 7 },
  })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  __resetQuotaStoreForTesting()
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
  vi.restoreAllMocks()
})

describe('PortraitPickerModal(平台计费)', () => {
  it('走 portraitLibrary.list(按计费池)', async () => {
    const b = mockBridges([asset({ Id: 'a1', Name: '赛博猫' })])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)

    await waitFor(() => expect(b.list).toHaveBeenCalled())
    expect(b.list.mock.calls[0]![0]).toEqual({ projectId: 42, producerProjectId: 7 })
    expect(await screen.findByTitle(/赛博猫/)).toBeTruthy()
  })

  // 官方素材 / 虚拟人像是 vvdance 的另一个素材接口,随 vvdance 直连一起删除了;
  // 「人像 / 场景」的区分上游本来就没有。tab 只剩 全部 / 图片 / 视频 / 音频。
  it('类型 tab 只有 全部 / 图片 / 视频 / 音频,没有官方素材 / 虚拟人像 / 人像 / 场景', async () => {
    mockBridges([asset({ Id: 'a1', Name: '赛博猫' })])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await screen.findByTitle(/赛博猫/)
    for (const name of ['全部', '🖼 图片', '🎞 视频', '🎵 音频']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: /官方素材/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /虚拟人像/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /人像$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /场景/ })).toBeNull()
  })

  it('点类型 tab 按素材类型过滤', async () => {
    mockBridges([
      asset({ Id: 'a1', Name: '赛博猫' }),
      asset({ Id: 'v1', Name: '一段视频', AssetType: 'Video' }),
    ])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await screen.findByTitle(/赛博猫/)
    expect(screen.getByTitle(/一段视频/)).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: '🎞 视频' }).click()
    })
    expect(screen.queryByTitle(/赛博猫/)).toBeNull()
    expect(screen.getByTitle(/一段视频/)).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: '🖼 图片' }).click()
    })
    expect(screen.getByTitle(/赛博猫/)).toBeTruthy()
    expect(screen.queryByTitle(/一段视频/)).toBeNull()
  })

  it('挂到 document.body 而不是调用方的子树里', async () => {
    mockBridges([asset({ Id: 'a1', Name: '赛博猫' })])
    // 模拟真实挂载点:弹窗是从卡片内部渲染的,而卡片有可能带 transform/contain。
    // `position: fixed` 遇到这些祖先会改成相对祖先定位,弹窗被裁进卡片框 ——
    // portal 到 body 是唯一能免疫的做法。
    const { container } = render(
      <div style={{ transform: 'translateZ(0)' }}>
        <PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />
      </div>,
    )

    const panel = await screen.findByTestId('vw-portrait-picker')
    expect(container.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
  })

  it('open=false 不渲染,也不拉列表', async () => {
    const b = mockBridges([asset({ Id: 'a1', Name: '赛博猫' })])
    render(<PortraitPickerModal open={false} onClose={() => {}} onConfirm={() => {}} />)
    expect(screen.queryByTestId('vw-portrait-picker')).toBeNull()
    expect(b.list).not.toHaveBeenCalled()
  })

  it('已移出素材库的不出现在选择器里', async () => {
    mockBridges([
      asset({ Id: 'a1', Name: '赛博猫' }),
      asset({ Id: 'a2', Name: '移走的', Hidden: true }),
    ])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await screen.findByTitle(/赛博猫/)
    expect(screen.queryByTitle(/移走的/)).toBeNull()
  })

  // 非 Active 留在列表里但选不中:拿去生成会撞 ASSET_NOT_READY / ASSET_FAILED,
  // 而从列表里消失会让用户以为没传上去、重复上传占配额。
  it('非 Active 仍然显示,但选不中且说得出原因', async () => {
    mockBridges([
      asset({ Id: 'ok', Name: '可用' }),
      asset({ Id: 'bad', Name: '坏的', Status: 'Failed', Error: { Message: '含敏感内容' } }),
    ])
    const onConfirm = vi.fn()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={onConfirm} />)

    const bad = (await screen.findByTitle(/坏的/)) as HTMLButtonElement
    expect(bad.disabled).toBe(true)
    expect(bad.getAttribute('title')).toContain('含敏感内容')
    await act(async () => {
      fireEvent.click(bad)
    })
    expect((screen.getByRole('button', { name: /使用选中素材/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('确认回填 asset://<Id>', async () => {
    mockBridges([asset({ Id: 'a1', Name: '赛博猫' }), asset({ Id: 'v1', Name: '一段视频', AssetType: 'Video' })])
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<PortraitPickerModal open onClose={onClose} onConfirm={onConfirm} />)

    const cat = await screen.findByTitle(/赛博猫/)
    const vid = screen.getByTitle(/一段视频/)
    await act(async () => {
      fireEvent.click(cat)
      fireEvent.click(vid)
    })
    await act(async () => {
      screen.getByRole('button', { name: /使用选中素材/ }).click()
    })

    const assets = onConfirm.mock.calls[0]![0] as PortraitAssetItem[]
    expect(assets.map((a) => a.assetUrl).sort()).toEqual(['asset://a1', 'asset://v1'])
    expect(assets.find((a) => a.assetId === 'v1')?.kind).toBe('video')
    expect(onClose).toHaveBeenCalled()
  })

  it('弹窗内上传走两步且递 ArrayBuffer,新素材自动选中', async () => {
    const b = mockBridges([])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await waitFor(() => expect(b.list).toHaveBeenCalled())

    const input = screen.getByTestId('vw-picker-upload-input')
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile('新素材.png', 1024)] } })
    })

    await waitFor(() => expect(b.upload).toHaveBeenCalledTimes(1))
    expect((b.upload.mock.calls[0]![1] as { data: unknown }).data).toBeInstanceOf(ArrayBuffer)
    await waitFor(() => expect(b.register).toHaveBeenCalledTimes(1))
    expect(await screen.findByTitle(/新素材\.png/)).toBeTruthy()
    // 刚登记的还没就绪 —— 出现在网格里,但不该被自动选进「使用选中素材」
    expect((screen.getByRole('button', { name: /使用选中素材/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('超限文件在读字节之前被拒', async () => {
    const b = mockBridges([])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await waitFor(() => expect(b.list).toHaveBeenCalled())

    const big = pngFile('big.png', 60 * 1024 * 1024)
    await act(async () => {
      fireEvent.change(screen.getByTestId('vw-picker-upload-input'), { target: { files: [big] } })
    })
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('50MB'))).toBe(true),
    )
    expect(b.upload).not.toHaveBeenCalled()
    expect(big.arrayBuffer).not.toHaveBeenCalled()
  })

  // 上游一次回全量(不分页),所以翻页在本地切 —— 没有翻页控件等于「库里其余素材
  // 根本够不着」。
  it('超过一页时出翻页条,翻页换内容', async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      asset({ Id: `p${i}`, Name: `素材${i}` }),
    )
    mockBridges(many)
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)

    await screen.findByTitle(/素材0/)
    expect(screen.getByTestId('vw-picker-pager').textContent).toContain('1 / 2')
    expect(screen.queryByTitle(/素材65/)).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: '下一页' }).click()
    })
    expect(await screen.findByTitle(/素材65/)).toBeTruthy()
    expect(screen.queryByTitle(/素材0$/)).toBeNull()
  })

  it('没选计费池时给一句人话,不打空请求', async () => {
    useQuotaStore.setState({ selectedPool: null })
    const b = mockBridges([asset({ Id: 'a1', Name: '赛博猫' })])
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await screen.findByText(/计费池/)
    expect(b.list).not.toHaveBeenCalled()
  })
})
