import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const mockApi = {
  readConfig: vi.fn(),
  listMcpServersRpc: vi.fn(),
  batchWriteConfig: vi.fn(),
  writeConfigValue: vi.fn(),
  reloadMcpServers: vi.fn(),
  mcpOAuthLogin: vi.fn(),
  dockerGatewayFix: vi.fn(),
}
;(window as any).electronAPI = { agent: mockApi, shell: { openExternal: vi.fn() } }

const { useMcpStore } = await import('../useMcpStore')
const { AutoFixToast } = await import('../AutoFixToast')

describe('AutoFixToast', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    useMcpStore.setState({ lastAutoFix: null, lastConvertedFingerprint: null })
  })

  it('renders nothing when lastAutoFix is null', () => {
    const { container } = render(<AutoFixToast />)
    expect(container.firstChild).toBeNull()
  })

  it('renders count and port when lastAutoFix is set', () => {
    useMcpStore.setState({ lastAutoFix: { count: 3, port: 8811, ts: Date.now() } })
    render(<AutoFixToast />)
    expect(screen.getByText(/3/)).toBeTruthy()
    expect(screen.getByText(/8811/)).toBeTruthy()
  })

  it('dismiss button clears the toast', () => {
    useMcpStore.setState({ lastAutoFix: { count: 2, port: 8811, ts: Date.now() } })
    render(<AutoFixToast />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn)
    expect(useMcpStore.getState().lastAutoFix).toBeNull()
  })
})
