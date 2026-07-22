// 工作台顶部「默认上传人像库」全局开关单测:渲染态、点击切换、localStorage 持久化。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AUTO_IMPORT_PORTRAIT_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

beforeEach(() => {
  localStorage.removeItem(AUTO_IMPORT_PORTRAIT_KEY)
  resetWorkbenchStoreForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('「默认上传人像库」全局开关', () => {
  it('默认关闭(aria-pressed=false);点击开启并写 localStorage;再点关闭', async () => {
    render(<VideoWorkbenchPage />)
    const toggle = await screen.findByRole('button', { name: /默认上传人像库/ })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'))
    expect(useVideoWorkbenchStore.getState().autoImportPortrait).toBe(true)
    expect(localStorage.getItem(AUTO_IMPORT_PORTRAIT_KEY)).toBe('1')

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'))
    expect(localStorage.getItem(AUTO_IMPORT_PORTRAIT_KEY)).toBe('0')
  })
})
