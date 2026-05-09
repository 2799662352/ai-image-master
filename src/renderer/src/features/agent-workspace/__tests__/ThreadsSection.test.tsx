import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
