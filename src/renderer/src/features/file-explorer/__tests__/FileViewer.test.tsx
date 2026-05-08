import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { FileViewer } from '../FileViewer'
import { useFileExplorerStore } from '../store'
import type { FileTab } from '../types'

const baseTab = (overrides: Partial<FileTab> = {}): FileTab => ({
  id: 't1',
  path: 'D:/a.ts',
  name: 'a.ts',
  source: 'workspace',
  kind: 'text',
  state: null,
  diskContent: 'hello',
  diskMtime: 0,
  dirty: false,
  ...overrides,
})

const electronAPI = {
  fs: {
    readText: vi.fn(),
    writeText: vi.fn().mockResolvedValue({ mtime: 99 }),
    listDir: vi.fn(),
    stat: vi.fn(),
    pickFolder: vi.fn(),
    watchStart: vi.fn(),
    watchStop: vi.fn(),
    onWatchEvent: vi.fn(() => () => undefined),
  },
  attachments: { listTree: vi.fn() },
}

beforeEach(() => {
  cleanup()
  Object.defineProperty(window, 'electronAPI', {
    value: electronAPI,
    configurable: true,
  })
  electronAPI.fs.writeText.mockClear().mockResolvedValue({ mtime: 99 })
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

describe('FileViewer', () => {
  it('renders the disk content', async () => {
    const tab = baseTab()
    useFileExplorerStore.setState({ tabs: [tab], activeTabId: tab.id })
    const { container } = render(<FileViewer tab={tab} />)
    await waitFor(() => expect(container.textContent).toContain('hello'))
  })

  it('Cmd+S calls saveActiveTab -> writeText', async () => {
    const tab = baseTab({ state: EditorState.create({ doc: 'edited' }), dirty: true })
    useFileExplorerStore.setState({ tabs: [tab], activeTabId: tab.id })
    const { container } = render(<FileViewer tab={tab} />)
    const editor = container.querySelector('.cm-content')!
    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true })
    await waitFor(() => expect(electronAPI.fs.writeText).toHaveBeenCalledWith('D:/a.ts', 'edited'))
  })
})
