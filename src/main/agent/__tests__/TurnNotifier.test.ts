import { describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '../../../types/agent'
import { TurnNotifier } from '../TurnNotifier'

function makeNotifier(overrides: {
  enabled?: boolean
  focused?: boolean
} = {}) {
  const notify = vi.fn()
  const notifier = new TurnNotifier({
    isEnabled: () => overrides.enabled ?? true,
    isWindowFocused: () => overrides.focused ?? false,
    notify,
  })
  return { notifier, notify }
}

const turnCompleted: AgentStreamEvent = { type: 'turn_completed', threadId: 't1' }

describe('TurnNotifier', () => {
  it('notifies on turn_completed when enabled and window unfocused', () => {
    const { notifier, notify } = makeNotifier()
    notifier.handleEvent(turnCompleted)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', threadId: 't1' }),
    )
  })

  it('notifies on terminal errors with the error message as body', () => {
    const { notifier, notify } = makeNotifier()
    notifier.handleEvent({ type: 'error', threadId: 't1', error: 'boom' })
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', body: 'boom' }),
    )
  })

  it('truncates very long error bodies', () => {
    const { notifier, notify } = makeNotifier()
    notifier.handleEvent({ type: 'error', threadId: 't1', error: 'x'.repeat(500) })
    const body = notify.mock.calls[0]?.[0]?.body as string
    expect(body.length).toBeLessThanOrEqual(120)
    expect(body.endsWith('…')).toBe(true)
  })

  it('stays silent for retryable errors (backend re-streams, turn still running)', () => {
    const { notifier, notify } = makeNotifier()
    notifier.handleEvent({ type: 'error', threadId: 't1', error: 'blip', willRetry: true })
    expect(notify).not.toHaveBeenCalled()
  })

  it('stays silent for cancelled turns (user pressed Stop)', () => {
    const { notifier, notify } = makeNotifier()
    notifier.handleEvent({ type: 'cancelled', threadId: 't1' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('stays silent for non-terminal stream events', () => {
    const { notifier, notify } = makeNotifier()
    notifier.handleEvent({ type: 'thread_created', threadId: 't1' })
    notifier.handleEvent({
      type: 'item_delta',
      threadId: 't1',
      itemId: 'i1',
      itemType: 'text',
      patch: {},
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('suppresses the toast while the window is focused', () => {
    const { notifier, notify } = makeNotifier({ focused: true })
    notifier.handleEvent(turnCompleted)
    expect(notify).not.toHaveBeenCalled()
  })

  it('suppresses the toast when disabled in session config', () => {
    const { notifier, notify } = makeNotifier({ enabled: false })
    notifier.handleEvent(turnCompleted)
    expect(notify).not.toHaveBeenCalled()
  })

  it('reads the enabled gate per event so live toggles apply', () => {
    let enabled = false
    const notify = vi.fn()
    const notifier = new TurnNotifier({
      isEnabled: () => enabled,
      isWindowFocused: () => false,
      notify,
    })
    notifier.handleEvent(turnCompleted)
    expect(notify).not.toHaveBeenCalled()
    enabled = true
    notifier.handleEvent(turnCompleted)
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
