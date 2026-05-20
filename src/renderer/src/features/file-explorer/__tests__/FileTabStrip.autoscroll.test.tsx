import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { FileTabStrip } from '../FileTabStrip'
import { useFileExplorerStore } from '../store'

const tabs = [
  { id: 't1', path: 'D:/repo/a.ts', name: 'a.ts', source: 'workspace' as const, kind: 'text' as const, state: null, diskContent: '', diskMtime: 0, dirty: false },
  { id: 't2', path: 'D:/repo/b.ts', name: 'b.ts', source: 'workspace' as const, kind: 'text' as const, state: null, diskContent: '', diskMtime: 0, dirty: false },
]

beforeEach(() => {
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
  useFileExplorerStore.setState({ tabs, activeTabId: 't1' })
  // jsdom doesn't ship scrollIntoView, so install a spy as a default no-op.
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']
})

afterEach(cleanup)

describe('FileTabStrip auto-scroll', () => {
  it('scrolls the active tab into view on mount', () => {
    const spy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
    render(<FileTabStrip />)
    expect(spy).toHaveBeenCalled()
  })

  it('scrolls the new active tab into view when activeTabId changes', () => {
    const spy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
    render(<FileTabStrip />)
    spy.mockClear()

    act(() => {
      useFileExplorerStore.setState({ activeTabId: 't2' })
    })

    expect(spy).toHaveBeenCalledTimes(1)
    const opts = spy.mock.calls[0]?.[0] as ScrollIntoViewOptions | undefined
    expect(opts?.inline).toBe('center')
  })

  it('re-fires scrollIntoView when scrollActiveTabToken bumps without activeTabId change', () => {
    const spy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
    render(<FileTabStrip />)
    spy.mockClear()

    act(() => {
      useFileExplorerStore.getState().requestScrollActiveTabIntoView()
    })

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not crash when there is no active tab', () => {
    useFileExplorerStore.setState({ activeTabId: null })
    expect(() => render(<FileTabStrip />)).not.toThrow()
  })

  it('re-scrolls when openTab is called for a tab that is already active', async () => {
    // Regression guard for the silent-no-op bug: clicking a chat chip whose
    // referenced file is already the active tab must still scroll the strip,
    // otherwise the interaction looks completely broken.
    const spy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
    render(<FileTabStrip />)
    spy.mockClear()

    const before = useFileExplorerStore.getState().scrollActiveTabToken
    await act(async () => {
      // openTab is async — we mocked nothing so it might fail to look up
      // through IPC, but the existing-tab early-return path runs synchronously
      // BEFORE any IPC call, so this test still validates the bump.
      await useFileExplorerStore.getState().openTab('D:/repo/a.ts', 'workspace')
    })
    const after = useFileExplorerStore.getState().scrollActiveTabToken

    expect(after).toBe(before + 1)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
