import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpEditor } from '../McpEditor'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('McpEditor risky-arg stripe', () => {
  it('shows hint stripe when args contain --network=host', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { saveMcp: vi.fn(), getMcpDetail: vi.fn() } },
    })

    render(<McpEditor mode="new" onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'docker' } })
    fireEvent.click(screen.getByText('+ add arg'))
    fireEvent.change(screen.getByLabelText('Arg 1'), { target: { value: '--network=host' } })

    expect(screen.getByText(/Risky args detected/i)).toBeTruthy()
  })
})
