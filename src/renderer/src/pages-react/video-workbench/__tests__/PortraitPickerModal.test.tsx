// 「从人像库选择」弹窗在**自填 Miau Key** 模式下:没有人像库,只给一句提示 + 关闭,
// 不发任何请求、没有上传 / 确认入口。
//
// 以前这条路读 vvdance 素材库(含「官方素材 / 虚拟人像」两个来源与弹窗内上传),随 vvdance
// 直连一起删除。平台余额下的行为在 `PortraitPickerModal.platform.test.tsx`。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetQuotaStoreForTesting, useQuotaStore } from '../../../stores/useQuotaStore'
import { PortraitPickerModal } from '../PortraitPickerModal'

const HINT = '自填 Miau Key 模式下没有人像库。登录账号并在「设置 → 账号」启用平台余额后即可使用人像库。'

function mockBridges() {
  const portraitLibrary = {
    list: vi.fn(async () => ({ ok: true as const, data: { Items: [], TotalCount: 0, HiddenCount: 0, Truncated: false } })),
    poll: vi.fn(),
    upload: vi.fn(),
    register: vi.fn(),
  }
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { portraitLibrary }
  return portraitLibrary
}

beforeEach(() => {
  // 即便已经选了计费池,自填 Key 也不该去读平台人像库。
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: { projectId: 42, producerProjectId: 7 } })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  __resetQuotaStoreForTesting()
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
  vi.restoreAllMocks()
})

describe('PortraitPickerModal(自填 Miau Key)', () => {
  it('open=false 不渲染', () => {
    mockBridges()
    render(<PortraitPickerModal open={false} onClose={() => {}} onConfirm={() => {}} />)
    expect(screen.queryByTestId('vw-portrait-picker')).toBeNull()
  })

  it('给出「没有人像库」的提示,没有搜索 / 类型 tab / 上传 / 确认入口', () => {
    mockBridges()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)

    expect(screen.getByTestId('vw-portrait-picker-own-key-hint').textContent).toBe(HINT)
    expect(screen.queryByPlaceholderText('搜索素材名…')).toBeNull()
    expect(screen.queryByTestId('vw-picker-upload-input')).toBeNull()
    expect(screen.queryByRole('button', { name: /上传素材/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /使用选中素材/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '🖼 图片' })).toBeNull()
    expect(screen.queryByRole('button', { name: /官方素材/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /虚拟人像/ })).toBeNull()
  })

  it('一个请求都不发(包括平台人像库)', async () => {
    const b = mockBridges()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    // 让可能的异步加载有机会跑起来
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(b.list).not.toHaveBeenCalled()
    expect(b.upload).not.toHaveBeenCalled()
  })

  it('「知道了」按钮 / 右上角 ✕ / 点遮罩都能关;全程不触发 onConfirm', () => {
    mockBridges()
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<PortraitPickerModal open onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('vw-portrait-picker'))
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('点弹窗内容区不会误关(只有遮罩算「点外面」)', () => {
    mockBridges()
    const onClose = vi.fn()
    render(<PortraitPickerModal open onClose={onClose} onConfirm={() => {}} />)
    fireEvent.click(screen.getByTestId('vw-portrait-picker-own-key-hint'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('同样挂到 document.body 而不是调用方的子树里', () => {
    mockBridges()
    const { container } = render(
      <div style={{ transform: 'translateZ(0)' }}>
        <PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />
      </div>,
    )
    const panel = screen.getByTestId('vw-portrait-picker')
    expect(container.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
  })
})
