// 平台人像库面板(计费来源 = platform 时的人像库页主体)。
//
// 这一组盯的是三条硬约束在**渲染树上**的样子 —— 纯函数层已经各测过一遍,
// 这里补的是「组件确实按那些函数的语义在用它们」。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortraitAsset } from '../../../../../types/portraitApi'
import { useToastStore } from '../../../stores/useToastStore'
import { __resetQuotaStoreForTesting, useQuotaStore } from '../../../stores/useQuotaStore'
import { PlatformPortraitLibrary } from '../PlatformPortraitLibrary'

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/portrait'

const okEnvelope = <T,>(data: T) => ({ ok: true as const, data })
const errEnvelope = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message },
})

function asset(over: Partial<PortraitAsset> & { Id: string }): PortraitAsset {
  return { Status: 'Active', AssetType: 'Image', URL: `${COS}/${over.Id}.png`, ...over }
}

function mockBridge(opts: { normal?: PortraitAsset[]; trash?: PortraitAsset[] } = {}) {
  const list = vi.fn(async (_scope: unknown, options?: { hidden?: boolean }) => {
    const items = options?.hidden ? (opts.trash ?? []) : (opts.normal ?? [])
    return okEnvelope({
      Items: items,
      TotalCount: (opts.normal ?? []).length,
      HiddenCount: (opts.trash ?? []).length,
      Truncated: false,
    })
  })
  const bridge = {
    list,
    poll: vi.fn(async (_s: unknown, id: string) => okEnvelope(asset({ Id: id }))),
    upload: vi.fn(async () =>
      okEnvelope({ url: `${COS}/new.png`, cosKey: 'k', fileSize: 1, assetType: 'Image' }),
    ),
    register: vi.fn(async () =>
      okEnvelope({ Id: 'new-1', URL: `${COS}/new.png`, PreviewUrl: `${COS}/new.png`, cosUrl: `${COS}/new.png` }),
    ),
    hide: vi.fn(async () => okEnvelope({ purged: false })),
    purge: vi.fn(async () => okEnvelope({ purged: true })),
    patch: vi.fn(async () => okEnvelope({ Id: 'a1' })),
  }
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { portraitLibrary: bridge }
  return bridge
}

async function renderPanel() {
  const view = render(<PlatformPortraitLibrary />)
  await screen.findByTestId('platform-portrait-library')
  return view
}

/**
 * 真 `File`(否则 `URL.createObjectURL` 会拒),但 `size` 改写成想要的数字 ——
 * 「超限文件不读字节」那条要一个 60MB 的文件,而真造 60MB 只是在烧内存。
 * `arrayBuffer` 换成 spy,好断言它**没被调用过**。
 */
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
  useQuotaStore.setState({ selectedPool: { projectId: 42, producerProjectId: 7 } })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  __resetQuotaStoreForTesting()
  useQuotaStore.setState({ selectedPool: null })
  vi.restoreAllMocks()
})

describe('数据源', () => {
  it('走 portraitLibrary.list,scope 带上池键两半', async () => {
    const bridge = mockBridge({ normal: [asset({ Id: 'a1', Name: '主角' })] })
    await renderPanel()
    await waitFor(() => expect(bridge.list).toHaveBeenCalled())
    expect(bridge.list.mock.calls[0]![0]).toEqual({ projectId: 42, producerProjectId: 7 })
    expect(await screen.findByTestId('platform-card-a1')).toBeTruthy()
  })

  it('没选计费池时不打请求,直接引导去选池', async () => {
    useQuotaStore.setState({ selectedPool: null })
    const bridge = mockBridge({ normal: [asset({ Id: 'a1' })] })
    await renderPanel()
    expect(bridge.list).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: /计费池/ })).toBeTruthy()
  })

  it('拉列表失败 → 按 code 给动作而不是原始 message', async () => {
    mockBridge()
    const bridge = mockBridge()
    bridge.list.mockResolvedValue(errEnvelope('NOT_AUTHENTICATED', 'token expired') as never)
    await renderPanel()
    expect(await screen.findByText(/登录/)).toBeTruthy()
  })
})

// ── 硬约束 1(组件侧)────────────────────────────────────────────────────────
describe('Hidden 只在展示层分流', () => {
  it('正常视图看不到已移出的,回收站里看得到', async () => {
    mockBridge({
      normal: [asset({ Id: 'keep', Name: '留着' }), asset({ Id: 'gone', Name: '移走了', Hidden: true })],
      trash: [asset({ Id: 'gone', Name: '移走了', Hidden: true })],
    })
    await renderPanel()
    await screen.findByTestId('platform-card-keep')
    expect(screen.queryByTestId('platform-card-gone')).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: /回收站/ }).click()
    })
    expect(await screen.findByTestId('platform-card-gone')).toBeTruthy()
  })
})

