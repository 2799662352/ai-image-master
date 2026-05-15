import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ConflictModal } from '../ConflictModal'
import { useFileExplorerStore } from '../store'

beforeEach(() => {
  cleanup()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

describe('ConflictModal', () => {
  it('renders when conflict is set', () => {
    useFileExplorerStore.setState({
      conflict: { tabId: 't1', diskContent: 'disk', show: 'modal' },
      tabs: [{ id: 't1', path: 'D:/a.ts', name: 'a.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'mine', diskMtime: 0, dirty: true }],
      activeTabId: 't1',
    })
    render(<ConflictModal />)
    expect(screen.getByText(/changed on disk/i)).toBeTruthy()
  })

  it('Use disk button replaces content and clears conflict', () => {
    useFileExplorerStore.setState({
      conflict: { tabId: 't1', diskContent: 'fromDisk', show: 'modal' },
      tabs: [{ id: 't1', path: 'D:/a.ts', name: 'a.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'mine', diskMtime: 0, dirty: true }],
      activeTabId: 't1',
    })
    render(<ConflictModal />)
    fireEvent.click(screen.getByRole('button', { name: /use disk/i }))
    const s = useFileExplorerStore.getState()
    expect(s.conflict).toBeNull()
    expect(s.tabs[0].diskContent).toBe('fromDisk')
    expect(s.tabs[0].dirty).toBe(false)
  })

  it('Keep yours just dismisses', () => {
    useFileExplorerStore.setState({
      conflict: { tabId: 't1', diskContent: 'fromDisk', show: 'modal' },
      tabs: [{ id: 't1', path: 'D:/a.ts', name: 'a.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'mine', diskMtime: 0, dirty: true }],
      activeTabId: 't1',
    })
    render(<ConflictModal />)
    fireEvent.click(screen.getByRole('button', { name: /keep yours/i }))
    const s = useFileExplorerStore.getState()
    expect(s.conflict).toBeNull()
    expect(s.tabs[0].diskContent).toBe('mine')
  })
})
