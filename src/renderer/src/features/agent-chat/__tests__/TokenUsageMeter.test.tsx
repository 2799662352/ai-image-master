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

/**
 * Browsers fire mousedown then click on a real click. RTL's `fireEvent.click`
 * skips mousedown, so it can't catch races between the popover's document-level
 * mousedown listener and the trigger's onClick. This helper replays the real
 * sequence so we exercise the actual user-event timing.
 */
function realClick(el: Element) {
  fireEvent.mouseDown(el)
  fireEvent.click(el)
}

describe('TokenUsageMeter', () => {
  afterEach(() => cleanup())

  it('renders nothing when usage is undefined', () => {
    const { container } = render(
      <TokenUsageMeter usage={undefined} fallbackContextWindow={200_000} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the pill as a button when usage is present', () => {
    render(<TokenUsageMeter usage={sampleUsage} fallbackContextWindow={200_000} />)
    const btn = screen.getByRole('button', { name: /context/i })
    expect(btn).toBeTruthy()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not render the popover by default', () => {
    render(<TokenUsageMeter usage={sampleUsage} fallbackContextWindow={200_000} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the popover when the pill is clicked', () => {
    render(<TokenUsageMeter usage={sampleUsage} fallbackContextWindow={200_000} />)
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: /context/i }).getAttribute('aria-expanded')).toBe('true')
  })

  it('toggles the popover closed when the pill is clicked again', () => {
    render(<TokenUsageMeter usage={sampleUsage} fallbackContextWindow={200_000} />)
    const btn = screen.getByRole('button', { name: /context/i })
    fireEvent.click(btn)
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.click(btn)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still toggles closed when click fires the full mousedown→click sequence (regression: trigger-vs-outside-click race)', () => {
    render(<TokenUsageMeter usage={sampleUsage} fallbackContextWindow={200_000} />)
    const btn = screen.getByRole('button', { name: /context/i })
    realClick(btn)
    expect(screen.queryByRole('dialog')).toBeTruthy()
    realClick(btn)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resets open=false when usage transitions to undefined and back (regression: thread switch)', () => {
    const { rerender } = render(
      <TokenUsageMeter usage={sampleUsage} fallbackContextWindow={200_000} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.queryByRole('dialog')).toBeTruthy()

    rerender(<TokenUsageMeter usage={undefined} fallbackContextWindow={200_000} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    rerender(<TokenUsageMeter usage={sampleUsage} fallbackContextWindow={200_000} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders a percent using fallbackContextWindow when usage.contextWindow is missing', () => {
    render(
      <TokenUsageMeter
        usage={{ inputTokens: 50_000, outputTokens: 50_000 }}
        fallbackContextWindow={200_000}
      />,
    )
    // Codex effective-window formula: (100k − 12k baseline) / (200k − 12k) =
    // 88k / 188k ≈ 47%.
    expect(screen.getByRole('button').textContent).toContain('47%')
  })

  it('applies the 12K baseline subtraction to the percent (codex TUI parity)', () => {
    // used = contextUsage = 62k, window = 100k. Naive ratio would be 62%, but
    // codex subtracts the 12k baseline from both: (62k−12k)/(100k−12k) =
    // 50k/88k ≈ 57%.
    render(
      <TokenUsageMeter
        usage={{ inputTokens: 62_000, outputTokens: 0, contextWindow: 100_000 }}
        fallbackContextWindow={200_000}
      />,
    )
    expect(screen.getByRole('button').textContent).toContain('57%')
  })

  it('clamps to 0% when occupancy is at or below the baseline', () => {
    render(
      <TokenUsageMeter
        usage={{ inputTokens: 8_000, outputTokens: 0, contextWindow: 100_000 }}
        fallbackContextWindow={200_000}
      />,
    )
    expect(screen.getByRole('button').textContent).toContain('0%')
  })

  it('uses a valid usage context before fallback and otherwise shows about 24% for 100k of 372k', () => {
    const { rerender } = render(
      <TokenUsageMeter
        usage={{ inputTokens: 100_000, outputTokens: 0, contextWindow: 100_000 }}
        fallbackContextWindow={372_000}
      />,
    )
    expect(screen.getByRole('button').textContent).toContain('100%')

    rerender(
      <TokenUsageMeter
        usage={{ inputTokens: 100_000, outputTokens: 0, contextWindow: Number.NaN }}
        fallbackContextWindow={372_000}
      />,
    )
    expect(screen.getByRole('button').textContent).toContain('24%')
  })
})
