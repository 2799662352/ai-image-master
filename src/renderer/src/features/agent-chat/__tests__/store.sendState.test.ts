// @vitest-environment jsdom
// Batch 3-A: user-message delivery states (发送中/已送达/失败重试),
// docs/plans/2026-07-19-turn-notifications-and-send-status.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'

const sendMessage = vi.fn()
const listThreads = vi.fn()

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ threadId: 't1' })
  listThreads.mockReset().mockResolvedValue([])
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { sendMessage, listThreads, onEvent: () => () => undefined },
  }
  useAgentChatStore.setState({
    threadId: 't1',
    messages: [],
    isRunning: false,
    input: 'hello upstream',
    attachments: [],
    pendingReferences: [],
    failedSendSnapshots: {},
    availableSkills: [],
    selectedModelId: 'gpt-5.5',
    threadSlices: {},
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
    error: undefined,
  })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function lastMessage() {
  const { messages } = useAgentChatStore.getState()
  return messages[messages.length - 1]
}

describe('send() delivery states', () => {
  it('marks the optimistic bubble as sending, then sent once main admits the turn', async () => {
    let observedDuringFlight: string | undefined
    sendMessage.mockImplementation(async () => {
      observedDuringFlight = lastMessage()?.sendState
      return { threadId: 't1' }
    })

    await useAgentChatStore.getState().send()

    expect(observedDuringFlight).toBe('sending')
    expect(lastMessage()?.sendState).toBe('sent')
  })

  it('keeps the bubble in the timeline marked failed when the IPC rejects', async () => {
    sendMessage.mockRejectedValue(new Error('gateway exploded'))

    await useAgentChatStore.getState().send()

    const message = lastMessage()
    expect(message?.role).toBe('user')
    expect(message?.sendState).toBe('failed')
    // Text is NOT dumped back into the composer — it lives in the failed bubble.
    expect(useAgentChatStore.getState().input).toBe('')
    expect(useAgentChatStore.getState().error).toContain('gateway exploded')
    // Snapshot captured for retry.
    const snapshots = useAgentChatStore.getState().failedSendSnapshots
    expect(snapshots[message!.id]?.content).toBe('hello upstream')
    expect(useAgentChatStore.getState().isRunning).toBe(false)
  })

  it('retryFailedMessage replays the snapshot through send() and settles as sent', async () => {
    sendMessage.mockRejectedValueOnce(new Error('boom'))
    await useAgentChatStore.getState().send()
    const failedId = lastMessage()!.id

    sendMessage.mockResolvedValue({ threadId: 't1' })
    await useAgentChatStore.getState().retryFailedMessage(failedId)

    // Old failed bubble removed; the retry produced a fresh sent bubble.
    const { messages, failedSendSnapshots } = useAgentChatStore.getState()
    expect(messages.some((m) => m.id === failedId)).toBe(false)
    expect(lastMessage()?.sendState).toBe('sent')
    expect(failedSendSnapshots[failedId]).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
    // The replayed payload carries the original content.
    expect(sendMessage.mock.calls[1]?.[0]?.content).toBe('hello upstream')
  })

  it('retryFailedMessage preserves the draft the user typed before pressing 重试', async () => {
    sendMessage.mockRejectedValueOnce(new Error('boom'))
    await useAgentChatStore.getState().send()
    const failedId = lastMessage()!.id

    useAgentChatStore.setState({ input: 'my new draft' })
    sendMessage.mockResolvedValue({ threadId: 't1' })
    await useAgentChatStore.getState().retryFailedMessage(failedId)

    expect(useAgentChatStore.getState().input).toBe('my new draft')
  })

  it('a failed retry re-marks the new bubble failed with a fresh snapshot', async () => {
    sendMessage.mockRejectedValue(new Error('still down'))
    await useAgentChatStore.getState().send()
    const firstFailedId = lastMessage()!.id

    await useAgentChatStore.getState().retryFailedMessage(firstFailedId)

    const message = lastMessage()
    expect(message?.sendState).toBe('failed')
    expect(message?.id).not.toBe(firstFailedId)
    expect(useAgentChatStore.getState().failedSendSnapshots[message!.id]?.content)
      .toBe('hello upstream')
  })

  it('retryFailedMessage is a no-op for unknown ids and while a turn is running', async () => {
    await useAgentChatStore.getState().retryFailedMessage('nope')
    expect(sendMessage).not.toHaveBeenCalled()

    sendMessage.mockRejectedValueOnce(new Error('boom'))
    useAgentChatStore.setState({ input: 'x' })
    await useAgentChatStore.getState().send()
    const failedId = lastMessage()!.id

    useAgentChatStore.setState({ isRunning: true })
    await useAgentChatStore.getState().retryFailedMessage(failedId)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(lastMessage()?.sendState).toBe('failed')
  })
})
