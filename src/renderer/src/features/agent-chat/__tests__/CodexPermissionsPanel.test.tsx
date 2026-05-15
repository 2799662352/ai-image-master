import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexPermissionsPanel } from '../CodexPermissionsPanel'
import type { CodexSessionStatus } from '../../../../../types/agent'

const baseStatus: CodexSessionStatus = {
  model: 'gpt-5.5',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  webSearch: 'cached',
  writableRoots: ['D:/workspace'],
}

afterEach(cleanup)

describe('CodexPermissionsPanel', () => {
  it('shows current values', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.getByRole('radio', { name: 'workspace-write' })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: 'on-request' })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: 'cached' })).toHaveProperty('checked', true)
    expect(screen.getByText('D:/workspace')).toBeTruthy()
  })

  it('disables Apply initially', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.getByRole('button', { name: /apply permissions/i })).toHaveProperty('disabled', true)
  })

  it('shows a warning and enables Apply when an unsafe value is selected', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: 'danger-full-access' }))

    expect(screen.getByText(/unsafe permission/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /apply permissions/i })).toHaveProperty('disabled', false)
  })

  it('calls onApply with only changed fields', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: 'disabled' }))
    fireEvent.click(screen.getByRole('button', { name: /apply permissions/i }))

    expect(onApply).toHaveBeenCalledWith({ webSearch: 'disabled' })
  })

  it('renders an unavailable state when no status is provided', () => {
    render(<CodexPermissionsPanel onApply={vi.fn()} />)

    expect(screen.getByText(/permissions unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /apply permissions/i })).toBeNull()
  })
})
