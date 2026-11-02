import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChoiceRequestItem } from '../../../../../../types/agent-timeline'
import { ASK_USER_AUTO_ADVANCE_MS, buildTimedOutChoiceAnswer } from '../../askUserTimeout'
import { useAgentChatStore } from '../../store'
import { AskUserCard } from '../AskUserCard'

/**
 * The card's half of the 5-minute auto-advance: tell the user the clock is
 * running (silently expiring would feel like the app ate their question), show
 * a countdown once it is close, treat any real interaction as "still here",
 * and recap a timed-out card honestly ("you didn't answer", not "you skipped").
 */

const T0 = 1_700_000_000_000

function pendingItem(overrides: Partial<ChoiceRequestItem> = {}): ChoiceRequestItem {
  return {
    type: 'choiceRequest',
    id: 'c1',
    requestId: 'req-1',
    startedAt: T0,
    question: '选哪个景别?',
    options: [
      { id: 'cu', label: '特写' },
      { id: 'wide', label: '广角' },
    ],
    mode: 'multi',
    allowFreeText: true,
    allowSkip: true,
    status: 'pending',
    autoAdvanceAt: T0 + ASK_USER_AUTO_ADVANCE_MS,
    ...overrides,
  } as ChoiceRequestItem
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAgentChatStore.setState({ messages: [], threadSlices: {} })
})

describe('AskUserCard auto-advance hint', () => {
  it('tells the user how long the card will wait', () => {
    render(<AskUserCard item={pendingItem()} />)
    expect(screen.getByTestId('ask-user-auto-advance-hint').textContent).toMatch(/5 分钟/)
  })

  it('counts the minutes down as the deadline approaches', () => {
    render(<AskUserCard item={pendingItem()} />)
    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000 + 5_000)
    })
    // 2 min 55 s left → rounds UP so it never claims less time than there is.
    expect(screen.getByTestId('ask-user-auto-advance-hint').textContent).toMatch(/3 分钟/)
  })

  it('switches to a seconds countdown in the final minute', () => {
    render(<AskUserCard item={pendingItem()} />)
    act(() => {
      vi.advanceTimersByTime(ASK_USER_AUTO_ADVANCE_MS - 30_000)
    })
    const text = screen.getByTestId('ask-user-auto-advance-hint').textContent ?? ''
    expect(text).toMatch(/30 秒/)
    // The user must be told how to stop it.
    expect(text).toMatch(/重新计时/)
  })

  it('shows no hint for a card that has no deadline (persisted before this feature)', () => {
    render(<AskUserCard item={pendingItem({ autoAdvanceAt: undefined })} />)
    expect(screen.queryByTestId('ask-user-auto-advance-hint')).toBeNull()
  })

  it('stops ticking once unmounted (no timer leak)', () => {
    const { unmount } = render(<AskUserCard item={pendingItem()} />)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('AskUserCard interaction restarts the clock', () => {
  function withSpy() {
    const touch = vi.fn()
    useAgentChatStore.setState({ touchChoiceRequest: touch })
    return touch
  }

  it('touches the request when the user types an answer', () => {
    const touch = withSpy()
    render(<AskUserCard item={pendingItem()} />)

    fireEvent.change(screen.getByPlaceholderText('或自定义…'), { target: { value: '想想…' } })

    expect(touch).toHaveBeenCalledWith('req-1')
  })

  it('touches the request when the user ticks a multi-select option', () => {
    const touch = withSpy()
    render(<AskUserCard item={pendingItem()} />)

    fireEvent.click(screen.getByLabelText(/特写/))

    expect(touch).toHaveBeenCalledWith('req-1')
  })

  it('touches the request on pointer / keyboard activity over the card', () => {
    const touch = withSpy()
    render(<AskUserCard item={pendingItem()} />)

    fireEvent.pointerMove(screen.getByTestId('ask-user-card'))
    expect(touch).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    fireEvent.keyDown(screen.getByTestId('ask-user-card'), { key: 'a' })
    expect(touch).toHaveBeenCalledTimes(2)
  })

  it('throttles: a burst of mouse moves is ONE store write, not hundreds', () => {
    const touch = withSpy()
    render(<AskUserCard item={pendingItem()} />)
    const card = screen.getByTestId('ask-user-card')

    for (let i = 0; i < 200; i += 1) fireEvent.pointerMove(card)

    expect(touch).toHaveBeenCalledTimes(1)
  })

  it('does not touch a card that has no deadline', () => {
    const touch = withSpy()
    render(<AskUserCard item={pendingItem({ autoAdvanceAt: undefined })} />)

    fireEvent.pointerMove(screen.getByTestId('ask-user-card'))

    expect(touch).not.toHaveBeenCalled()
  })
})

describe('AskUserCard timed-out recap', () => {
  const timedOut = (): ChoiceRequestItem =>
    pendingItem({
      status: 'answered',
      answer: buildTimedOutChoiceAnswer(),
    })

  it('says the user did not answer — it does not pretend they chose "你来定"', () => {
    render(<AskUserCard item={timedOut()} />)

    const recap = screen.getByTestId('ask-user-card-timed-out')
    expect(recap.textContent).toContain('选哪个景别?')
    expect(recap.textContent).toMatch(/5 分钟/)
    expect(recap.textContent).toMatch(/自动/)
    expect(screen.queryByText('已跳过（交给你决定）')).toBeNull()
  })

  it('a deliberate skip still reads as a deliberate skip', () => {
    render(
      <AskUserCard
        item={pendingItem({
          status: 'answered',
          answer: { answered: false, skipped: true, selected: [] },
        })}
      />,
    )
    expect(screen.getByText('已跳过（交给你决定）')).toBeTruthy()
    expect(screen.queryByTestId('ask-user-card-timed-out')).toBeNull()
  })

  it('a frozen (turn ended) card keeps its own expired wording', () => {
    render(
      <AskUserCard
        item={pendingItem({
          status: 'answered',
          expired: true,
          answer: { answered: false, skipped: true, selected: [] },
        })}
      />,
    )
    expect(screen.getByTestId('ask-user-card-expired')).toBeTruthy()
  })
})
