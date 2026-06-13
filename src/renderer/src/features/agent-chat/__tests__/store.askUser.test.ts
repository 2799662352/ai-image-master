import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'
import type { ChoiceRequestItem } from '../../../../../types/agent-timeline'

function lastChoice(): ChoiceRequestItem {
  const { messages } = useAgentChatStore.getState()
  return messages[messages.length - 1].items[0] as ChoiceRequestItem
}

beforeEach(() => {
  useAgentChatStore.setState({ messages: [], threadSlices: {} })
})

describe('ask / settleChoiceRequest', () => {
  it('ask appends a standalone assistant choiceRequest bubble (pending)', () => {
    void useAgentChatStore.getState().ask({
      question: '想要什么景别?',
      options: [
        { id: 'cu', label: '特写' },
        { id: 'wide', label: '广角' },
      ],
      mode: 'single',
      allowFreeText: true,
      allowSkip: true,
    })

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    const item = lastChoice()
    expect(item.type).toBe('choiceRequest')
    expect(item.status).toBe('pending')
    expect(item.question).toBe('想要什么景别?')
    expect(item.options.map((o) => o.id)).toEqual(['cu', 'wide'])
  })

  it('settleChoiceRequest resolves the awaited promise with the answer', async () => {
    const promise = useAgentChatStore.getState().ask({
      question: 'q',
      options: [{ id: 'a', label: 'A' }],
      mode: 'single',
      allowFreeText: false,
      allowSkip: true,
    })
    const { requestId } = lastChoice()

    useAgentChatStore.getState().settleChoiceRequest(requestId, {
      answered: true,
      skipped: false,
      selected: [{ id: 'a', label: 'A' }],
    })

    const answer = await promise
    expect(answer.answered).toBe(true)
    expect(answer.selected.map((o) => o.id)).toEqual(['a'])
  })

  it('settleChoiceRequest marks the SAME bubble answered in place (no new message)', () => {
    void useAgentChatStore.getState().ask({
      question: 'q',
      options: [{ id: 'a', label: 'A' }],
      mode: 'single',
      allowFreeText: false,
      allowSkip: true,
    })
    const { requestId } = lastChoice()
    useAgentChatStore.getState().settleChoiceRequest(requestId, {
      answered: true,
      skipped: false,
      selected: [{ id: 'a', label: 'A' }],
    })

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    const item = lastChoice()
    expect(item.status).toBe('answered')
    expect(item.answer?.selected[0]?.id).toBe('a')
    expect(item.endedAt).toBeTypeOf('number')
  })

  it('settles a card that lives in a background thread slice', async () => {
    // No active thread: route the card into a background slice via threadId.
    useAgentChatStore.setState({ threadId: 'active', messages: [], threadSlices: {} })
    const promise = useAgentChatStore.getState().ask(
      {
        question: 'q',
        options: [{ id: 'a', label: 'A' }],
        mode: 'single',
        allowFreeText: false,
        allowSkip: true,
      },
      'background',
    )
    const slice = useAgentChatStore.getState().threadSlices['background']
    const item = slice.messages[0].items[0] as ChoiceRequestItem
    expect(item.status).toBe('pending')

    useAgentChatStore.getState().settleChoiceRequest(item.requestId, {
      answered: false,
      skipped: true,
      selected: [],
    })

    const answer = await promise
    expect(answer.skipped).toBe(true)
    const settled = useAgentChatStore.getState().threadSlices['background'].messages[0]
      .items[0] as ChoiceRequestItem
    expect(settled.status).toBe('answered')
  })

  it('settleChoiceRequest on an unknown id is a no-op', () => {
    void useAgentChatStore.getState().ask({
      question: 'q',
      options: [],
      mode: 'single',
      allowFreeText: true,
      allowSkip: true,
    })
    const before = useAgentChatStore.getState().messages
    useAgentChatStore.getState().settleChoiceRequest('nope', {
      answered: false,
      skipped: true,
      selected: [],
    })
    expect(useAgentChatStore.getState().messages).toBe(before)
  })

  it('a settle after the card is answered/expired is ignored (no overwrite)', () => {
    void useAgentChatStore.getState().ask({
      question: 'q',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      mode: 'single',
      allowFreeText: false,
      allowSkip: true,
    })
    const { requestId } = lastChoice()
    useAgentChatStore.getState().settleChoiceRequest(requestId, {
      answered: true,
      skipped: false,
      selected: [{ id: 'a', label: 'A' }],
    })
    // Second settle (e.g. a stray double-click) must not overwrite the answer.
    useAgentChatStore.getState().settleChoiceRequest(requestId, {
      answered: true,
      skipped: false,
      selected: [{ id: 'b', label: 'B' }],
    })
    expect(lastChoice().answer?.selected[0]?.id).toBe('a')
  })

  describe('abandonment (cancel / deleteThread)', () => {
    it('cancel() resolves a pending card as skipped and freezes it', async () => {
      ;(globalThis as any).window = globalThis
      ;(globalThis as any).electronAPI = { agent: { cancel: async () => undefined } }
      useAgentChatStore.setState({ threadId: 'active', messages: [], threadSlices: {} })

      const promise = useAgentChatStore.getState().ask({
        question: 'q',
        options: [{ id: 'a', label: 'A' }],
        mode: 'single',
        allowFreeText: false,
        allowSkip: true,
      })
      expect(lastChoice().status).toBe('pending')

      await useAgentChatStore.getState().cancel()

      const answer = await promise
      expect(answer.skipped).toBe(true)
      expect(lastChoice().status).toBe('answered')
      delete (globalThis as any).electronAPI
    })

    it('deleteThread() resolves a pending card in a background slice', async () => {
      const deleted: string[] = []
      ;(globalThis as any).window = globalThis
      ;(globalThis as any).electronAPI = {
        agent: {
          deleteThread: async (id: string) => {
            deleted.push(id)
          },
          listThreads: async () => [],
        },
      }
      useAgentChatStore.setState({ threadId: 'active', messages: [], threadSlices: {} })

      const promise = useAgentChatStore.getState().ask(
        {
          question: 'q',
          options: [{ id: 'a', label: 'A' }],
          mode: 'single',
          allowFreeText: false,
          allowSkip: true,
        },
        'background',
      )

      await useAgentChatStore.getState().deleteThread('background')

      const answer = await promise
      expect(answer.skipped).toBe(true)
      expect(deleted).toContain('background')
      const settled = useAgentChatStore.getState().threadSlices['background']?.messages[0]
        ?.items[0] as ChoiceRequestItem
      expect(settled.status).toBe('answered')
      delete (globalThis as any).electronAPI
    })
  })
})
