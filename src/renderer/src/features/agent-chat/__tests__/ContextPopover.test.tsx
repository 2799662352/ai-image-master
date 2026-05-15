import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentTokenUsage } from '../../../../../types/agent'
import { ContextPopover } from '../ContextPopover'

const fullUsage: AgentTokenUsage = {
  inputTokens: 10_000,
  cachedInputTokens: 8_000,
  outputTokens: 2_000,
  reasoningTokens: 500,
  contextWindow: 110_000,
  last: { inputTokens: 1_300, outputTokens: 234 },
}

describe('ContextPopover', () => {
  afterEach(() => cleanup())

  it('renders pct full headline when contextWindow is known', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    expect(screen.getByText(/11% Full/i)).toBeTruthy()
  })

  it('shows token total even when contextWindow is missing', () => {
    const { contextWindow: _omit, ...rest } = fullUsage
    render(<ContextPopover usage={rest} onClose={() => {}} />)
    expect(screen.queryByText(/% Full/)).toBeNull()
    expect(screen.getByText(/12(\.0)?K/i)).toBeTruthy()
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
    expect(screen.getByText(/^8\.0K$/)).toBeTruthy()
    expect(screen.getByText(/^2\.0K$/)).toBeTruthy()
    expect(screen.getByText(/^500$/)).toBeTruthy()
    expect(screen.getByText(/^1\.5K$/)).toBeTruthy()
  })

  it('renders a Last turn line when usage.last is present', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    expect(screen.getByText(/Last turn/i)).toBeTruthy()
    expect(screen.getByText(/\+1\.3K/)).toBeTruthy()
    expect(screen.getByText(/\+234/)).toBeTruthy()
  })

  it('hides Last turn line when usage.last is missing', () => {
    const { last: _omit, ...rest } = fullUsage
    render(<ContextPopover usage={rest} onClose={() => {}} />)
    expect(screen.queryByText(/Last turn/i)).toBeNull()
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
