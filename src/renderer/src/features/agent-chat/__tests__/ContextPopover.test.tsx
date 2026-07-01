import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentTokenUsage } from '../../../../../types/agent'
import { ContextPopover } from '../ContextPopover'

const fullUsage: AgentTokenUsage = {
  // Cumulative lifetime (session total) — large, distinct from current context.
  inputTokens: 250_000,
  outputTokens: 40_000,
  contextWindow: 110_000,
  // Current context occupancy (codex last_token_usage) — drives the bar/donut.
  // Sized comfortably above the 12K baseline so the percent is meaningful.
  // Segment values chosen distinct from the 250K/40K session totals below.
  last: { inputTokens: 60_000, cachedInputTokens: 35_000, outputTokens: 12_000, reasoningTokens: 2_000 },
}

describe('ContextPopover', () => {
  afterEach(() => cleanup())

  it('renders pct full headline when contextWindow is known', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    // (72k occupancy − 12k baseline) / (110k window − 12k baseline) ≈ 61%.
    expect(screen.getByText(/61% Full/i)).toBeTruthy()
  })

  it('shows token total even when contextWindow is missing', () => {
    const { contextWindow: _omit, ...rest } = fullUsage
    render(<ContextPopover usage={rest} onClose={() => {}} />)
    expect(screen.queryByText(/% Full/)).toBeNull()
    expect(screen.getByText(/72(\.0)?K/i)).toBeTruthy()
  })

  it('renders all four segment labels with their token counts', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    // Anchor regexes to ^...$ so the legend matches each label exactly without
    // colliding with the footnote ("...Cached prompt / Conversation."), which
    // also contains the words "Cached prompt" and "Conversation".
    expect(screen.getByText(/^Cached prompt$/i)).toBeTruthy()
    expect(screen.getByText(/^Conversation$/i)).toBeTruthy()
    expect(screen.getByText(/^Reasoning$/i)).toBeTruthy()
    expect(screen.getByText(/^Output$/i)).toBeTruthy()
    expect(screen.getByText(/^35\.0K$/)).toBeTruthy() // cached
    expect(screen.getByText(/^25\.0K$/)).toBeTruthy() // conversation (60k − 35k)
    expect(screen.getByText(/^2\.0K$/)).toBeTruthy() // reasoning
    expect(screen.getByText(/^10\.0K$/)).toBeTruthy() // output (12k − 2k)
  })

  it('renders a Session total line with cumulative (lifetime) usage', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    expect(screen.getByText(/Session total/i)).toBeTruthy()
    expect(screen.getByText(/250\.0K/)).toBeTruthy()
    expect(screen.getByText(/40\.0K/)).toBeTruthy()
  })

  it('hides Session total line when cumulative usage is zero', () => {
    render(
      <ContextPopover
        usage={{ inputTokens: 0, outputTokens: 0, last: { inputTokens: 1_000, outputTokens: 200 } }}
        onClose={() => {}}
      />,
    )
    // Current-context bar still renders (last is non-zero) but no lifetime line.
    expect(screen.queryByText(/Session total/i)).toBeNull()
  })

  it('shows empty-state copy when total is zero', () => {
    render(
      <ContextPopover
        usage={{ inputTokens: 0, outputTokens: 0 }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/No usage data yet/i)).toBeTruthy()
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<ContextPopover usage={fullUsage} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape keydown', () => {
    const onClose = vi.fn()
    render(<ContextPopover usage={fullUsage} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when clicking outside the popover', () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-testid="outside">outside</div>
        <ContextPopover usage={fullUsage} onClose={onClose} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when clicking inside the popover', () => {
    const onClose = vi.fn()
    render(<ContextPopover usage={fullUsage} onClose={onClose} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
  })
})
