import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpEditor } from '../McpEditor'

afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('McpEditor form mode', () => {
  it('saves a new MCP server with form values', async () => {
    const saveMcp = vi.fn().mockResolvedValue({ ok: true, id: 'personal:demo' })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { saveMcp, getMcpDetail: vi.fn() } },
    })
    const onClose = vi.fn()

    render(<McpEditor mode="new" onClose={onClose} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByText('Saved')).toBeTruthy()
    expect(saveMcp).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo', command: 'node', scope: 'personal' }),
    )
    expect(onClose).toHaveBeenCalled()
  })
})
