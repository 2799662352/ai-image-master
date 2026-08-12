// MaterialStack 素材点击预览单测:单击弹 MaterialPreviewModal(图片大图 /
// 视频播放 / 音频播放),Esc / 遮罩关闭;与拖拽换位共存(拖动排序不误开
// 预览);删除 ✕ 不触发预览。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'
import { resetAssetPreviewCacheForTest } from '../../../features/video-workbench/assetPreview'
import { MaterialStack } from '../MaterialStack'

const readThumb = vi.fn()
const readMediaThumb = vi.fn()

beforeEach(() => {
  readThumb.mockReset()
  readMediaThumb.mockReset()
  resetAssetPreviewCacheForTest()
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readThumb, readMediaThumb },
  }
  let n = 0
  ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    `blob:stub-${++n}`
  ;(globalThis.URL as unknown as { revokeObjectURL: (s: string) => void }).revokeObjectURL = () => {}
})

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
})

function renderStack(kind: 'image' | 'video' | 'audio', materials: VideoWorkbenchMaterial[]) {
  const onReorder = vi.fn()
  const onRemove = vi.fn()
  render(
    <MaterialStack
      kind={kind}
      label="素材"
      accept="*/*"
      materials={materials}
      limit={9}
      onAdd={vi.fn()}
      onRemove={onRemove}
      onReorder={onReorder}
    />,
  )
  return { onReorder, onRemove }
}

/** jsdom 没有 DataTransfer:手搓一个够用的 stub(与 MaterialStack.test 同款)。 */
function makeDataTransfer() {
  const data: Record<string, string> = {}
  return {
    get types() {
      return Object.keys(data)
    },
    effectAllowed: '',
    dropEffect: '',
    setData(t: string, v: string) {
      data[t] = v
    },
    getData(t: string) {
      return data[t] ?? ''
    },
  } as never
}

function fireDrag(el: HTMLElement, type: 'dragstart' | 'dragend', dt: ReturnType<typeof makeDataTransfer>) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  fireEvent(el, ev)
}

describe('MaterialStack 点击预览', () => {
  it('图片:单击弹大图预览(data: 直通),Esc 关闭', async () => {
    renderStack('image', [{ name: '猫.png', src: 'data:image/png;base64,AAA' }])
    fireEvent.click(screen.getByTestId('vw-stack-item-image-0'))
    const dialog = await screen.findByTestId('vw-material-preview')
    expect(dialog.getAttribute('role')).toBe('dialog')
    await waitFor(() => {
      const imgs = dialog.querySelectorAll('img')
      expect([...imgs].some((i) => i.getAttribute('src') === 'data:image/png;base64,AAA')).toBe(true)
    })
    expect(dialog.textContent).toContain('猫.png')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('vw-material-preview')).toBeNull()
  })

  it('视频:单击弹播放 modal(https 直通 <video>),点遮罩关闭', async () => {
    renderStack('video', [{ name: 'clip.mp4', src: 'https://cos/clip.mp4' }])
    fireEvent.click(screen.getByTestId('vw-stack-item-video-0'))
    const dialog = await screen.findByTestId('vw-material-preview')
    const video = dialog.querySelector('video')
    expect(video?.getAttribute('src')).toBe('https://cos/clip.mp4')
    expect(video?.hasAttribute('controls')).toBe(true)
    fireEvent.click(dialog) // 遮罩本体
    expect(screen.queryByTestId('vw-material-preview')).toBeNull()
  })

  // 本地音视频改走流式协议(local-file://media/?p=…):按 Range 分段读盘,
  // 整份文件不进渲染进程内存,长音频/大视频也能拖进度条。
  it('音频:本地路径喂流式地址,不再读字节转 blob:', async () => {
    const localPath = 'D:\\audio\\配乐.mp3'
    renderStack('audio', [{ name: '配乐.mp3', src: localPath }])
    fireEvent.click(screen.getByTestId('vw-stack-item-audio-0'))
    const dialog = await screen.findByTestId('vw-material-preview')

    const audio = dialog.querySelector('audio')!
    const src = audio.getAttribute('src') ?? ''
    expect(src.startsWith('local-file://media/?p=')).toBe(true)
    expect(decodeURIComponent(new URL(src).searchParams.get('p') ?? '')).toBe(localPath)
    expect(audio.hasAttribute('controls')).toBe(true)
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('视频:同一条流式地址,一个字节都不经 IPC', async () => {
    const localPath = 'D:\\clips\\hero.mp4'
    renderStack('video', [{ name: 'hero.mp4', src: localPath }])
    fireEvent.click(screen.getByTestId('vw-stack-item-video-0'))
    const dialog = await screen.findByTestId('vw-material-preview')

    const src = dialog.querySelector('video')?.getAttribute('src') ?? ''
    expect(decodeURIComponent(new URL(src).searchParams.get('p') ?? '')).toBe(localPath)
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('拖拽排序不误开预览:dragstart 后 click 被抑制,dragend 后恢复', async () => {
    renderStack('image', [
      { name: 'a.png', src: 'data:image/png;base64,AAA' },
      { name: 'b.png', src: 'data:image/png;base64,BBB' },
    ])
    const item = screen.getByTestId('vw-stack-item-image-0')
    const dt = makeDataTransfer()
    fireDrag(item, 'dragstart', dt)
    fireEvent.click(item)
    expect(screen.queryByTestId('vw-material-preview')).toBeNull()
    fireDrag(item, 'dragend', dt)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(item)
    expect(await screen.findByTestId('vw-material-preview')).toBeTruthy()
  })

  it('点删除 ✕ 只删素材,不开预览', () => {
    const { onRemove } = renderStack('image', [{ name: 'a.png', src: 'data:image/png;base64,AAA' }])
    fireEvent.click(screen.getByLabelText('移除 a.png'))
    expect(onRemove).toHaveBeenCalledWith(0)
    expect(screen.queryByTestId('vw-material-preview')).toBeNull()
  })

  it('asset:// 视频素材:提示云端素材无法本地播放(previewUrl 缩略兜底)', async () => {
    renderStack('video', [
      { name: '库素材', src: 'asset://a1', previewUrl: 'https://cdn/a1.jpg' },
    ])
    fireEvent.click(screen.getByTestId('vw-stack-item-video-0'))
    const dialog = await screen.findByTestId('vw-material-preview')
    expect(dialog.textContent).toContain('无法本地播放')
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('https://cdn/a1.jpg')
  })
})
