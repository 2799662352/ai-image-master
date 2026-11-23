// 智能擦除「高清」提交带给主进程的计费意向:选中设置页「自定义网关」后一律是 own-key,
// 哪怕偏好是平台余额。主进程那边还有一道同样的兜底,这里钉的是渲染端先说对。
//
// `EraseUploader` 在模块加载时就取了 `window.electronAPI`,所以桥要在 import 之前装好。

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { submit } = vi.hoisted(() => {
  const submit = vi.fn(async (_payload: Record<string, unknown>) => ({ success: true, taskId: 'enhance-1' }))
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    smartEraseSubmit: submit,
    getFilePath: () => '/tmp/a.mp4',
  }
  return { submit }
})

vi.mock('../probeVideoFiles', () => ({
  probeVideoFiles: vi.fn(async () => [
    { filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5 },
  ]),
  generatePosterFromFile: vi.fn(async () => ''),
}))

import { useErasePersistStore } from '../../../stores/useErasePersistStore'
import { useEraseSessionStore } from '../../../stores/useEraseSessionStore'
import {
  __resetEffectiveBillingForTests,
  setCustomGatewaySelected,
} from '../../../stores/effectiveBilling'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import { EraseUploader } from '../EraseUploader'

beforeEach(() => {
  submit.mockClear()
  __resetEffectiveBillingForTests()
  useQuotaStore.setState({ billingSource: 'platform' })
  useErasePersistStore.setState({ _hasHydrated: true })
  useEraseSessionStore.getState().setTool('enhance')
})

afterEach(() => {
  cleanup()
  __resetEffectiveBillingForTests()
  useQuotaStore.setState({ billingSource: 'own-key' })
})

async function dropOneVideo(container: HTMLElement): Promise<Record<string, unknown>> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File([new Uint8Array([1, 2, 3])], 'a.mp4', { type: 'video/mp4' })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  return submit.mock.calls[0][0]
}

describe('EraseUploader 的计费意向', () => {
  it('对照:没选自定义网关、偏好平台余额:高清提交带 billing: platform', async () => {
    const { container } = render(<EraseUploader />)
    expect(await dropOneVideo(container)).toMatchObject({ tool: 'enhance', billing: 'platform' })
  })

  it('选中自定义网关(偏好仍是平台余额):高清提交带 billing: own-key', async () => {
    setCustomGatewaySelected(true)
    const { container } = render(<EraseUploader />)
    expect(await dropOneVideo(container)).toMatchObject({ tool: 'enhance', billing: 'own-key' })
    expect(useQuotaStore.getState().billingSource).toBe('platform')
  })
})
