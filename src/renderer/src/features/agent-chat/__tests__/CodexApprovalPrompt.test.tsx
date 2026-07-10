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

  // ---------------------------------------------------------------------
  // Codex app-server typed approval prompts. The router forwards distinct
  // method names that each deserve a tailored UI:
  //   - `item/commandExecution/requestApproval` → Execute / Block
  //   - `item/fileChange/requestApproval`        → Apply / Reject
  //   - `item/permissions/requestApproval`       → Grant / Deny
  //   - `mcpServer/elicitation/request`           → Continue / Decline
  // ---------------------------------------------------------------------
  describe('typed renderers', () => {
    it('renders a command execution request with Execute/Block buttons', () => {
      const onRespond = vi.fn()
      render(
        <CodexApprovalPrompt
          request={{
            id: 'cmd-1',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'rm -rf node_modules', cwd: '/repo' },
            createdAt: '2026-05-09T00:00:00.000Z',
          }}
          onRespond={onRespond}
        />,
      )

      expect(screen.getByRole('button', { name: /execute/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /block/i })).toBeTruthy()
      // The command should appear as a recognizable code fragment, not buried in JSON.
      expect(screen.getByText(/rm -rf node_modules/)).toBeTruthy()
      expect(screen.getByText(/\/repo/)).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: /execute/i }))
      expect(onRespond).toHaveBeenCalledWith({ id: 'cmd-1', approved: true })
    })

    it('renders a file change request with Apply/Reject buttons and the path', () => {
      const onRespond = vi.fn()
      render(
        <CodexApprovalPrompt
          request={{
            id: 'fc-1',
            method: 'item/fileChange/requestApproval',
            params: { path: 'src/foo.ts', changes: [{ kind: 'edit', diff: '...' }] },
            createdAt: '2026-05-09T00:00:00.000Z',
          }}
          onRespond={onRespond}
        />,
      )

      expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /reject/i })).toBeTruthy()
      expect(screen.getByText(/src\/foo\.ts/)).toBeTruthy()
    })

    it('renders a permissions request with Grant/Deny buttons and a list', () => {
      const onRespond = vi.fn()
      render(
        <CodexApprovalPrompt
          request={{
            id: 'perm-1',
            method: 'item/permissions/requestApproval',
            params: { permissions: ['network:fetch', 'fs:write:/tmp'] },
            createdAt: '2026-05-09T00:00:00.000Z',
          }}
          onRespond={onRespond}
        />,
      )

      expect(screen.getByRole('button', { name: /grant/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /deny/i })).toBeTruthy()
      expect(screen.getByText(/network:fetch/)).toBeTruthy()
      expect(screen.getByText(/fs:write:\/tmp/)).toBeTruthy()
    })

    it('renders a Codex 0.144 MCP authentication elicitation with its URL', () => {
      render(
        <CodexApprovalPrompt
          request={{
            id: 'elicit-1',
            threadId: 'thread-1',
            method: 'mcpServer/elicitation/request',
            params: {
              serverName: 'codex_apps',
              mode: 'url',
              message: 'Sign in to continue',
              url: 'https://example.com/auth',
            },
            createdAt: '2026-07-10T00:00:00.000Z',
          }}
          onRespond={vi.fn()}
        />,
      )

      expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /decline/i })).toBeTruthy()
      expect(screen.getByText('codex_apps')).toBeTruthy()
      expect(screen.getByText('https://example.com/auth')).toBeTruthy()
    })

    it('falls back to generic Approve/Deny when the method is unknown', () => {
      render(
        <CodexApprovalPrompt
          request={{
            id: 'gen-1',
            method: 'some/future/methodName',
            params: { foo: 'bar' },
            createdAt: '2026-05-09T00:00:00.000Z',
          }}
          onRespond={vi.fn()}
        />,
      )

      expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /deny/i })).toBeTruthy()
    })
  })
})
