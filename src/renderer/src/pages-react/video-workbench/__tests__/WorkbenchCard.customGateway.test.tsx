// 选中设置页「自定义网关」后,卡片上的分辨率 / 样片口径按「自填 Key」算,哪怕偏好是平台余额。
//
// 2.5 的 1080p / 4k 与样片只在平台余额下开放;自定义网关上没有平台钱包,卡片若还按偏好
// 摆出 1080p,用户点了生成才被渲染端 / 主进程拒掉。这里钉的是「卡片读的是有效计费来源」,
// 而且页面挂着不卸载时,在设置页切换之后立刻跟着变。

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import {
  __resetEffectiveBillingForTests,
  setCustomGatewaySelected,
} from '../../../stores/effectiveBilling'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  __resetEffectiveBillingForTests()
  useQuotaStore.setState({ billingSource: 'platform' })
})

afterEach(() => {
  cleanup()
  __resetEffectiveBillingForTests()
  useQuotaStore.setState({ billingSource: 'own-key' })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function renderCard(): void {
  useVideoWorkbenchStore.getState().addCards([{ prompt: 'x', model: '2.5', resolution: '720p' }])
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
}

const optionValues = (select: HTMLElement) =>
  Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)

describe('卡片读「有效计费来源」', () => {
  it('对照:没选自定义网关、偏好平台余额:2.5 有 1080p / 4k', async () => {
    renderCard()
    expect(optionValues(await screen.findByLabelText('分辨率'))).toEqual(['480p', '720p', '1080p', '4k'])
  })

  it('选中自定义网关(偏好仍是平台余额):2.5 只剩 480p / 720p', async () => {
    setCustomGatewaySelected(true)
    renderCard()
    expect(optionValues(await screen.findByLabelText('分辨率'))).toEqual(['480p', '720p'])
    // 偏好本身没被改写。
    expect(useQuotaStore.getState().billingSource).toBe('platform')
  })

  it('页面挂着时在设置页切到自定义网关:分辨率口径立刻跟着变,切回来又恢复', async () => {
    renderCard()
    expect(optionValues(await screen.findByLabelText('分辨率'))).toContain('1080p')

    act(() => setCustomGatewaySelected(true))
    expect(optionValues(screen.getByLabelText('分辨率'))).toEqual(['480p', '720p'])

    act(() => setCustomGatewaySelected(false))
    expect(optionValues(screen.getByLabelText('分辨率'))).toContain('1080p')
  })
})
