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

// Labels are Chinese-first with the raw config value in mono, so accessible
// names look like "工作区可写 workspace-write" — match on the canonical value.
describe('CodexPermissionsPanel', () => {
  it('shows current values', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /workspace-write/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: /on-request/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: /cached/ })).toHaveProperty('checked', true)
    expect(screen.getByText('D:/workspace')).toBeTruthy()
  })

  it('disables Apply initially', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', true)
  })

  it('shows a warning and enables Apply when an unsafe value is selected', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: /danger-full-access/ }))

    expect(screen.getByText(/高权限配置/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', false)
  })

  it('calls onApply with only changed fields', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /disabled/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({ webSearch: 'disabled' })
  })

  it('defaults the session tuning group to the historical hardcoded behavior', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    // Both personality AND verbosity default rows read "默认 default".
    const defaults = screen.getAllByRole('radio', { name: /default/ })
    expect(defaults).toHaveLength(2)
    for (const radio of defaults) {
      expect(radio).toHaveProperty('checked', true)
    }
    expect(screen.getByRole('radio', { name: /auto/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /原始思维链/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: /indexed/ })).toHaveProperty('checked', false)
  })

  it('applies session tuning changes as a minimal patch', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /pragmatic/ }))
    fireEvent.click(screen.getByRole('radio', { name: /detailed/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /原始思维链/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({
      personality: 'pragmatic',
      reasoningSummary: 'detailed',
      showRawReasoning: false,
    })
  })

  it('includes modelVerbosity in the patch when changed (batch 2)', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /详尽/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({ modelVerbosity: 'high' })
  })

  it('passes persist:true when 保存为默认 is checked', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /disabled/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /保存为默认/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({ webSearch: 'disabled' }, { persist: true })
  })

  it('enables Apply with persist checked even without field changes (snapshot current config)', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox', { name: /保存为默认/ }))
    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', false)

    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))
    expect(onApply).toHaveBeenCalledWith({}, { persist: true })
  })

  it('shows the persisted hint + factory reset only when defaults come from a saved snapshot', () => {
    const onReset = vi.fn()
    render(
      <CodexPermissionsPanel
        status={{ ...baseStatus, persistedDefaults: true }}
        onApply={vi.fn()}
        onReset={onReset}
      />,
    )

    expect(screen.getByText(/来自你保存的设置/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /恢复出厂设置/ }))
    expect(onReset).toHaveBeenCalled()
  })

  it('hides the factory reset when defaults are pristine', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} onReset={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /恢复出厂设置/ })).toBeNull()
  })

  it('renders an unavailable state when no status is provided', () => {
    render(<CodexPermissionsPanel onApply={vi.fn()} />)

    expect(screen.getByText(/设置不可用/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /应用设置/ })).toBeNull()
  })
})
