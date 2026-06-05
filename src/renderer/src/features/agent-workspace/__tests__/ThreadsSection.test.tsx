import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThreadsSection } from '../ThreadsSection'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('ThreadsSection', () => {
  it('renders Codex threads with Read and Fork actions', async () => {
    const forkCodexThread = vi.fn().mockResolvedValue({ id: 'forked', title: 'Forked', updatedAtIso: '' })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listCodexThreads: vi.fn().mockResolvedValue([{ id: 't1', title: 'T1', updatedAtIso: '' }]),
          readCodexThread: vi.fn(),
          forkCodexThread,
        },
      },
    })

    render(<ThreadsSection />)

    expect(await screen.findByText('T1')).toBeTruthy()
    fireEvent.click(screen.getByText('Fork'))

    expect(forkCodexThread).toHaveBeenCalledWith('t1')
  })

  it('archives an active thread and reloads the list', async () => {
    const archiveCodexThread = vi.fn().mockResolvedValue({ ok: true })
    const listCodexThreads = vi.fn().mockResolvedValue([{ id: 't1', title: 'T1', updatedAt: '' }])
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listCodexThreads,
          readCodexThread: vi.fn(),
          forkCodexThread: vi.fn(),
          archiveCodexThread,
          unarchiveCodexThread: vi.fn(),
        },
      },
    })

    render(<ThreadsSection />)

    expect(await screen.findByText('T1')).toBeTruthy()
    // Initial load requests active (non-archived) threads.
    expect(listCodexThreads).toHaveBeenCalledWith({ archived: false })

    fireEvent.click(screen.getByText('Archive'))

    await waitFor(() => expect(archiveCodexThread).toHaveBeenCalledWith('t1'))
    // Reloads after archiving so the now-archived thread drops out of the view.
    await waitFor(() => expect(listCodexThreads).toHaveBeenCalledTimes(2))
  })

  it('toggling "Show archived" lists archived threads with Unarchive actions', async () => {
    const unarchiveCodexThread = vi.fn().mockResolvedValue({ ok: true, thread: { id: 't9', title: 'Old' } })
    const listCodexThreads = vi
      .fn()
      .mockResolvedValueOnce([{ id: 't1', title: 'Active', updatedAt: '' }])
      .mockResolvedValue([{ id: 't9', title: 'Archived One', updatedAt: '' }])
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listCodexThreads,
          readCodexThread: vi.fn(),
          forkCodexThread: vi.fn(),
          archiveCodexThread: vi.fn(),
          unarchiveCodexThread,
        },
      },
    })

    render(<ThreadsSection />)
    expect(await screen.findByText('Active')).toBeTruthy()

    fireEvent.click(screen.getByText(/show archived/i))

    expect(await screen.findByText('Archived One')).toBeTruthy()
    expect(listCodexThreads).toHaveBeenLastCalledWith({ archived: true })

    fireEvent.click(screen.getByText('Unarchive'))
    await waitFor(() => expect(unarchiveCodexThread).toHaveBeenCalledWith('t9'))
  })
})
