import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApprovalPrompt } from '../CodexApprovalPrompt'

const request = {
  id: '41',
  threadId: 'thread-1',
  method: 'request_permission',
  params: { reason: 'run command', command: 'npm test' },
  createdAt: '2026-05-09T00:00:00.000Z',
}

afterEach(cleanup)

describe('CodexApprovalPrompt', () => {
  it('renders method and a compact params summary', () => {
    render(<CodexApprovalPrompt request={request} onRespond={vi.fn()} />)

    expect(screen.getByText(/request_permission/i)).toBeTruthy()
    expect(screen.getByText(/npm test/i)).toBeTruthy()
    expect(screen.getByText(/run command/i)).toBeTruthy()
  })

  it('calls onRespond with approval when Approve is clicked', () => {
    const onRespond = vi.fn()
    render(<CodexApprovalPrompt request={request} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: /approve/i }))

    expect(onRespond).toHaveBeenCalledWith({ id: '41', approved: true })
  })

  it('calls onRespond with denial and message when Deny is clicked', () => {
    const onRespond = vi.fn()
    render(<CodexApprovalPrompt request={request} onRespond={onRespond} />)

    fireEvent.change(screen.getByLabelText(/denial message/i), { target: { value: 'No thanks' } })
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))

    expect(onRespond).toHaveBeenCalledWith({ id: '41', approved: false, message: 'No thanks' })
  })

  it('does not render an auto-approve control', () => {
    render(<CodexApprovalPrompt request={request} onRespond={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /auto/i })).toBeNull()
    expect(screen.queryByText(/auto-approve/i)).toBeNull()
  })

  it('truncates long preferred params fields', () => {
    const longCommand = 'x'.repeat(1200)
    render(<CodexApprovalPrompt request={{
      ...request,
      params: { command: longCommand, reason: 'run command' },
    }} onRespond={vi.fn()} />)

    const summary = screen.getByText(/command:/i)
    expect(summary.textContent?.length).toBeLessThan(900)
    expect(summary.textContent).toContain('...')
    expect(summary.textContent).not.toContain(longCommand)
  })
})
