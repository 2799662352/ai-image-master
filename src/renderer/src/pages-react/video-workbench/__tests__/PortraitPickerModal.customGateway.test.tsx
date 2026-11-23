// 「从人像库选择」弹窗在选中「自定义网关」时:人像库只存在于平台余额这一侧,
// 自定义网关上没有平台钱包 —— 即使偏好是平台余额、也选了计费池,也只给「没有人像库」的提示,
// 不去读平台人像库(那会拿平台会话去查一个与当前网关无关的库)。

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEffectiveBillingForTests,
  setCustomGatewaySelected,
} from '../../../stores/effectiveBilling'
import { __resetQuotaStoreForTesting, useQuotaStore } from '../../../stores/useQuotaStore'
import { PortraitPickerModal } from '../PortraitPickerModal'

function mockBridges() {
  const portraitLibrary = {
    list: vi.fn(async () => ({
      ok: true as const,
      data: { Items: [], TotalCount: 0, HiddenCount: 0, Truncated: false },
    })),
    poll: vi.fn(() => new Promise(() => {}) as never),
    upload: vi.fn(),
    register: vi.fn(),
  }
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { portraitLibrary }
  return portraitLibrary
}

beforeEach(() => {
  __resetEffectiveBillingForTests()
  useQuotaStore.setState({
    billingSource: 'platform',
    selectedPool: { projectId: 42, producerProjectId: 7 },
  })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  __resetEffectiveBillingForTests()
  __resetQuotaStoreForTesting()
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
  vi.restoreAllMocks()
})

describe('PortraitPickerModal(选中自定义网关)', () => {
  it('偏好是平台余额、也有计费池:只给「没有人像库」的提示,一个请求都不发', async () => {
    setCustomGatewaySelected(true)
    const b = mockBridges()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)

    expect(screen.getByTestId('vw-portrait-picker-own-key-hint')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(b.list).not.toHaveBeenCalled()
  })

  it('对照:没选自定义网关时同样的偏好会去读平台人像库(证明上一条的「不发」不是弹窗没渲染好)', async () => {
    const b = mockBridges()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)

    await vi.waitFor(() => expect(b.list).toHaveBeenCalled())
    expect(screen.queryByTestId('vw-portrait-picker-own-key-hint')).toBeNull()
  })

  it('弹窗开着时切到自定义网关:立刻换成提示', async () => {
    const b = mockBridges()
    render(<PortraitPickerModal open onClose={() => {}} onConfirm={() => {}} />)
    await vi.waitFor(() => expect(b.list).toHaveBeenCalled())

    act(() => setCustomGatewaySelected(true))

    expect(screen.getByTestId('vw-portrait-picker-own-key-hint')).toBeTruthy()
  })
})
