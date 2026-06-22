// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'

const sendMessage = vi.fn()

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { sendMessage, listThreads: vi.fn().mockResolvedValue([]), onEvent: () => () => undefined },
  }
  useAgentChatStore.setState({
    threadId: 'thread-1',
    messages: [],
    isRunning: false,
    input: '把人物换成真人',
    attachments: [],
    pendingReferences: [],
    pendingCanvasContext: null,
    availableSkills: [],
    selectedModelId: 'gpt-5.5',
    threadSlices: {},
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
  })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('canvas-open hook', () => {
  it('notifyCanvasOpened stashes a one-shot [canvas] context note', () => {
    useAgentChatStore.getState().notifyCanvasOpened()
    expect(useAgentChatStore.getState().pendingCanvasContext).toContain('[canvas]')
  })

  it('prefixes the pending canvas note to the next sent turn, then clears it', async () => {
    useAgentChatStore.getState().notifyCanvasOpened()
    await useAgentChatStore.getState().send()

    const payload = sendMessage.mock.calls[0][0] as { content: string }
    // The hidden note rides in front of the user's text on the wire...
    expect(payload.content.startsWith('[canvas]')).toBe(true)
    expect(payload.content).toContain('把人物换成真人')
    // ...but is consumed after one turn so it never double-fires.
    expect(useAgentChatStore.getState().pendingCanvasContext).toBeNull()
  })

  it('keeps the visible user message clean (no [canvas] prefix shown to user)', async () => {
    useAgentChatStore.getState().notifyCanvasOpened()
    await useAgentChatStore.getState().send()

    const userMsg = useAgentChatStore.getState().messages.find((m) => m.role === 'user')
    const text = userMsg?.items.find((i) => i.type === 'text') as { content?: string } | undefined
    expect(text?.content).toBe('把人物换成真人')
  })

  it('does not prefix anything when the canvas was not opened', async () => {
    await useAgentChatStore.getState().send()
    const payload = sendMessage.mock.calls[0][0] as { content: string }
    expect(payload.content).toBe('把人物换成真人')
  })
})
