import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentTokenUsage } from '../../../../../types/agent'
import { TokenUsageMeter } from '../TokenUsageMeter'

const sampleUsage: AgentTokenUsage = {
  inputTokens: 10_000,
  cachedInputTokens: 6_000,
  outputTokens: 1_000,
  contextWindow: 100_000,
}

describe('TokenUsageMeter', () => {
  afterEach(() => cleanup())

  it('renders nothing when usage is undefined', () => {
    const { container } = render(<TokenUsageMeter usage={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the pill as a button when usage is present', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    const btn = screen.getByRole('button', { name: /context/i })
    expect(btn).toBeTruthy()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not render the popover by default', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the popover when the pill is clicked', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: /context/i }).getAttribute('aria-expanded')).toBe('true')
  })

  it('toggles the popover closed when the pill is clicked again', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    const btn = screen.getByRole('button', { name: /context/i })
    fireEvent.click(btn)
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.click(btn)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
