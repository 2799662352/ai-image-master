import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { FileTabStrip } from '../FileTabStrip'
import { useFileExplorerStore } from '../store'

beforeEach(() => {
  cleanup()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

describe('FileTabStrip', () => {
  it('renders one pill per tab and marks active', () => {
    useFileExplorerStore.setState({
      tabs: [
        { id: 't1', path: 'D:/a.ts', name: 'a.ts', source: 'workspace', kind: 'text', state: null, diskContent: '', diskMtime: 0, dirty: false },
        { id: 't2', path: 'D:/b.ts', name: 'b.ts', source: 'workspace', kind: 'text', state: null, diskContent: '', diskMtime: 0, dirty: true },
      ],
      activeTabId: 't2',
    })
    render(<FileTabStrip />)
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.getByTestId('tab-t2').getAttribute('data-active')).toBe('true')
  })

  it('shows dirty dot when dirty', () => {
    useFileExplorerStore.setState({
      tabs: [{ id: 't1', path: 'D:/x.ts', name: 'x.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'a', diskMtime: 0, dirty: true }],
      activeTabId: 't1',
    })
    render(<FileTabStrip />)
    expect(screen.getByTestId('tab-t1-dirty')).toBeTruthy()
  })

  it('clicking close removes tab', () => {
    useFileExplorerStore.setState({
      tabs: [{ id: 't1', path: 'D:/x.ts', name: 'x.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'a', diskMtime: 0, dirty: false }],
      activeTabId: 't1',
    })
    render(<FileTabStrip />)
    fireEvent.click(screen.getByLabelText('Close x.ts'))
    expect(useFileExplorerStore.getState().tabs.length).toBe(0)
  })

  it('asks before closing a dirty tab', async () => {
    const closeTab = vi.fn().mockResolvedValue(true)
    useFileExplorerStore.setState({
      tabs: [{ id: 't1', path: 'D:/x.ts', name: 'x.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'a', diskMtime: 0, dirty: true }],
      activeTabId: 't1',
      closeTab,
    })
    render(<FileTabStrip />)

    fireEvent.click(screen.getByLabelText('Close x.ts'))

    expect(screen.getByRole('dialog', { name: 'Save changes to x.ts?' })).toBeTruthy()
    expect(closeTab).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('can close a dirty tab by saving or discarding from the prompt', async () => {
    const closeTab = vi.fn().mockResolvedValue(true)
    useFileExplorerStore.setState({
      tabs: [{ id: 't1', path: 'D:/x.ts', name: 'x.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'a', diskMtime: 0, dirty: true }],
      activeTabId: 't1',
      closeTab,
    })
    render(<FileTabStrip />)

    fireEvent.click(screen.getByLabelText('Close x.ts'))
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Save'))
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith('t1', { saveDirty: true }))

    fireEvent.click(screen.getByLabelText('Close x.ts'))
    fireEvent.click(within(screen.getByRole('dialog')).getByText("Don't Save"))
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith('t1', { saveDirty: false }))
  })

  it('shows an explicit save button for dirty tabs', async () => {
    const saveTab = vi.fn().mockResolvedValue(undefined)
    useFileExplorerStore.setState({
      tabs: [{ id: 't1', path: 'D:/x.ts', name: 'x.ts', source: 'workspace', kind: 'text', state: null, diskContent: 'a', diskMtime: 0, dirty: true }],
      activeTabId: 't1',
      saveTab,
    })
    render(<FileTabStrip />)
    fireEvent.click(screen.getByLabelText('Save x.ts'))
    expect(saveTab).toHaveBeenCalledWith('t1')
  })
})
