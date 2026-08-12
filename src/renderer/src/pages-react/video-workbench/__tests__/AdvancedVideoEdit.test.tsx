// 「高级编辑」入口门槛 + 弹层壳的单测。
//
// 入口这条最值得钉:它只在「2.5 + 编辑视频 + 有视频素材」三者同时成立时才该出现。
// 少一个条件就点不出有意义的结果 —— 摆一个点了才报错的按钮,比不摆更糟。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'
import { AdvancedVideoEditModal } from '../AdvancedVideoEditModal'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

type CardPatch = Parameters<ReturnType<typeof useVideoWorkbenchStore.getState>['addCards']>[0][number]

/** 造一张卡并铺到页面上。 */
function renderCardWith(patch: CardPatch): void {
  useVideoWorkbenchStore.getState().addCards([{ prompt: '改一下这个镜头', ...patch }])
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
}

describe('高级编辑入口门槛', () => {
  it('2.5 + 编辑视频 + 有视频素材 → 出现入口', async () => {
    renderCardWith({
      model: '2.5',
      mode: 'edit_video',
      referenceVideos: [{ name: 'a.mp4', src: 'https://cdn/a.mp4' }],
    })
    expect(await screen.findByTestId('vw-advanced-edit-open')).toBeTruthy()
  })

  it('模型不是 2.5 → 不出现(edit_video 本来就只有 2.5 支持)', async () => {
    renderCardWith({
      model: '2.0',
      mode: 'edit_video',
      referenceVideos: [{ name: 'a.mp4', src: 'https://cdn/a.mp4' }],
    })
    await screen.findByLabelText('生成模式')
    expect(screen.queryByTestId('vw-advanced-edit-open')).toBeNull()
  })

  it('模式不是编辑视频 → 不出现', async () => {
    renderCardWith({
      model: '2.5',
      mode: 'multimodal_ref',
      referenceVideos: [{ name: 'a.mp4', src: 'https://cdn/a.mp4' }],
    })
    await screen.findByLabelText('生成模式')
    expect(screen.queryByTestId('vw-advanced-edit-open')).toBeNull()
  })

  it('没有视频素材 → 不出现,而不是点开一个空弹层', async () => {
    renderCardWith({ model: '2.5', mode: 'edit_video', referenceVideos: [] })
    await screen.findByLabelText('生成模式')
    expect(screen.queryByTestId('vw-advanced-edit-open')).toBeNull()
  })
})

describe('AdvancedVideoEditModal', () => {
  const noop = () => {}

  it('open=false 不渲染', () => {
    render(<AdvancedVideoEditModal open={false} videoSrc="blob:x" onClose={noop} onApply={noop} />)
    expect(screen.queryByTestId('vw-advanced-edit')).toBeNull()
  })

  it('挂到 document.body,不留在调用方子树里(卡片上的 transform 会裁掉 fixed)', () => {
    const { container } = render(
      <div style={{ transform: 'translateZ(0)' }}>
        <AdvancedVideoEditModal open videoSrc="blob:x" onClose={noop} onApply={noop} />
      </div>,
    )
    const panel = screen.getByTestId('vw-advanced-edit')
    expect(container.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
  })

  it('一帧都没加时「保存到卡片」禁用 —— 没有可回填的东西', () => {
    render(<AdvancedVideoEditModal open videoSrc="blob:x" onClose={noop} onApply={noop} />)
    const save = screen.getByRole('button', { name: '保存到卡片' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('工具可切换,再点一次取消选中 —— 不选工具时画面可以正常播放', () => {
    render(<AdvancedVideoEditModal open videoSrc="blob:x" onClose={noop} onApply={noop} />)
    const rect = screen.getByRole('button', { name: '矩形' })
    expect(rect.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(rect)
    expect(rect.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(rect)
    expect(rect.getAttribute('aria-pressed')).toBe('false')
  })

  it('Esc 关闭弹层', () => {
    const onClose = vi.fn()
    render(<AdvancedVideoEditModal open videoSrc="blob:x" onClose={onClose} onApply={noop} />)
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('没有标注就点「添加这一帧」→ 提示先标注,不产出空帧', async () => {
    const { useToastStore } = await import('../../../stores/useToastStore')
    useToastStore.setState({ toasts: [] })
    render(<AdvancedVideoEditModal open videoSrc="blob:x" onClose={noop} onApply={noop} />)
    await act(async () => {
      screen.getByRole('button', { name: /添加这一帧/ }).click()
    })
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('先在画面上标注'))).toBe(true)
  })
})
