// 预传状态在界面上的唯一出口。
//
// 为什么这组测试值得存在:上传走**主进程**(Node 侧 net.fetch / COS SDK),不经
// Chromium 网络栈,所以 DevTools 的 Network 面板里根本看不到——用户没有任何别的
// 办法判断「这张图传完没有」。角标坏了不会有报错,只会静悄悄地不出现。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'
import { MaterialStack } from '../MaterialStack'

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/a.png'

function renderStack(materials: VideoWorkbenchMaterial[]) {
  return render(
    <MaterialStack
      kind="image"
      label="参考图"
      materials={materials}
      limit={9}
      accept="image/*"
      onAdd={() => {}}
      onRemove={() => {}}
      // 父层接管解析,避免缩略图各自走 IPC(jsdom 里没有那条桥)。
      thumbSrcs={materials.map(() => undefined)}
    />,
  )
}

let openExternal: ReturnType<typeof vi.fn>
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  openExternal = vi.fn(async () => undefined)
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { shell: { openExternal } }
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  // 这个套件没开自动清理:不手动 unmount 的话上一条用例的 DOM 会留下,
  // 下一条按 testid 取元素就撞「Found multiple elements」。
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe('素材预传状态角标', () => {
  it('uploading 出转圈,uploaded 出打勾,failed 出感叹号', () => {
    renderStack([
      { name: 'a', src: 'D:\\a.png', uploadState: 'uploading' },
      { name: 'b', src: 'D:\\b.png', uploadState: 'uploaded', uploadedUrl: COS },
      { name: 'c', src: 'D:\\c.png', uploadState: 'failed' },
    ])
    expect(screen.getByTestId('vw-upload-uploading')).toBeTruthy()
    expect(screen.getByTestId('vw-upload-uploaded').textContent).toBe('✓')
    expect(screen.getByTestId('vw-upload-failed').textContent).toBe('!')
  })

  it('没有 uploadState 的素材不画角标 —— https/asset 这类本来就不用传', () => {
    const { container } = renderStack([{ name: 'u', src: 'https://cdn/x.png' }])
    expect(container.querySelector('.vw-stack-upload')).toBeNull()
  })

  it('悬停提示带上云端地址,传输中/失败时说明状态', () => {
    renderStack([
      { name: 'b.png', src: 'D:\\b.png', uploadState: 'uploaded', uploadedUrl: COS },
      { name: 'a.png', src: 'D:\\a.png', uploadState: 'uploading' },
    ])
    expect(screen.getByTestId('vw-stack-item-image-0').getAttribute('title')).toBe(`b.png\n${COS}`)
    expect(screen.getByTestId('vw-stack-item-image-1').getAttribute('title')).toContain('正在上传')
  })
})

describe('素材右键菜单', () => {
  it('有云端地址才出菜单,复制链接写进剪贴板', async () => {
    renderStack([{ name: 'b', src: 'D:\\b.png', uploadState: 'uploaded', uploadedUrl: COS }])

    fireEvent.contextMenu(screen.getByTestId('vw-stack-item-image-0'))
    fireEvent.click(screen.getByText('复制链接'))

    expect(writeText).toHaveBeenCalledWith(COS)
  })

  it('「在浏览器中打开」走 shell 桥,不是 window.open', () => {
    renderStack([{ name: 'b', src: 'D:\\b.png', uploadState: 'uploaded', uploadedUrl: COS }])

    fireEvent.contextMenu(screen.getByTestId('vw-stack-item-image-0'))
    fireEvent.click(screen.getByText('在浏览器中打开'))

    expect(openExternal).toHaveBeenCalledWith(COS)
  })

  it('还没传完的素材不拦右键 —— 没有可复制的东西就让原生菜单照常出', () => {
    renderStack([{ name: 'a', src: 'D:\\a.png', uploadState: 'uploading' }])

    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByTestId('vw-stack-item-image-0').dispatchEvent(evt)

    // 没有 preventDefault = 原生菜单会出来，这正是我们要的降级。
    expect(evt.defaultPrevented).toBe(false)
    expect(screen.queryByTestId('vw-material-menu')).toBeNull()
  })

  it('按 Escape 关掉菜单', () => {
    renderStack([{ name: 'b', src: 'D:\\b.png', uploadState: 'uploaded', uploadedUrl: COS }])

    fireEvent.contextMenu(screen.getByTestId('vw-stack-item-image-0'))
    expect(screen.getByTestId('vw-material-menu')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('vw-material-menu')).toBeNull()
  })
})
