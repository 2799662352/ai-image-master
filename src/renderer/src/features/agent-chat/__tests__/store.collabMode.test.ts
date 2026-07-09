// @vitest-environment jsdom
/**
 * Composer collaboration-mode (Plan) preset — renderer contract:
 *   1. `collabModeKind` defaults to 'default' (nothing extra on the wire).
 *   2. send() forwards `collaborationModeKind: 'plan'` ONLY when Plan is
 *      selected; otherwise the field is omitted entirely.
 *   3. Per-thread memory: setCollabMode remembers the choice for the active
 *      thread, switchThread restores it (unknown threads reset to 'default').
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'

const sendMessage = vi.fn()

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { sendMessage, onEvent: () => () => undefined },
  }
  useAgentChatStore.setState({
    threadId: 'thread-1',
    messages: [],
    isRunning: false,
    input: '',
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
    availablePluginMentions: [],
    selectedModelId: 'gpt-5.5',
    threadSlices: {},
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
    collabModeKind: 'default',
    collabModeByThread: {},
  } as never)
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('send() collaborationModeKind forwarding', () => {
  it('omits the field entirely in default mode', async () => {
    useAgentChatStore.setState({ input: 'hello' } as never)

    await useAgentChatStore.getState().send()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect('collaborationModeKind' in sendMessage.mock.calls[0][0]).toBe(false)
  })

  it("forwards 'plan' when Plan mode is selected", async () => {
    useAgentChatStore.getState().setCollabMode('plan')
    useAgentChatStore.setState({ input: 'plan this' } as never)

    await useAgentChatStore.getState().send()

    expect(sendMessage.mock.calls[0][0].collaborationModeKind).toBe('plan')
  })
})

describe('per-thread memory', () => {
  it('setCollabMode records the choice for the active thread', () => {
    useAgentChatStore.getState().setCollabMode('plan')
    expect(useAgentChatStore.getState().collabModeKind).toBe('plan')
    expect(useAgentChatStore.getState().collabModeByThread['thread-1']).toBe('plan')
  })

  it('switchThread restores the remembered mode, defaulting to "default"', async () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan', 'thread-2': 'default' },
      threadSlices: { 'thread-2': { messages: [], isRunning: false } },
    } as never)

    await useAgentChatStore.getState().switchThread('thread-2')
    expect(useAgentChatStore.getState().collabModeKind).toBe('default')

    useAgentChatStore.setState({
      threadSlices: { 'thread-3': { messages: [], isRunning: false } },
    } as never)
    await useAgentChatStore.getState().switchThread('thread-3')
    expect(useAgentChatStore.getState().collabModeKind).toBe('default')
  })
})
