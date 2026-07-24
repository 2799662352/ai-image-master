/**
 * FileExplorerPanel「只收中间查看器」交互:
 *  - header 新增 fx-viewer-collapse-button,点击只隐藏中间查看器列,
 *    左侧文件树保持可见可交互;
 *  - 查看器列 invisible + pointer-events-none(保尺寸,canvas keep-alive
 *    约束:绝不卸载 ViewerHost/tldraw);
 *  - 容器变透明且不吃鼠标(底下经典界面在中间区域可点),树列/头部
 *    pointer-events-auto 恢复交互;
 *  - 与整栏收起(fx-collapse-button)互不干扰,整栏收起优先;
 *  - 再点同一按钮恢复。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorerPanel } from '../FileExplorerPanel'
import { useFileExplorerStore, __resetSubscriptionsForTesting } from '../store'

const electronAPI = {
  agent: { setAllowedRoots: vi.fn() },
  fs: {
    readText: vi.fn(),
    writeText: vi.fn(),
    listDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn(),
    pickFolder: vi.fn(),
    watchStart: vi.fn(),
    watchStop: vi.fn(),
    onWatchEvent: vi.fn(() => () => undefined),
  },
  attachments: {
    listTree: vi.fn().mockResolvedValue([]),
    onChanged: vi.fn(() => () => undefined),
  },
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: electronAPI, configurable: true })
  localStorage.clear()
  __resetSubscriptionsForTesting()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
  useFileExplorerStore.setState({ fxOpen: true } as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function root(): HTMLElement {
  return document.querySelector('[data-file-explorer-root="true"]') as HTMLElement
}

describe('FileExplorerPanel 只收查看器', () => {
  it('展开态:显示只收查看器按钮,查看器列可见', () => {
    render(<FileExplorerPanel rightOffset={420} />)
    expect(screen.getByTestId('fx-viewer-collapse-button')).toBeTruthy()
    expect(root().getAttribute('data-viewer-collapsed')).toBe('false')
    const col = screen.getByTestId('fx-viewer-column')
    expect(col.className).not.toContain('invisible')
  })

  it('点只收查看器:中间列 invisible 保挂载,容器透明不吃鼠标,树列恢复交互', () => {
    render(<FileExplorerPanel rightOffset={420} />)
    fireEvent.click(screen.getByTestId('fx-viewer-collapse-button'))

    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(true)
    const r = root()
    expect(r.getAttribute('data-viewer-collapsed')).toBe('true')
    // 面板本体不滑出(与整栏收起不同):无 transform、aria-hidden 为 false
    expect(r.style.transform).toBe('')
    expect(r.getAttribute('aria-hidden')).toBe('false')
    // 容器不吃鼠标 + 透明
    expect(r.className).toContain('pointer-events-none')
    expect(r.className).toContain('bg-transparent')
    // 查看器列保持挂载但 invisible(canvas keep-alive)
    const col = screen.getByTestId('fx-viewer-column')
    expect(col).toBeTruthy()
    expect(col.className).toContain('invisible')
    expect(col.className).toContain('pointer-events-none')
    expect(col.getAttribute('aria-hidden')).toBe('true')
  })

  it('再点同一按钮恢复查看器', () => {
    useFileExplorerStore.setState({ fxViewerCollapsed: true } as never)
    render(<FileExplorerPanel rightOffset={420} />)
    fireEvent.click(screen.getByTestId('fx-viewer-collapse-button'))

    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)
    expect(root().getAttribute('data-viewer-collapsed')).toBe('false')
    expect(screen.getByTestId('fx-viewer-column').className).not.toContain('invisible')
  })

  it('查看器收起时文件树快捷键仍工作(F2 触发重命名事件)', () => {
    useFileExplorerStore.setState({ fxViewerCollapsed: true, selectedPaths: ['D:/a.txt'] } as never)
    render(<FileExplorerPanel rightOffset={420} />)
    const spy = vi.fn()
    window.addEventListener('file-explorer:rename-request', spy)
    fireEvent.keyDown(window, { key: 'F2' })
    window.removeEventListener('file-explorer:rename-request', spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('整栏收起优先:两个标记同时为 true 时走整栏收起样式(滑出+把手)', () => {
    useFileExplorerStore.setState({ fxCollapsed: true, fxViewerCollapsed: true } as never)
    render(<FileExplorerPanel rightOffset={420} />)
    const r = root()
    expect(r.style.transform).toBe('translateX(-100%)')
    expect(r.getAttribute('data-viewer-collapsed')).toBe('false')
    expect(screen.getByTestId('fx-collapsed-handle')).toBeTruthy()
  })
})
