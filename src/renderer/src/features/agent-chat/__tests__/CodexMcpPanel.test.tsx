import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexMcpPanel } from '../CodexMcpPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'electronAPI')
})

describe('CodexMcpPanel', () => {
  it('shows discovered MCP servers with redacted details', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getMcpSummary: vi.fn().mockResolvedValue({
            servers: [
              {
                name: 'github',
                transport: 'stdio',
                enabled: true,
                required: false,
                command: 'npx server --token [REDACTED]',
              },
            ],
            warnings: [],
          }),
        },
      },
    })

    render(<CodexMcpPanel />)

    expect(await screen.findByText('github')).toBeTruthy()
    expect(screen.getByText('stdio')).toBeTruthy()
    expect(screen.getByText('enabled')).toBeTruthy()
    expect(screen.getByText('optional')).toBeTruthy()
    expect(screen.getByText(/--token \[REDACTED\]/)).toBeTruthy()
    expect(screen.getByText('[REDACTED]', { exact: false })).toBeTruthy()
  })

  it('renders empty and error states narrowly', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { getMcpSummary: vi.fn().mockResolvedValue({ servers: [], warnings: [] }) } },
    })
    const { rerender } = render(<CodexMcpPanel />)

    expect(await screen.findByText(/No Codex MCP servers found/i)).toBeTruthy()

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { getMcpSummary: vi.fn().mockRejectedValue(new Error('boom')) } },
    })
    rerender(<CodexMcpPanel key="error" />)

    expect(await screen.findByText(/boom/i)).toBeTruthy()
  })
})
