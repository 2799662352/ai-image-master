import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useChatScroll } from '../useChatScroll'
import { useAgentChatStore } from '../store'
import type { Message } from '../../../../../types/agent-timeline'

// jsdom/happy-dom does no layout, so scrollHeight/clientHeight are 0 by
// default. Stub a fake scrollable element with controllable metrics.
function makeEl(scrollHeight: number, clientHeight: number): HTMLDivElement {
  return { scrollTop: 0, scrollHeight, clientHeight } as unknown as HTMLDivElement
}

const NO_MESSAGES: Message[] = []

afterEach(() => cleanup())

describe('useChatScroll — restore position on panel reopen (regression: 关闭再开滑轮回顶)', () => {
  beforeEach(() => {
    // Free-scroll thread parked at scrollTop 250 (not locked to bottom).
    useAgentChatStore.setState({
      chatScrollByThread: { t1: { scrollTop: 250, followBottom: false } },
    })
  })

  it('re-restores the saved free-scroll position when the container remounts after close', () => {
    const el = makeEl(1000, 400) // max scrollTop = 600
    const containerRef = { current: el as HTMLDivElement | null }

    const { rerender } = renderHook(
      (props: { isOpen: boolean }) =>
        useChatScroll({
          containerRef,
          threadId: 't1',
          messages: NO_MESSAGES,
          isOpen: props.isOpen,
        }),
      { initialProps: { isOpen: true } },
    )

    // Initial open restores the saved position (clamped to 0..600).
    expect(el.scrollTop).toBe(250)

    // Close: AgentChatPanel early-returns on !isOpen, the chat div unmounts,
    // its ref becomes null. The hook itself (and its refs) stays mounted.
    containerRef.current = null
    rerender({ isOpen: false })

    // Reopen: a *fresh* div mounts at scrollTop 0.
    const reopened = makeEl(1000, 400)
    containerRef.current = reopened
    rerender({ isOpen: true })

    // Pre-fix bug: restore effect never re-runs (deps [containerRef, threadId]
    // unchanged, guard already === threadId) so the new div stays at 0 = top.
    // Fix: reopen must re-restore to 250.
    expect(reopened.scrollTop).toBe(250)
  })

  it('re-glues a locked thread to the bottom on reopen', () => {
    useAgentChatStore.setState({
      chatScrollByThread: { t1: { scrollTop: 999, followBottom: true } },
    })
    const el = makeEl(1000, 400)
    const containerRef = { current: el as HTMLDivElement | null }

    const { rerender } = renderHook(
      (props: { isOpen: boolean }) =>
        useChatScroll({
          containerRef,
          threadId: 't1',
          messages: NO_MESSAGES,
          isOpen: props.isOpen,
        }),
      { initialProps: { isOpen: true } },
    )
    expect(el.scrollTop).toBe(1000) // glued to scrollHeight

    containerRef.current = null
    rerender({ isOpen: false })

    const reopened = makeEl(1000, 400)
    containerRef.current = reopened
    rerender({ isOpen: true })

    expect(reopened.scrollTop).toBe(1000)
  })
})
