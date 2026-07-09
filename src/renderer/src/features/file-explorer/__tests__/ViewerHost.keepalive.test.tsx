import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { ViewerHost } from '../FileExplorerPanel'
import { useFileExplorerStore } from '../store'
import type { FileTab } from '../types'

// tldraw is far too heavy for jsdom — the keep-alive contract only cares about
// WHEN CanvasSection is mounted/hidden, not what it renders.
vi.mock('../../agent-workspace/CanvasSection', () => ({
  CanvasSection: () => <div data-testid="canvas-section" />,
}))
// ImageViewer touches electronAPI/blob plumbing on mount; stub it.
vi.mock('../ImageViewer', () => ({
  ImageViewer: () => <div data-testid="image-viewer" />,
}))

function tab(partial: Partial<FileTab> & Pick<FileTab, 'id' | 'kind'>): FileTab {
  return {
    path: '',
    name: partial.kind === 'canvas' ? 'Canvas' : 'file',
    source: 'workspace',
    state: null,
    diskContent: '',
    diskMtime: 0,
    dirty: false,
    ...partial,
  } as FileTab
}

beforeEach(() => {
  cleanup()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

describe('ViewerHost canvas keep-alive', () => {
  it('keeps CanvasSection MOUNTED (hidden) while another tab is active', () => {
    useFileExplorerStore.setState({
      tabs: [
        tab({ id: 'c1', kind: 'canvas' }),
        tab({ id: 'i1', kind: 'image', path: 'D:/a.png', name: 'a.png' }),
      ],
      activeTabId: 'i1',
    })
    render(<ViewerHost />)
    // Both are in the DOM: the image viewer visibly, the canvas as an inert layer.
    expect(screen.getByTestId('image-viewer')).toBeTruthy()
    expect(screen.getByTestId('canvas-section')).toBeTruthy()
    const layer = screen.getByTestId('canvas-keepalive')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.className).toContain('invisible')
    expect(layer.className).toContain('pointer-events-none')
  })

  it('shows the canvas layer when the canvas tab is active', () => {
    useFileExplorerStore.setState({
      tabs: [tab({ id: 'c1', kind: 'canvas' })],
      activeTabId: 'c1',
    })
    render(<ViewerHost />)
    const layer = screen.getByTestId('canvas-keepalive')
    expect(layer.getAttribute('aria-hidden')).toBe('false')
    expect(layer.className).not.toContain('invisible')
  })

  it('unmounts CanvasSection only when the canvas tab is CLOSED', () => {
    useFileExplorerStore.setState({
      tabs: [
        tab({ id: 'c1', kind: 'canvas' }),
        tab({ id: 'i1', kind: 'image', path: 'D:/a.png', name: 'a.png' }),
      ],
      activeTabId: 'i1',
    })
    render(<ViewerHost />)
    expect(screen.getByTestId('canvas-section')).toBeTruthy()
    // Close the canvas tab → keep-alive layer goes away.
    act(() => {
      useFileExplorerStore.setState({
        tabs: [tab({ id: 'i1', kind: 'image', path: 'D:/a.png', name: 'a.png' })],
        activeTabId: 'i1',
      })
    })
    expect(screen.queryByTestId('canvas-section')).toBeNull()
  })

  it('renders the empty state when there are no tabs at all', () => {
    render(<ViewerHost />)
    expect(screen.getByText('Open a file to begin')).toBeTruthy()
    expect(screen.queryByTestId('canvas-section')).toBeNull()
  })
})