// ── 硬约束 2(组件侧)────────────────────────────────────────────────────────
describe('非 Active 灰掉而不是拿走', () => {
  it('失败 / 处理中的卡片仍在网格里', async () => {
    mockBridge({
      normal: [
        asset({ Id: 'ok', Name: '可用' }),
        asset({ Id: 'bad', Name: '坏的', Status: 'Failed' }),
        asset({ Id: 'wip', Name: '在跑', Status: 'Processing' }),
      ],
    })
    await renderPanel()
    expect(await screen.findByTestId('platform-card-ok')).toBeTruthy()
    expect(screen.getByTestId('platform-card-bad')).toBeTruthy()
    expect(screen.getByTestId('platform-card-wip')).toBeTruthy()
  })

  it('禁交互 + 打角标 + hover 说清原因', async () => {
    mockBridge({
      normal: [
        asset({ Id: 'bad', Name: '坏的', Status: 'Failed', Error: { Message: '含敏感内容' } }),
        asset({ Id: 'wip', Name: '在跑', Status: 'Processing' }),
      ],
    })
    await renderPanel()
    const bad = (await screen.findByTestId('platform-card-bad')) as HTMLButtonElement
    const wip = screen.getByTestId('platform-card-wip') as HTMLButtonElement

    expect(bad.disabled).toBe(true)
    expect(wip.disabled).toBe(true)
    expect(screen.getByTestId('platform-status-bad').textContent).toContain('失败')
    expect(screen.getByTestId('platform-status-wip').textContent).toContain('处理中')
    // 失败是上游终态,提示必须是「换一张」不是「稍等」
    expect(bad.getAttribute('title')).toContain('含敏感内容')
    expect(bad.getAttribute('title')).toMatch(/换一张|重新导入/)
    expect(wip.getAttribute('title')).toMatch(/稍等/)
  })

  it('点不动 —— 选不中就不会被送去生成', async () => {
    mockBridge({ normal: [asset({ Id: 'bad', Name: '坏的', Status: 'Failed' })] })
    await renderPanel()
    const bad = await screen.findByTestId('platform-card-bad')
    await act(async () => {
      fireEvent.click(bad)
    })
    expect(screen.queryByText(/已选/)).toBeNull()
  })
})

// ── 硬约束 3(组件侧)────────────────────────────────────────────────────────
describe('三个删除动作在 UI 上是三件事', () => {
  async function selectCard(id: string) {
    const card = await screen.findByTestId(`platform-card-${id}`)
    await act(async () => {
      fireEvent.click(card)
    })
  }

  it('文案是「移出素材库」而不是「删除」—— 软删不释放配额,叫删除会让人困惑', async () => {
    mockBridge({ normal: [asset({ Id: 'a1', Name: '主角' })] })
    await renderPanel()
    await selectCard('a1')
    expect(screen.getByRole('button', { name: /移出素材库/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^🗑 删除$/ })).toBeNull()
  })

  it('移出素材库 → hide,成功后重拉列表', async () => {
    const bridge = mockBridge({ normal: [asset({ Id: 'a1', Name: '主角' })] })
    await renderPanel()
    await selectCard('a1')
    const before = bridge.list.mock.calls.length

    await act(async () => {
      screen.getByRole('button', { name: /移出素材库/ }).click()
    })
    await waitFor(() => expect(bridge.hide).toHaveBeenCalledWith(
      { projectId: 42, producerProjectId: 7 },
      'a1',
    ))
    expect(bridge.purge).not.toHaveBeenCalled()
    await waitFor(() => expect(bridge.list.mock.calls.length).toBeGreaterThan(before))
  })

  // 不要乐观删除:软删失败会返 500,乐观移除会让用户以为删了、刷新后素材复活。
  it('软删失败 → 卡片原地不动 + 报错,绝不先把它从网格里拿走', async () => {
    const bridge = mockBridge({ normal: [asset({ Id: 'a1', Name: '主角' })] })
    bridge.hide.mockResolvedValue(errEnvelope('HTTP_500', '后端炸了') as never)
    await renderPanel()
    await selectCard('a1')

    await act(async () => {
      screen.getByRole('button', { name: /移出素材库/ }).click()
    })
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true),
    )
    expect(screen.getByTestId('platform-card-a1')).toBeTruthy()
  })

  it('回收站里是「恢复」+「彻底删除」两个动作,不是一个', async () => {
    mockBridge({ trash: [asset({ Id: 't1', Name: '回收的', Hidden: true })] })
    await renderPanel()
    await act(async () => {
      screen.getByRole('button', { name: /回收站/ }).click()
    })
    await selectCard('t1')
    expect(screen.getByRole('button', { name: /恢复/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /彻底删除/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /移出素材库/ })).toBeNull()
  })

  it('恢复 → patch(hidden:false),成功后必须重拉列表', async () => {
    const bridge = mockBridge({ trash: [asset({ Id: 't1', Name: '回收的', Hidden: true })] })
    await renderPanel()
    await act(async () => {
      screen.getByRole('button', { name: /回收站/ }).click()
    })
    await selectCard('t1')
    const before = bridge.list.mock.calls.length

    await act(async () => {
      screen.getByRole('button', { name: /恢复/ }).click()
    })
    await waitFor(() =>
      expect(bridge.patch).toHaveBeenCalledWith({ projectId: 42, producerProjectId: 7 }, 't1', {
        hidden: false,
      }),
    )
    await waitFor(() => expect(bridge.list.mock.calls.length).toBeGreaterThan(before))
  })

  it('彻底删除要二次确认,文案说清画布上的引用会失效', async () => {
    const bridge = mockBridge({ trash: [asset({ Id: 't1', Name: '回收的', Hidden: true })] })
    await renderPanel()
    await act(async () => {
      screen.getByRole('button', { name: /回收站/ }).click()
    })
    await selectCard('t1')

    await act(async () => {
      screen.getByRole('button', { name: /彻底删除/ }).click()
    })
    // 第一下只是开确认,不许直接打上游
    expect(bridge.purge).not.toHaveBeenCalled()
    const dialog = await screen.findByTestId('platform-purge-confirm')
    expect(dialog.textContent).toMatch(/无法再用于生成/)
    expect(dialog.textContent).toMatch(/不可/)

    await act(async () => {
      screen.getByRole('button', { name: /确认彻底删除/ }).click()
    })
    await waitFor(() =>
      expect(bridge.purge).toHaveBeenCalledWith({ projectId: 42, producerProjectId: 7 }, 't1'),
    )
    expect(bridge.hide).not.toHaveBeenCalled()
  })

  it('确认框可以取消,取消后什么都没发生', async () => {
    const bridge = mockBridge({ trash: [asset({ Id: 't1', Name: '回收的', Hidden: true })] })
    await renderPanel()
    await act(async () => {
      screen.getByRole('button', { name: /回收站/ }).click()
    })
    await selectCard('t1')
    await act(async () => {
      screen.getByRole('button', { name: /彻底删除/ }).click()
    })
    await act(async () => {
      screen.getByRole('button', { name: /^取消$/ }).click()
    })
    expect(screen.queryByTestId('platform-purge-confirm')).toBeNull()
    expect(bridge.purge).not.toHaveBeenCalled()
  })
})

