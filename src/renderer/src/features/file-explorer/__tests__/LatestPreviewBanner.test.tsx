import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LatestPreviewBanner } from '../LatestPreviewBanner'
import { useFileExplorerStore } from '../store'
import type { FileTab } from '../types'

function makeTab(overrides: Partial<FileTab>): FileTab {
  return {
    id: 'tab-1',
    path: 'D:/repo/src/main.ts',
    name: 'main.ts',
    source: 'workspace',
    kind: 'text',
    state: null,
    diskContent: '',
    diskMtime: 0,
    dirty: false,
    ...overrides,
  }
}

beforeEach(() => {
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

afterEach(cleanup)

describe('LatestPreviewBanner', () => {
  it('renders nothing when no active tab', () => {
    render(<LatestPreviewBanner />)
    expect(screen.queryByTestId('latest-preview-banner')).toBeNull()
  })

  it('shows the active tab name and a workspace hint by default', () => {
    useFileExplorerStore.setState({
      tabs: [makeTab({})],
      activeTabId: 'tab-1',
    })
    render(<LatestPreviewBanner />)
    expect(screen.getByText('main.ts')).toBeTruthy()
    expect(screen.getByText('workspace')).toBeTruthy()
    expect(screen.getByText('text')).toBeTruthy()
  })

  it('uses a "from chat" hint when the tab source is attachments', () => {
    useFileExplorerStore.setState({
      tabs: [makeTab({ source: 'attachments', kind: 'image', name: 'cat.png' })],
      activeTabId: 'tab-1',
    })
    render(<LatestPreviewBanner />)
    expect(screen.getByText('cat.png')).toBeTruthy()
    expect(screen.getByText('from chat')).toBeTruthy()
    expect(screen.getByText('image')).toBeTruthy()
  })

  it('shows the modified flag when the tab is dirty', () => {
    useFileExplorerStore.setState({
      tabs: [makeTab({ dirty: true })],
      activeTabId: 'tab-1',
    })
    render(<LatestPreviewBanner />)
    expect(screen.getByText('modified')).toBeTruthy()
  })

  it('uses a video badge for kind=video', () => {
    useFileExplorerStore.setState({
      tabs: [makeTab({ kind: 'video', name: 'demo.mp4', path: 'D:/repo/demo.mp4' })],
      activeTabId: 'tab-1',
    })
    render(<LatestPreviewBanner />)
    expect(screen.getByText('video')).toBeTruthy()
    expect(screen.getByText('demo.mp4')).toBeTruthy()
  })

  it('clicking the banner bumps scrollActiveTabToken so the strip re-fires scrollIntoView', () => {
    useFileExplorerStore.setState({
      tabs: [makeTab({})],
      activeTabId: 'tab-1',
    })
    render(<LatestPreviewBanner />)
    const before = useFileExplorerStore.getState().scrollActiveTabToken
    fireEvent.click(screen.getByTestId('latest-preview-banner'))
    const after = useFileExplorerStore.getState().scrollActiveTabToken
    expect(after).toBe(before + 1)
  })

  it('updates when the active tab changes', () => {
    useFileExplorerStore.setState({
      tabs: [
        makeTab({ id: 't1', name: 'a.ts' }),
        makeTab({ id: 't2', name: 'b.ts' }),
      ],
      activeTabId: 't1',
    })
    const { rerender } = render(<LatestPreviewBanner />)
    expect(screen.getByText('a.ts')).toBeTruthy()

    useFileExplorerStore.setState({ activeTabId: 't2' })
    rerender(<LatestPreviewBanner />)
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.queryByText('a.ts')).toBeNull()
  })
})
