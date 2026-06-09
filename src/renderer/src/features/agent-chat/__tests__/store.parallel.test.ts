import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '../../../../../types/agent'
import type { TextItem } from '../../../../../types/agent-timeline'
import { useAgentChatStore } from '../store'

function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

function delta(threadId: string, itemId: string, text: string): AgentStreamEvent {
  return {
    type: 'item_delta',
    threadId,
    turnId: `${threadId}-turn`,
    itemId,
    itemType: 'text',
    patch: { kind: 'appendText', field: 'content', text },
  }
}

function activeTextContent(): string {
  const msgs = useAgentChatStore.getState().messages
  const item = msgs.at(-1)?.items.find((i): i is TextItem => i.type === 'text')
  return item?.content ?? ''
}

function sliceTextContent(threadId: string): string {
  const slice = useAgentChatStore.getState().threadSlices[threadId]
  const item = slice?.messages.at(-1)?.items.find((i): i is TextItem => i.type === 'text')
  return item?.content ?? ''
}

beforeEach(() => {
  useAgentChatStore.setState({
    threadId: undefined,
    messages: [],
    isRunning: false,
    error: undefined,
    tokenUsage: undefined,
    pendingApprovals: [],
    threadSlices: {},
    runningByThread: {},
  })
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('agent chat store — parallel chats', () => {
  it('routes foreign-thread events to a background slice, leaving the active view untouched', () => {
    useAgentChatStore.setState({ threadId: 'A', runningByThread: { A: true, B: true } })

    applyEvent(delta('A', 'a-text', 'hello from A'))
    applyEvent(delta('B', 'b-text', 'hello from B'))

    // Active view (A) shows only A's stream.
    expect(activeTextContent()).toBe('hello from A')
    // B accumulates in the background slice (not lost, not leaked into A).
    expect(sliceTextContent('B')).toBe('hello from B')
  })

  it('clears the per-thread running flag for a background thread on turn_completed', () => {
    useAgentChatStore.setState({ threadId: 'A', runningByThread: { A: true, B: true } })

    applyEvent({ type: 'turn_completed', threadId: 'B', turnId: 'B-turn' })

    const running = useAgentChatStore.getState().runningByThread
    expect(running.B).toBeUndefined()
    expect(running.A).toBe(true) // A still running, untouched
  })

  it('newThread snapshots the running chat and does NOT leak its later events into the new empty chat', () => {
    useAgentChatStore.setState({ threadId: 'A', isRunning: true, runningByThread: { A: true } })
    applyEvent(delta('A', 'a-text', 'partial'))
    expect(activeTextContent()).toBe('partial')

    useAgentChatStore.getState().newThread()
    // The new chat is empty; A is preserved in the background.
    expect(useAgentChatStore.getState().threadId).toBeUndefined()
    expect(useAgentChatStore.getState().messages).toEqual([])
    expect(sliceTextContent('A')).toBe('partial')

    // A's turn keeps streaming in the background — it must NOT leak into the
    // new empty chat (the old single-active-thread bug).
    applyEvent(delta('A', 'a-text', ' more'))
    expect(useAgentChatStore.getState().messages).toEqual([])
    expect(sliceTextContent('A')).toBe('partial more')
  })

  it('does NOT adopt a background threads deltas into an unsaved new chat mid-send', () => {
    // Regression: previous task bleeding into the next chat. New chat is
    // mid-send (threadId undefined, isRunning true) while thread A still
    // streams in the background. A's deltas must NOT bind/leak into the new
    // chat — only the new chat's own thread_created may adopt.
    useAgentChatStore.setState({
      threadId: undefined,
      isRunning: true,
      messages: [],
      runningByThread: { A: true },
      threadSlices: {},
    })

    applyEvent(delta('A', 'a-text', 'A is still running'))

    // New chat stays unbound + empty; A's output stays in its background slice.
    expect(useAgentChatStore.getState().threadId).toBeUndefined()
    expect(activeTextContent()).toBe('')
    expect(sliceTextContent('A')).toBe('A is still running')

    // The new chat's OWN thread_created is what binds it.
    applyEvent({ type: 'thread_created', threadId: 'NEW' })
    expect(useAgentChatStore.getState().threadId).toBe('NEW')
    applyEvent(delta('NEW', 'n-text', 'new chat content'))
    expect(activeTextContent()).toBe('new chat content')
    // A never contaminated the new chat.
    expect(sliceTextContent('A')).toBe('A is still running')
  })

  it('adopts the first events real threadId for an unsaved new chat that was just sent into', () => {
    // Simulate the mid-send state: unsaved new chat (threadId undefined) with a
    // turn in flight (isRunning true), before sendMessage resolves the id.
    useAgentChatStore.setState({ threadId: undefined, isRunning: true })

    applyEvent({ type: 'thread_created', threadId: 'C' })
    applyEvent(delta('C', 'c-text', 'streamed into new chat'))

    expect(useAgentChatStore.getState().threadId).toBe('C')
    expect(activeTextContent()).toBe('streamed into new chat')
    expect(useAgentChatStore.getState().runningByThread.C).toBe(true)
  })

  it('pins generate_image bubbles to the requesting thread, not the active one', () => {
    // Requesting chat A is active when generation starts.
    useAgentChatStore.setState({ threadId: 'A', messages: [], threadSlices: {}, runningByThread: { A: true } })
    const genId = useAgentChatStore.getState().beginImageGeneration('a cat', 'A')
    // Generating bubble is in A's (active) view.
    const aMsgs = useAgentChatStore.getState().messages
    expect(aMsgs).toHaveLength(1)
    expect((aMsgs[0].items[0] as { status?: string }).status).toBe('generating')

    // User switches to B before the image finishes (A snapshots to background).
    useAgentChatStore.setState((s) => ({
      threadId: 'B',
      messages: [],
      threadSlices: { ...s.threadSlices, A: { messages: s.messages, isRunning: true } },
    }))

    // Image resolves — pinned to A, must NOT land in the active chat B.
    useAgentChatStore.getState().resolveImageGeneration(
      genId,
      [{ id: 'img1', kind: 'image', name: 'x.png', mime: 'image/png', size: 0, uri: 'data:image/png;base64,AAA' }],
      'A',
    )

    // Active chat B is still empty (no contamination).
    expect(useAgentChatStore.getState().messages).toEqual([])
    // A's background slice has the resolved image.
    const aSlice = useAgentChatStore.getState().threadSlices.A
    const item = aSlice.messages[0].items[0] as { status?: string; artifacts?: unknown[] }
    expect(item.status).toBe('done')
    expect(item.artifacts).toHaveLength(1)
  })

  it('switchThread restores a live background slice without hitting the server', () => {
    const openThread = vi.fn()
    ;(globalThis as unknown as { window: { electronAPI: { agent: { openThread: typeof openThread } } } }).window = {
      electronAPI: { agent: { openThread } },
    }
    // B ran in the background and completed; its slice holds the full convo.
    useAgentChatStore.setState({
      threadId: 'A',
      messages: [],
      threadSlices: {
        B: {
          messages: [
            { id: 'm1', role: 'assistant', createdAt: 1, items: [{ type: 'text', id: 'b-text', startedAt: 1, content: 'done in bg' }] },
          ],
          isRunning: false,
          tokenUsage: undefined,
          error: undefined,
        },
      },
    })

    void useAgentChatStore.getState().switchThread('B')

    expect(openThread).not.toHaveBeenCalled() // fresher bg slice used
    expect(useAgentChatStore.getState().threadId).toBe('B')
    expect(activeTextContent()).toBe('done in bg')
    // B is now the active view, so it's removed from the background map.
    expect(useAgentChatStore.getState().threadSlices.B).toBeUndefined()
  })
})
