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

/**
 * Markdown 视图切换。三档对齐 VS Code / Cursor 顶栏那个 Preview 切换:
 * 源码 / 分栏 / 预览。只有 markdown 才出这排按钮 —— 给 .ts 挂一个永远点不出
 * 有意义结果的「预览」是纯噪音。
 */
const mdTab = (overrides: Partial<FileTab> = {}): FileTab =>
  baseTab({
    id: 'md1',
    path: 'D:/notes/readme.md',
    name: 'readme.md',
    diskContent: '# 标题\n\n正文一段。',
    ...overrides,
  })

describe('FileViewer markdown 视图', () => {
  it('非 markdown 不出切换条', () => {
    const tab = baseTab()
    useFileExplorerStore.setState({ tabs: [tab], activeTabId: tab.id })
    const { queryByRole } = render(<FileViewer tab={tab} />)
    expect(queryByRole('group', { name: 'Markdown 视图' })).toBeNull()
  })

  it('markdown 出切换条,默认只看源码(不渲染预览)', () => {
    const tab = mdTab({ path: 'D:/notes/a.md' })
    useFileExplorerStore.setState({ tabs: [tab], activeTabId: tab.id })
    const { getByRole, queryByTestId } = render(<FileViewer tab={tab} />)
    expect(getByRole('group', { name: 'Markdown 视图' })).toBeTruthy()
    expect(queryByTestId('fx-md-preview-pane')).toBeNull()
  })

  it('切到预览:渲染出 HTML 标题,编辑器让位', async () => {
    const tab = mdTab({ path: 'D:/notes/b.md' })
    useFileExplorerStore.setState({ tabs: [tab], activeTabId: tab.id })
    const { getByText, findByTestId, container } = render(<FileViewer tab={tab} />)

    fireEvent.click(getByText('预览'))

    const pane = await findByTestId('fx-md-preview-pane')
    await waitFor(() => expect(pane.querySelector('h1')?.textContent).toBe('标题'))
    // 编辑器仍挂载(保住撤销栈与光标),只是不占位
    expect(container.querySelector('.cm-content')).toBeTruthy()
  })

  it('分栏:编辑器与预览同时在场', async () => {
    const tab = mdTab({ path: 'D:/notes/c.md' })
    useFileExplorerStore.setState({ tabs: [tab], activeTabId: tab.id })
    const { getByText, findByTestId, container } = render(<FileViewer tab={tab} />)

    fireEvent.click(getByText('分栏'))

    await findByTestId('fx-md-preview-pane')
    expect(container.querySelector('.cm-content')).toBeTruthy()
  })

  it('预览里的块带 data-line,滚动同步靠它对齐', async () => {
    const tab = mdTab({ path: 'D:/notes/d.md', diskContent: '# 一\n\n段落\n\n## 二' })
    useFileExplorerStore.setState({ tabs: [tab], activeTabId: tab.id })
    const { getByText, findByTestId } = render(<FileViewer tab={tab} />)

    fireEvent.click(getByText('预览'))

    const pane = await findByTestId('fx-md-preview-pane')
    await waitFor(() => {
      const lines = [...pane.querySelectorAll('[data-line]')].map((el) => (el as HTMLElement).dataset.line)
      expect(lines).toContain('1')
      expect(lines).toContain('5')
    })
  })
})
