import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import {
  ASK_USER_AUTO_ADVANCE_MS,
  buildTimedOutChoiceAnswer,
} from '../askUserTimeout'
import type { ChoiceAnswer, ChoiceRequestItem } from '../../../../../types/agent-timeline'

/**
 * Auto-advance for an unanswered `ask_user` card.
 *
 * The tool BLOCKS the agent's turn until the user answers. A user who walks
 * away would otherwise leave the whole pipeline parked on a card for up to the
 * 6-hour transport ceiling. After 5 idle minutes the card resolves itself as a
 * skip ("你来定") that is explicitly marked `timedOut`, so the model knows the
 * user was away (not that they chose to defer) and can re-ask if it matters.
 * Same shape as Claude Code's `askUserQuestionTimeout`.
 */

const FIVE_MINUTES = 5 * 60 * 1000

const spec = {
  question: 'q',
  options: [{ id: 'a', label: 'A' }],
  mode: 'single' as const,
  allowFreeText: true,
  allowSkip: true,
}

function choiceIn(messages: { items: unknown[] }[]): ChoiceRequestItem {
  return messages[messages.length - 1].items[0] as ChoiceRequestItem
}

function activeChoice(): ChoiceRequestItem {
  return choiceIn(useAgentChatStore.getState().messages)
}

