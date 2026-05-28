import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject, UIEvent } from 'react'
import { computeFollowBottom, distanceFromBottom } from './chatScroll'
import { useAgentChatStore } from './store'
import type { Message } from '../../../../types/agent-timeline'

// Sentinel key used by the hook to track "no thread yet" so that the
// restore-effect still fires once a real threadId arrives.
const NO_THREAD = '__no_thread__'

/**
 * Wires the per-thread chat scroll state machine onto a DOM container.
 *
 * Responsibilities:
 *   1. **Restore** persisted scrollTop / followBottom when the panel mounts,
 *      the thread switches, or the panel reopens.
 *   2. **Auto-scroll to bottom** whenever new messages stream in *and* the
 *      current thread is in the locked state. Free-scroll threads stay put.
 *   3. **Track user intent** on scroll: distance > threshold → unlock; back
 *      inside threshold → re-lock. The store action handles persistence.
 *
 * Send-time re-locking is *not* this hook's job — it lives inside
 * `store.sendMessage`, which calls `lockChatScrollToBottom` so the next
 * render of this hook sees `followBottom=true` and auto-scrolls.
 */
export function useChatScroll(args: {
  containerRef: RefObject<HTMLDivElement | null>
  threadId: string | undefined
  messages: Message[]
}): {
  onScroll: (event: UIEvent<HTMLDivElement>) => void
} {
  const { containerRef, threadId, messages } = args

  const setChatScroll = useAgentChatStore((s) => s.setChatScroll)
  // Read the *current* slice synchronously — we don't subscribe to it because
  // we'd otherwise loop (onScroll → setChatScroll → state change → restore
  // → onScroll). Restore only fires when threadId itself changes.
  const lastRestoredThreadIdRef = useRef<string | null>(null)
  const followBottomRef = useRef<boolean>(true)

  // Subscribe just to the bit we need to drive the auto-scroll *effect* —
  // followBottom flipping false→true (because send re-locked) must trigger
  // a scrollToBottom on the next layout.
  const followBottom = useAgentChatStore((s) => {
    if (!threadId) return true
    return s.chatScrollByThread[threadId]?.followBottom ?? true
  })
  followBottomRef.current = followBottom

  // ----- Restore on thread change / first mount with thread -----
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const key = threadId ?? NO_THREAD
    if (lastRestoredThreadIdRef.current === key) return
    lastRestoredThreadIdRef.current = key

    const stored = threadId
      ? useAgentChatStore.getState().chatScrollByThread[threadId]
      : undefined
    if (!stored || stored.followBottom) {
      // Default / locked → glue to bottom.
      el.scrollTop = el.scrollHeight
    } else {
      // Free-scroll thread → restore exact scrollTop (clamped to current
      // content height in case messages shrunk while away).
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.max(0, Math.min(stored.scrollTop, max))
    }
  }, [containerRef, threadId])

  // ----- Auto-scroll to bottom whenever messages tick and we're locked -----
  useLayoutEffect(() => {
    if (!followBottomRef.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    // Sync persisted scrollTop so that a subsequent reload doesn't restore
    // a stale value below `scrollHeight - clientHeight`.
    if (threadId) {
      setChatScroll(threadId, { scrollTop: el.scrollTop, followBottom: true })
    }
    // `followBottom` is in deps too so a remote re-lock (e.g. sendMessage)
    // immediately snaps to bottom, not on the next message tick.
  }, [messages, followBottom, containerRef, threadId, setChatScroll])

  // ----- Track user scrolling -----
  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!threadId) return
      const el = event.currentTarget
      const dist = distanceFromBottom({
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
      })
      const nextFollow = computeFollowBottom(dist)
      setChatScroll(threadId, { scrollTop: el.scrollTop, followBottom: nextFollow })
    },
    [threadId, setChatScroll],
  )

  return { onScroll }
}
