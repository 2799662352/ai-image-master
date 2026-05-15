import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FileTree } from '../FileTree'
import { useFileExplorerStore, __resetSubscriptionsForTesting } from '../store'

const electronAPI = {
  fs: {
    listDir: vi.fn(),
    readText: vi.fn(),
    writeText: vi.fn(),
    stat: vi.fn(),
    pickFolder: vi.fn(),
    watchStart: vi.fn(),
    watchStop: vi.fn(),
    onWatchEvent: vi.fn(() => () => undefined),
  },
  attachments: {
    listTree: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
  },
}

beforeEach(() => {
  cleanup()
  Object.defineProperty(window, 'electronAPI', {
    value: electronAPI,
    configurable: true,
  })
  electronAPI.attachments.listTree.mockReset().mockResolvedValue([])
  electronAPI.attachments.onChanged.mockClear()
  electronAPI.fs.pickFolder.mockReset()
  electronAPI.fs.listDir.mockReset()
  __resetSubscriptionsForTesting()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

describe('FileTree', () => {
  it('shows empty state when no workspace', async () => {
    render(<FileTree />)
    expect(await screen.findByText(/No folder open/i)).toBeTruthy()
    expect(screen.getByText(/Open folder…/i)).toBeTruthy()
  })

  it('clicking Open folder picks and renders root', async () => {
    electronAPI.fs.pickFolder.mockResolvedValue('D:/proj')
    electronAPI.fs.listDir.mockResolvedValue([
      { path: 'D:/proj/src', name: 'src', kind: 'dir', source: 'workspace', childrenLoaded: false },
      { path: 'D:/proj/README.md', name: 'README.md', kind: 'file', source: 'workspace', childrenLoaded: false },
    ])
    render(<FileTree />)
    fireEvent.click(await screen.findByText(/Open folder…/i))
    expect(await screen.findByText('proj')).toBeTruthy()
  })

  it('renders an add-folder action and can remove workspace roots', async () => {
    useFileExplorerStore.setState({
      workspaceRoot: 'D:/proj',
      workspaceTree: [
        { path: 'D:/proj', name: 'proj', kind: 'dir', source: 'workspace', childrenLoaded: true, children: [] },
      ],
    })

    render(<FileTree />)

    expect(screen.getByText(/Add folder…/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove folder proj'))
    expect(useFileExplorerStore.getState().workspaceTree).toEqual([])
  })
})
