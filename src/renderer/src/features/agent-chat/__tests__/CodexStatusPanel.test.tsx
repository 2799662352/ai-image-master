import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexStatusPanel } from '../CodexStatusPanel'

afterEach(cleanup)

describe('CodexStatusPanel', () => {
  it('renders the unavailable fallback when no status is provided', () => {
    render(<CodexStatusPanel />)
    expect(screen.getByText(/Codex status unavailable/i)).toBeTruthy()
  })

  it('renders safe defaults', () => {
    render(<CodexStatusPanel status={{
      model: 'gpt-5.5',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      webSearch: true,
      writableRoots: [],
    }} />)
    expect(screen.getByText(/Codex gpt-5.5/i)).toBeTruthy()
    expect(screen.getByText(/workspace-write/i)).toBeTruthy()
  })

  it('flags unsafe sandbox and approval', () => {
    const { container } = render(<CodexStatusPanel status={{
      model: 'gpt-5.5',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: false,
      writableRoots: ['D:/repo'],
    }} />)
    expect(container.querySelector('[class*="amber"]')).toBeTruthy()
    expect(screen.getByText(/1 root\(s\)/i)).toBeTruthy()
  })
})