beforeEach(() => {
  vi.useFakeTimers()
  useAgentChatStore.setState({ threadId: 't1', messages: [], threadSlices: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ask_user auto-advance', () => {
  it('the window is exactly 5 minutes', () => {
    expect(ASK_USER_AUTO_ADVANCE_MS).toBe(FIVE_MINUTES)
  })

  it('the timed-out answer is a skip the model can tell apart from a deliberate one', () => {
    const answer = buildTimedOutChoiceAnswer()
    expect(answer).toMatchObject({ answered: false, skipped: true, timedOut: true, selected: [] })
    // The model reads this text: it must say "user was away", offer the escape
    // hatch (decide yourself), and not pretend the user chose anything.
    expect(answer.note).toMatch(/5/)
    expect(answer.note?.length).toBeGreaterThan(20)
  })

  it('stamps the deadline on the card when it is asked', () => {
    vi.setSystemTime(1_000_000)
    void useAgentChatStore.getState().ask(spec)
    expect(activeChoice().autoAdvanceAt).toBe(1_000_000 + FIVE_MINUTES)
  })

  it('stays pending right up to the deadline', () => {
    void useAgentChatStore.getState().ask(spec)
    vi.advanceTimersByTime(FIVE_MINUTES - 1)
    expect(activeChoice().status).toBe('pending')
  })

  it('resolves as a timed-out skip at the deadline and freezes the card', async () => {
    const promise = useAgentChatStore.getState().ask(spec)
    vi.advanceTimersByTime(FIVE_MINUTES)

    const answer = await promise
    expect(answer).toMatchObject({ answered: false, skipped: true, timedOut: true, selected: [] })
    const item = activeChoice()
    expect(item.status).toBe('answered')
    expect(item.answer?.timedOut).toBe(true)
    // Not `expired`: that flag means "the turn ended under it", a different story.
    expect(item.expired).toBeFalsy()
  })

  it('applies even when the card does not offer a skip button', async () => {
    const promise = useAgentChatStore.getState().ask({ ...spec, allowSkip: false })
    vi.advanceTimersByTime(FIVE_MINUTES)
    await expect(promise).resolves.toMatchObject({ skipped: true, timedOut: true })
  })

  it('applies to a card living in a background thread (the user is not even looking at it)', async () => {
    const promise = useAgentChatStore.getState().ask(spec, 'background')
    vi.advanceTimersByTime(FIVE_MINUTES)

    await expect(promise).resolves.toMatchObject({ skipped: true, timedOut: true })
    const settled = choiceIn(useAgentChatStore.getState().threadSlices['background'].messages)
    expect(settled.status).toBe('answered')
    expect(settled.answer?.timedOut).toBe(true)
  })

  it('answering in time cancels the timer — nothing fires later', async () => {
    const promise = useAgentChatStore.getState().ask(spec)
    const { requestId } = activeChoice()

    vi.advanceTimersByTime(60_000)
    useAgentChatStore.getState().settleChoiceRequest(requestId, {
      answered: true,
      skipped: false,
      selected: [{ id: 'a', label: 'A' }],
    })

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(FIVE_MINUTES * 2)
    const answer = await promise
    expect(answer.answered).toBe(true)
    expect(answer.timedOut).toBeUndefined()
    expect(activeChoice().answer?.selected[0]?.id).toBe('a')
  })

  it('a turn ending under the card cancels the timer too', async () => {
    // `turn_completed` schedules unrelated timers of its own, so measure what
    // it leaves behind WITHOUT a card first, then insist a card adds nothing.
    vi.clearAllTimers()
    useAgentChatStore.getState().applyEvent({ type: 'turn_completed', threadId: 't1' })
    const baseline = vi.getTimerCount()
    vi.clearAllTimers()
    useAgentChatStore.setState({ threadId: 't1', messages: [], threadSlices: {} })

    const promise = useAgentChatStore.getState().ask(spec)
    expect(vi.getTimerCount()).toBe(1)

    useAgentChatStore.getState().applyEvent({ type: 'turn_completed', threadId: 't1' })

    expect(vi.getTimerCount()).toBe(baseline)
    const answer: ChoiceAnswer = await promise
    expect(answer.timedOut).toBeUndefined()
    expect(activeChoice().expired).toBe(true)
  })

  it('cancelling the run cancels the timer', async () => {
    ;(globalThis as any).window = globalThis
    ;(globalThis as any).electronAPI = { agent: { cancel: async () => undefined } }
    try {
      const promise = useAgentChatStore.getState().ask(spec)
      await useAgentChatStore.getState().cancel()
      expect(vi.getTimerCount()).toBe(0)
      await expect(promise).resolves.toMatchObject({ skipped: true })
    } finally {
      delete (globalThis as any).electronAPI
    }
  })

  describe('touchChoiceRequest (the user is clearly there)', () => {
    it('pushes the deadline back a full window from the touch', async () => {
      vi.setSystemTime(0)
      const promise = useAgentChatStore.getState().ask(spec)
      const { requestId } = activeChoice()

      vi.advanceTimersByTime(4 * 60 * 1000)
      useAgentChatStore.getState().touchChoiceRequest(requestId)
      expect(activeChoice().autoAdvanceAt).toBe(4 * 60 * 1000 + FIVE_MINUTES)

      // Original deadline passes — still pending.
      vi.advanceTimersByTime(4 * 60 * 1000)
      expect(activeChoice().status).toBe('pending')

      // One window after the touch — now it resolves.
      vi.advanceTimersByTime(60 * 1000)
      await expect(promise).resolves.toMatchObject({ timedOut: true })
    })

    it('leaves exactly one timer armed per card however often it is touched', () => {
      void useAgentChatStore.getState().ask(spec)
      const { requestId } = activeChoice()
      for (let i = 0; i < 20; i += 1) useAgentChatStore.getState().touchChoiceRequest(requestId)
      expect(vi.getTimerCount()).toBe(1)
    })

    it('touches a card in a background slice', () => {
      vi.setSystemTime(0)
      void useAgentChatStore.getState().ask(spec, 'background')
      const { requestId } = choiceIn(useAgentChatStore.getState().threadSlices['background'].messages)

      vi.advanceTimersByTime(60_000)
      useAgentChatStore.getState().touchChoiceRequest(requestId)

      const touched = choiceIn(useAgentChatStore.getState().threadSlices['background'].messages)
      expect(touched.autoAdvanceAt).toBe(60_000 + FIVE_MINUTES)
    })

    it('is a no-op for an unknown id or a card that is already settled', () => {
      void useAgentChatStore.getState().ask(spec)
      const { requestId } = activeChoice()
      const before = useAgentChatStore.getState().messages

      useAgentChatStore.getState().touchChoiceRequest('nope')
      expect(useAgentChatStore.getState().messages).toBe(before)

      useAgentChatStore.getState().settleChoiceRequest(requestId, {
        answered: true,
        skipped: false,
        selected: [{ id: 'a', label: 'A' }],
      })
      const settled = useAgentChatStore.getState().messages
      useAgentChatStore.getState().touchChoiceRequest(requestId)

      // No re-armed timer, no mutation of a frozen card.
      expect(vi.getTimerCount()).toBe(0)
      expect(useAgentChatStore.getState().messages).toBe(settled)
    })
  })
})
