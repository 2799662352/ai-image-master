import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpEditor } from '../McpEditor'

afterEach(() => {
  cleanup()
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
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('keeps existing MCP identity fields read-only in form mode', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          saveMcp: vi.fn().mockResolvedValue({ ok: true }),
          getMcpDetail: vi.fn().mockResolvedValue({
            id: 'personal:demo',
            name: 'demo',
            scope: 'personal',
            enabled: true,
            command: 'node',
            args: [],
            env: [],
            description: '',
          }),
        },
      },
    })

    render(<McpEditor mode="personal:demo" onClose={() => {}} />)

    expect(await screen.findByDisplayValue('demo')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Scope') as HTMLSelectElement).disabled).toBe(true)
  })
})
