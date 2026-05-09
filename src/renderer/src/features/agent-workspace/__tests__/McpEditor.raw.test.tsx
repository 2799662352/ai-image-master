import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpEditor } from '../McpEditor'

afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('McpEditor raw mode', () => {
  it('round-trips form to raw and back on simple inputs', async () => {
    const saveMcp = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { saveMcp, getMcpDetail: vi.fn() } },
    })

    render(<McpEditor mode="new" onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'rt' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo' } })
    fireEvent.click(screen.getByText('Raw'))

    const raw = screen.getByTestId('mcp-raw-editor') as HTMLTextAreaElement
    expect(raw.value).toContain('command = "echo"')

    fireEvent.change(raw, { target: { value: '[mcp_servers.rt]\ncommand = "node"\nargs = []\n' } })
    fireEvent.click(screen.getByText('Form'))

    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('node')
  })
})
