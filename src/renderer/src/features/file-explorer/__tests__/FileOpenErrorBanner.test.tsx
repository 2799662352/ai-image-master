// 「打不开」提示条。回归的是一个**既有**的静默失败:openTab 撞到 fs:stat 失败
// 时直接 return,而调用方 revealPath 已经把面板打开、把路径选中了 —— 用户看到
// 面板弹出来然后什么都没发生,和「链接点了没反应」在感知上是同一件事。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileOpenErrorBanner, describeOpenError } from '../FileOpenErrorBanner'
import { useFileExplorerStore } from '../store'

afterEach(cleanup)

beforeEach(() => {
  useFileExplorerStore.setState({ openError: null })
})

describe('describeOpenError', () => {
  it('把 fs:stat 的开发者字符串翻成人话', () => {
    expect(describeOpenError('Error: ENOENT: no such file or directory')).toBe(
      '文件不存在,可能已被移动或删除',
    )
    expect(describeOpenError('Error: fs path outside allowed roots')).toBe(
      '这个位置不在允许打开的目录里',
    )
    expect(describeOpenError('not a file')).toBe('这是一个文件夹,不是文件')
  })

  it('认不出来的原因也给一句能看懂的兜底', () => {
    expect(describeOpenError('EPERM: operation not permitted')).toBe('打不开这个文件')
  })
})

describe('FileOpenErrorBanner', () => {
  it('没有错误时不占位置', () => {
    const { container } = render(<FileOpenErrorBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('显示文件名与原因', () => {
    useFileExplorerStore.setState({
      openError: { path: 'D:\\proj\\src\\gone.ts', reason: 'Error: ENOENT', token: 1 },
    })
    render(<FileOpenErrorBanner />)
    const banner = screen.getByTestId('file-open-error')
    expect(banner.textContent).toContain('gone.ts')
    expect(banner.textContent).toContain('文件不存在')
  })

  it('可以手动关掉', () => {
    useFileExplorerStore.setState({
      openError: { path: 'D:\\proj\\gone.ts', reason: 'Error: ENOENT', token: 1 },
    })
    render(<FileOpenErrorBanner />)
    fireEvent.click(screen.getByLabelText('关闭提示'))
    expect(useFileExplorerStore.getState().openError).toBeNull()
  })

  it('过一会儿自动消失', () => {
    vi.useFakeTimers()
    try {
      useFileExplorerStore.setState({
        openError: { path: 'D:\\proj\\gone.ts', reason: 'Error: ENOENT', token: 1 },
      })
      render(<FileOpenErrorBanner />)
      expect(screen.getByTestId('file-open-error')).toBeTruthy()
      vi.advanceTimersByTime(8000)
      expect(useFileExplorerStore.getState().openError).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('openTab 打不开时不再静默', () => {
  it('stat 失败会写进 openError 而不是一声不吭地返回', async () => {
    const stat = vi.fn(async () => ({ ok: false, reason: 'Error: ENOENT' }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      fs: { stat, readText: vi.fn(), watchStart: vi.fn() },
    }
    useFileExplorerStore.setState({ tabs: [], activeTabId: null, openError: null })

    await useFileExplorerStore.getState().openTab('D:\\proj\\gone.ts', 'workspace')

    const err = useFileExplorerStore.getState().openError
    expect(err?.path).toBe('D:\\proj\\gone.ts')
    expect(err?.reason).toContain('ENOENT')
    expect(useFileExplorerStore.getState().tabs).toHaveLength(0)
  })
})
