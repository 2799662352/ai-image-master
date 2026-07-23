/**
 * FileExplorerPanel 收起交互:
 *  - header「收起」按钮 → 面板保持挂载(canvas keep-alive 约束,不能卸载
 *    ViewerHost/tldraw),用 CSS(translateX(-100%) + visibility:hidden +
 *    pointer-events-none)滑出;
 *  - 收起后左边缘出现细长竖条把手,点击重新展开;
 *  - 收起时全局键盘快捷键(F2 等)不抢键;
 *  - X 完全关闭行为不变(卸载)。
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

describe('FileExplorerPanel 收起/展开', () => {
  it('展开态:显示收起按钮,不显示左缘把手', () => {
    render(<FileExplorerPanel rightOffset={420} />)
    expect(screen.getByRole('region', { name: 'File Explorer' })).toBeTruthy()
    expect(screen.getByTestId('fx-collapse-button')).toBeTruthy()
    expect(screen.queryByTestId('fx-collapsed-handle')).toBeNull()
  })

  it('点收起:面板保持挂载但 CSS 隐藏(translate + visibility),把手出现', () => {
    render(<FileExplorerPanel rightOffset={420} />)
    fireEvent.click(screen.getByTestId('fx-collapse-button'))

    expect(useFileExplorerStore.getState().fxCollapsed).toBe(true)
    // 面板必须仍在 DOM 里(canvas keep-alive:卸载会把 tldraw editor 置空)
    const root = document.querySelector('[data-file-explorer-root="true"]') as HTMLElement
    expect(root).toBeTruthy()
    expect(root.getAttribute('data-collapsed')).toBe('true')
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(root.style.transform).toBe('translateX(-100%)')
    expect(root.style.visibility).toBe('hidden')
    expect(root.className).toContain('pointer-events-none')

    expect(screen.getByTestId('fx-collapsed-handle')).toBeTruthy()
  })

  it('点左缘把手重新展开', () => {
    useFileExplorerStore.setState({ fxCollapsed: true } as never)
    render(<FileExplorerPanel rightOffset={420} />)
    fireEvent.click(screen.getByTestId('fx-collapsed-handle'))

    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)
    const root = document.querySelector('[data-file-explorer-root="true"]') as HTMLElement
    expect(root.getAttribute('data-collapsed')).toBe('false')
    expect(root.style.transform).toBe('')
    expect(screen.queryByTestId('fx-collapsed-handle')).toBeNull()
  })

  it('收起时全局键盘快捷键不抢键(F2 不触发重命名事件)', () => {
    useFileExplorerStore.setState({ fxCollapsed: true, selectedPaths: ['D:/a.txt'] } as never)
    render(<FileExplorerPanel rightOffset={420} />)
    const spy = vi.fn()
    window.addEventListener('file-explorer:rename-request', spy)
    fireEvent.keyDown(window, { key: 'F2' })
    window.removeEventListener('file-explorer:rename-request', spy)
    expect(spy).not.toHaveBeenCalled()
  })

  it('展开时 F2 照常触发重命名事件(现有行为不回归)', () => {
    useFileExplorerStore.setState({ selectedPaths: ['D:/a.txt'] } as never)
    render(<FileExplorerPanel rightOffset={420} />)
    const spy = vi.fn()
    window.addEventListener('file-explorer:rename-request', spy)
    fireEvent.keyDown(window, { key: 'F2' })
    window.removeEventListener('file-explorer:rename-request', spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('X 按钮仍是完全关闭:面板卸载', () => {
    render(<FileExplorerPanel rightOffset={420} />)
    fireEvent.click(screen.getByLabelText('Close file explorer'))
    expect(useFileExplorerStore.getState().fxOpen).toBe(false)
    expect(document.querySelector('[data-file-explorer-root="true"]')).toBeNull()
    expect(screen.queryByTestId('fx-collapsed-handle')).toBeNull()
  })
})