describe('上传', () => {
  async function upload(file: File) {
    const input = screen.getByTestId('platform-portrait-upload-input')
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
  }

  // register 回的三个 URL 就是永久 COS 链,缩略图不必等 poll。这里把 poll 挂住不让它
  // 回,好观察「登记完成、尚未就绪」那一刻 —— 那正是网页版会留一块空白的地方。
  it('两步走 upload → register,新卡片立刻有图但还不可选', async () => {
    const bridge = mockBridge({ normal: [] })
    bridge.poll.mockImplementation(() => new Promise(() => {}) as never)
    await renderPanel()
    await upload(pngFile('刚传的.png', 1024))

    await waitFor(() => expect(bridge.upload).toHaveBeenCalledTimes(1))
    expect((bridge.upload.mock.calls[0]![1] as { data: unknown }).data).toBeInstanceOf(ArrayBuffer)
    await waitFor(() => expect(bridge.register).toHaveBeenCalledTimes(1))

    const card = await screen.findByTestId('platform-card-new-1')
    expect(card.getAttribute('title')).toContain('刚传的.png')
    expect(card.querySelector('img')?.getAttribute('src')).toContain('imageMogr2/thumbnail/400x')
    expect((card as HTMLButtonElement).disabled).toBe(true)
  })

  // 服务端长轮询,一次请求最长 90s —— 外面不再包 setInterval。
  it('poll 回来后那张卡自己变成可用,不用手动刷新', async () => {
    mockBridge({ normal: [] })
    await renderPanel()
    await upload(pngFile('刚传的.png', 1024))

    const card = await screen.findByTestId('platform-card-new-1')
    await waitFor(() => expect((card as HTMLButtonElement).disabled).toBe(false))
  })

  it('超限文件在读字节之前就被拒,一个字节都不过 IPC', async () => {
    const bridge = mockBridge({ normal: [] })
    await renderPanel()
    const big = pngFile('big.png', 60 * 1024 * 1024)
    await upload(big)

    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('50MB'))).toBe(true),
    )
    expect(bridge.upload).not.toHaveBeenCalled()
    expect(big.arrayBuffer).not.toHaveBeenCalled()
  })

  it('上传失败按 code 给动作', async () => {
    const bridge = mockBridge({ normal: [] })
    bridge.upload.mockResolvedValue(
      errEnvelope('UNSUPPORTED_MEDIA_TYPE', '不支持的文件类型: image/svg+xml') as never,
    )
    await renderPanel()
    await upload(pngFile('a.png', 1024))
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.type === 'error' && t.message.includes('换一个文件')),
      ).toBe(true),
    )
  })
})

describe('计数', () => {
  it('「N 可用」数的是 Active,不是 Items.length 也不是 TotalCount', async () => {
    mockBridge({
      normal: [
        asset({ Id: 'a', Status: 'Active' }),
        asset({ Id: 'b', Status: 'Failed' }),
        asset({ Id: 'c', Status: 'Processing' }),
      ],
    })
    await renderPanel()
    const summary = await screen.findByTestId('platform-portrait-summary')
    expect(summary.textContent).toContain('1 可用')
  })
})
