// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentCollaborationCapabilitiesResult,
  AgentCollaborationModeUpdatePayload,
  AgentCollaborationModeUpdateResult,
  AgentSendMessagePayload,
  AgentSendMessageResult,
} from '../../../../../types/agent'
import {
  selectEffectivePlanReasoningEffort,
  useAgentChatStore,
} from '../store'

const PLAN_EFFORT_STORAGE_KEY = 'agent.planReasoningEffort:v1'
const THREAD_MODE_STORAGE_KEY = 'agent.collaborationModesByThread:v1'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

const sendMessage = vi.fn<
  (payload: AgentSendMessagePayload) => Promise<AgentSendMessageResult>
>()
const steer = vi.fn<
  (payload: AgentSendMessagePayload) => Promise<AgentSendMessageResult>
>()
const updateCollaborationMode = vi.fn<
  (payload: AgentCollaborationModeUpdatePayload) => Promise<AgentCollaborationModeUpdateResult>
>()
const getCollaborationCapabilities = vi.fn<
  (model: string) => Promise<AgentCollaborationCapabilitiesResult>
>()
const openThread = vi.fn<(threadId: string) => Promise<unknown>>()
const deleteThread = vi.fn<(threadId: string) => Promise<void>>()

beforeEach(() => {
  localStorage.clear()
  sendMessage.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  steer.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  updateCollaborationMode.mockReset().mockResolvedValue({
    ok: true,
    data: { compatibility: 'immediate', requestVersion: 1 },
  })
  getCollaborationCapabilities.mockReset().mockResolvedValue({
    ok: true,
    data: {
      providerId: 'apiyi',
      planDefaultEffort: 'medium',
      supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
      source: 'codex',
    },
  })
  openThread.mockReset().mockResolvedValue({ messages: [] })
  deleteThread.mockReset().mockResolvedValue(undefined)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: {
      sendMessage,
      steer,
      updateCollaborationMode,
      getCollaborationCapabilities,
      openThread,
      deleteThread,
      onEvent: () => () => undefined,
    },
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
    modelReasoningEffortByModel: {},
    modelContextWindowByModel: {},
    threadSlices: {},
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
    notices: [],
    collabModeKind: 'default',
    collabModeByThread: { 'thread-1': 'default' },
    collabModePendingByThread: {},
    collabModeRequestSequence: 0,
    collabModeRequestVersionByThread: {},
    collabModeLifecycleSequence: 0,
    collabModeLifecycleByThread: {},
    collabModeNavigationSequence: 0,
    collabModeCompatibility: 'immediate',
    collabModeCompatibilityByThread: { 'thread-1': 'immediate' },
    collabModeRestoredByThread: {},
    collabModeNextTurnByThread: {},
    planReasoningEffort: 'auto',
    collaborationCapabilities: {
      providerId: 'apiyi',
      planDefaultEffort: 'medium',
      supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
      source: 'codex',
    },
    collaborationCapabilitiesModel: 'gpt-5.5',
    deferredPlanEffortIntent: undefined,
    collaborationError: undefined,
    collaborationErrorByThread: {},
  } as never)
})

afterEach(() => {
  localStorage.clear()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('send and steer collaboration payloads', () => {
  it('always forwards Default and the Plan effort preference', async () => {
    useAgentChatStore.setState({ input: 'hello', planReasoningEffort: 'high' } as never)

    await useAgentChatStore.getState().send()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      collaborationModeKind: 'default',
      planReasoningEffort: 'high',
    })
  })

  it('forwards the exact new-thread draft on first send without update IPC', async () => {
    useAgentChatStore.setState({ threadId: undefined } as never)

    await useAgentChatStore.getState().requestCollabMode('plan')
    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')
    useAgentChatStore.setState({ input: 'plan this' } as never)
    await useAgentChatStore.getState().send()

    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      collaborationModeKind: 'plan',
      planReasoningEffort: 'xhigh',
    })
  })

  it('does not recreate a draft when same-mode server confirmation beats the new-thread send response', async () => {
    const response = deferred<AgentSendMessageResult>()
    sendMessage.mockReturnValue(response.promise)
    useAgentChatStore.setState({
      threadId: undefined,
      collabModeKind: 'plan',
      input: 'race',
    } as never)

    const sending = useAgentChatStore.getState().send()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-race',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'medium',
    })
    response.resolve({ threadId: 'thread-race' })
    await sending

    expect(useAgentChatStore.getState()).toMatchObject({
      threadId: 'thread-race',
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-race': 'plan' },
    })
    expect(useAgentChatStore.getState().collabModePendingByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeNextTurnByThread).toEqual({})
  })

  it('keeps an earlier authoritative server mode when it differs from the new-thread draft', async () => {
    const response = deferred<AgentSendMessageResult>()
    sendMessage.mockReturnValue(response.promise)
    useAgentChatStore.setState({
      threadId: undefined,
      collabModeKind: 'plan',
      input: 'race with override',
    } as never)

    const sending = useAgentChatStore.getState().send()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-race',
      mode: 'default',
      model: 'gpt-5.5',
      effort: null,
    })
    response.resolve({ threadId: 'thread-race' })
    await sending

    expect(useAgentChatStore.getState()).toMatchObject({
      threadId: 'thread-race',
      collabModeKind: 'default',
      collabModeByThread: { 'thread-race': 'default' },
    })
    expect(useAgentChatStore.getState().collabModePendingByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeNextTurnByThread).toEqual({})
  })

  it('keeps a new-thread first-send selection unconfirmed when no server event arrived', async () => {
    const response = deferred<AgentSendMessageResult>()
    sendMessage.mockReturnValue(response.promise)
    useAgentChatStore.setState({
      threadId: undefined,
      collabModeKind: 'plan',
      input: 'no confirmation yet',
    } as never)

    const sending = useAgentChatStore.getState().send()
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    response.resolve({ threadId: 'thread-unconfirmed' })
    await sending

    expect(useAgentChatStore.getState().collabModeKind).toBe('plan')
    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-unconfirmed')
    expect(useAgentChatStore.getState().collabModeNextTurnByThread).toEqual({
      'thread-unconfirmed': 'plan',
    })
  })

  it('does not issue a settings RPC on true steer but preserves fresh-turn fallback settings', async () => {
    useAgentChatStore.setState({
      input: 'interrupt',
      isRunning: true,
      collabModeKind: 'plan',
      planReasoningEffort: 'high',
    } as never)

    await useAgentChatStore.getState().steer()

    expect(steer).toHaveBeenCalledTimes(1)
    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(steer.mock.calls[0][0]).toMatchObject({
      collaborationModeKind: 'plan',
      planReasoningEffort: 'high',
    })
  })

  it('isolates Plan request/send/steer from ordinary effort and restores it for Default', async () => {
    updateCollaborationMode.mockImplementation(async (payload) => ({
      ok: true,
      data: {
        compatibility: 'immediate',
        requestVersion: payload.requestVersion,
      },
    }))
    useAgentChatStore.setState({
      input: 'plan with high',
      isRunning: false,
      selectedModelId: 'gpt-5.6-sol',
      modelReasoningEffortByModel: { 'gpt-5.6-sol': 'max' },
      collabModeKind: 'default',
      planReasoningEffort: 'high',
      collaborationCapabilities: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['high'],
        source: 'codex',
      },
      collaborationCapabilitiesModel: 'gpt-5.6-sol',
    } as never)

    await useAgentChatStore.getState().requestCollabMode('plan')
    const planRequest = updateCollaborationMode.mock.calls[0][0]
    expect(planRequest).toMatchObject({
      mode: 'plan',
      model: 'gpt-5.6-sol',
      planReasoningEffort: 'high',
    })
    expect(Object.prototype.hasOwnProperty.call(
      planRequest,
      'defaultReasoningEffort',
    )).toBe(false)

    await useAgentChatStore.getState().send()
    const planSend = sendMessage.mock.calls[0][0]
    expect(planSend).toMatchObject({
      model: 'gpt-5.6-sol',
      collaborationModeKind: 'plan',
      planReasoningEffort: 'high',
    })
    expect(Object.prototype.hasOwnProperty.call(planSend, 'reasoningEffort')).toBe(false)

    useAgentChatStore.setState({ input: 'interrupt Plan' } as never)
    await useAgentChatStore.getState().steer()
    const planSteer = steer.mock.calls[0][0]
    expect(planSteer).toMatchObject({
      model: 'gpt-5.6-sol',
      collaborationModeKind: 'plan',
      planReasoningEffort: 'high',
    })
    expect(Object.prototype.hasOwnProperty.call(planSteer, 'reasoningEffort')).toBe(false)

    useAgentChatStore.setState({ isRunning: false } as never)
    await useAgentChatStore.getState().requestCollabMode('default')
    expect(updateCollaborationMode.mock.calls[1][0]).toMatchObject({
      mode: 'default',
      model: 'gpt-5.6-sol',
      defaultReasoningEffort: 'max',
      planReasoningEffort: 'high',
    })

    useAgentChatStore.setState({ input: 'default with max' } as never)
    await useAgentChatStore.getState().send()
    expect(sendMessage.mock.calls[1][0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      collaborationModeKind: 'default',
      planReasoningEffort: 'high',
    })

    expect(useAgentChatStore.getState().planReasoningEffort).toBe('high')
  })

  it('uses effective Auto for true steer while an explicit preference is temporarily suppressed', async () => {
    useAgentChatStore.setState({
      input: 'interrupt safely',
      isRunning: true,
      collabModeKind: 'plan',
      planReasoningEffort: 'high',
      collaborationCapabilities: {
        planDefaultEffort: 'medium',
        supportedPlanEfforts: [],
        source: 'fallback',
      },
      collaborationCapabilitiesModel: 'gpt-5.5',
    } as never)

    await useAgentChatStore.getState().steer()

    expect(steer).toHaveBeenCalledWith(expect.objectContaining({
      collaborationModeKind: 'plan',
      planReasoningEffort: 'auto',
    }))
    expect(useAgentChatStore.getState().planReasoningEffort).toBe('high')
  })

  it('includes mode and effort when steer falls back to a fresh send', async () => {
    useAgentChatStore.setState({
      input: 'fresh turn',
      isRunning: false,
      collabModeKind: 'plan',
      planReasoningEffort: 'medium',
    } as never)

    await useAgentChatStore.getState().steer()

    expect(steer).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      collaborationModeKind: 'plan',
      planReasoningEffort: 'medium',
    })
  })
})

describe('existing-thread confirmed ownership', () => {
  it('settles a successful RPC acknowledgement and reconciles a later server event', async () => {
    useAgentChatStore.setState({
      selectedModelId: 'gpt-5.5',
      modelReasoningEffortByModel: { 'gpt-5.5': 'xhigh' },
    } as never)

    await useAgentChatStore.getState().requestCollabMode('plan')

    expect(updateCollaborationMode).toHaveBeenCalledWith({
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      planReasoningEffort: 'auto',
      requestVersion: 1,
    })
    expect(Object.prototype.hasOwnProperty.call(
      updateCollaborationMode.mock.calls[0][0],
      'defaultReasoningEffort',
    )).toBe(false)
    expect(useAgentChatStore.getState()).toMatchObject({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      collabModePendingByThread: {},
      collabModeCompatibility: 'immediate',
    })
    expect(localStorage.getItem(THREAD_MODE_STORAGE_KEY)).toBe('{"thread-1":"plan"}')

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'medium',
    })

    expect(useAgentChatStore.getState()).toMatchObject({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      collabModePendingByThread: {},
    })
    expect(localStorage.getItem(THREAD_MODE_STORAGE_KEY)).toBe('{"thread-1":"plan"}')
  })

  it('omits ordinary effort when the target mode is Default with Auto selected', async () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      modelReasoningEffortByModel: { 'gpt-5.5': 'auto' },
      planReasoningEffort: 'high',
    } as never)

    await useAgentChatStore.getState().requestCollabMode('default')

    const payload = updateCollaborationMode.mock.calls[0][0]
    expect(payload).toMatchObject({
      mode: 'default',
      model: 'gpt-5.5',
      planReasoningEffort: 'high',
    })
    expect(Object.prototype.hasOwnProperty.call(
      payload,
      'defaultReasoningEffort',
    )).toBe(false)
  })

  it('rejects mode changes while a turn is running', async () => {
    useAgentChatStore.setState({ isRunning: true } as never)

    await useAgentChatStore.getState().requestCollabMode('plan')

    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().collabModeKind).toBe('default')
    expect(useAgentChatStore.getState().collabModePendingByThread).toEqual({})
  })

  it('clears pending, retains confirmed mode, and shows a concise ordinary failure', async () => {
    updateCollaborationMode.mockResolvedValue({
      ok: false,
      error: 'timed out',
      requestVersion: 1,
    })

    await useAgentChatStore.getState().requestCollabMode('plan')

    expect(useAgentChatStore.getState()).toMatchObject({
      collabModeKind: 'default',
      collabModeByThread: { 'thread-1': 'default' },
      collabModePendingByThread: {},
    })
    expect(useAgentChatStore.getState().collaborationError).toContain('timed out')
  })

  it('updates a background thread map without contaminating active display', () => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      collabModeKind: 'default',
      collabModeByThread: { 'thread-1': 'default', 'thread-2': 'default' },
    } as never)

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-2',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })

    expect(useAgentChatStore.getState().collabModeKind).toBe('default')
    expect(useAgentChatStore.getState().collabModeByThread).toEqual({
      'thread-1': 'default',
      'thread-2': 'plan',
    })
  })

  it('ignores a stale response by thread and requestVersion', async () => {
    const first = deferred<AgentCollaborationModeUpdateResult>()
    const second = deferred<AgentCollaborationModeUpdateResult>()
    updateCollaborationMode
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstRequest = useAgentChatStore.getState().requestCollabMode('plan')
    const secondRequest = useAgentChatStore.getState().requestCollabMode('default')
    second.resolve({
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 2 },
    })
    await secondRequest
    first.resolve({ ok: false, error: 'stale failure', requestVersion: 1 })
    await firstRequest

    expect(useAgentChatStore.getState().collabModePendingByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeByThread['thread-1']).toBe('default')
    expect(useAgentChatStore.getState().collaborationError).toBeUndefined()
    expect(useAgentChatStore.getState().collaborationErrorByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeCompatibilityByThread).toEqual({
      'thread-1': 'immediate',
    })
  })

  it('keeps a next-turn target as draft without claiming server confirmation', async () => {
    updateCollaborationMode.mockResolvedValue({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 1 },
    })

    await useAgentChatStore.getState().requestCollabMode('plan')

    expect(useAgentChatStore.getState()).toMatchObject({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'default' },
      collabModePendingByThread: {},
      collabModeCompatibility: 'next-turn',
    })
    useAgentChatStore.setState({ input: 'next turn' } as never)
    await useAgentChatStore.getState().send()
    expect(sendMessage.mock.calls[0][0].collaborationModeKind).toBe('plan')
  })

  it('preserves a next-turn Plan draft across a late Default confirmation until Plan confirms', async () => {
    updateCollaborationMode.mockResolvedValue({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 1 },
    })
    await useAgentChatStore.getState().requestCollabMode('plan')

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-1',
      mode: 'default',
      model: 'gpt-5.5',
      effort: null,
    })

    expect(useAgentChatStore.getState()).toMatchObject({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'default' },
      collabModeNextTurnByThread: { 'thread-1': 'plan' },
      collabModeCompatibility: 'next-turn',
    })
    useAgentChatStore.setState({ input: 'still use plan' } as never)
    await useAgentChatStore.getState().send()
    expect(sendMessage.mock.calls[0][0].collaborationModeKind).toBe('plan')

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'medium',
    })

    expect(useAgentChatStore.getState()).toMatchObject({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      collabModeCompatibility: 'immediate',
    })
    expect(useAgentChatStore.getState().collabModeNextTurnByThread).toEqual({})
  })

  it('still calls Manager for later actions after next-turn compatibility', async () => {
    updateCollaborationMode
      .mockResolvedValueOnce({
        ok: true,
        data: { compatibility: 'next-turn', requestVersion: 1 },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { compatibility: 'next-turn', requestVersion: 2 },
      })

    await useAgentChatStore.getState().requestCollabMode('plan')
    await useAgentChatStore.getState().requestCollabMode('default')

    expect(updateCollaborationMode).toHaveBeenCalledTimes(2)
  })

  it('treats an unsolicited server value as authoritative and surfaces one restrained notice', () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    } as never)

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-1',
      mode: 'default',
      model: 'gpt-5.5',
      effort: null,
    })

    expect(useAgentChatStore.getState().collabModeKind).toBe('default')
    expect(useAgentChatStore.getState().collabModeByThread['thread-1']).toBe('default')
    expect(useAgentChatStore.getState().notices[0]?.message).toContain('Default')
  })
})

describe('Plan effort ownership and capabilities', () => {
  it('persists Plan effort globally without updating a Default thread', async () => {
    await useAgentChatStore.getState().setPlanReasoningEffort('high')

    expect(localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)).toBe('high')
    expect(useAgentChatStore.getState().planReasoningEffort).toBe('high')
    expect(useAgentChatStore.getState().collabModeByThread['thread-1']).toBe('default')
    expect(updateCollaborationMode).not.toHaveBeenCalled()
  })

  it('treats reselecting the active Plan effort as a no-op without pending state', async () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      planReasoningEffort: 'high',
    } as never)
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })

    await useAgentChatStore.getState().setPlanReasoningEffort('high')

    expect(updateCollaborationMode).toHaveBeenCalledTimes(1)
    expect(useAgentChatStore.getState().collabModePendingByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeRequestSequence).toBe(1)
  })

  it('retries the same Plan preference after an earlier settings update failed', async () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    } as never)
    updateCollaborationMode
      .mockResolvedValueOnce({ ok: false, error: 'timed out', requestVersion: 1 })
      .mockResolvedValueOnce({
        ok: true,
        data: { compatibility: 'immediate', requestVersion: 2 },
      })

    await useAgentChatStore.getState().setPlanReasoningEffort('high')
    await useAgentChatStore.getState().setPlanReasoningEffort('high')

    expect(updateCollaborationMode).toHaveBeenCalledTimes(2)
    expect(updateCollaborationMode.mock.calls[1][0]).toMatchObject({
      threadId: 'thread-1',
      mode: 'plan',
      planReasoningEffort: 'high',
      requestVersion: 2,
    })
  })

  it('normalises unsupported effort to confirmed Auto without creating pending state', async () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      collaborationCapabilities: {
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium'],
        source: 'codex',
      },
    } as never)
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'medium',
    })

    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')

    expect(useAgentChatStore.getState().planReasoningEffort).toBe('auto')
    expect(localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)).toBe('auto')
    expect(updateCollaborationMode).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'plan',
      planReasoningEffort: 'auto',
    }))
    expect(useAgentChatStore.getState().collabModePendingByThread).toEqual({})
  })

  it('immediately resubmits current Plan settings for an idle existing thread', async () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    } as never)

    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')

    expect(updateCollaborationMode).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      mode: 'plan',
      planReasoningEffort: 'xhigh',
    }))
    expect(useAgentChatStore.getState().collabModeByThread['thread-1']).toBe('plan')
  })

  it('treats old-owner capabilities as unloaded during a canonical model switch', async () => {
    const modelBCapabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(modelBCapabilities.promise)
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      collaborationCapabilities: {
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low'],
        source: 'codex',
      },
      collaborationCapabilitiesModel: 'gpt-5.5',
    } as never)

    useAgentChatStore.getState().setSelectedModel('gpt-5.4')
    await vi.waitFor(() => {
      expect(getCollaborationCapabilities).toHaveBeenCalledWith('gpt-5.4')
    })
    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')

    expect(useAgentChatStore.getState().planReasoningEffort).toBe('xhigh')
    expect(localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)).toBe('xhigh')
    expect(updateCollaborationMode).not.toHaveBeenCalled()

    modelBCapabilities.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['xhigh'],
        source: 'codex',
      },
    })
    await vi.waitFor(() => {
      expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.4')
    })
  })

  it('invalidates old Provider capabilities and drops its late response before reloading', async () => {
    const apiyiCapabilities = deferred<AgentCollaborationCapabilitiesResult>()
    const rightcodeCapabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities
      .mockReturnValueOnce(apiyiCapabilities.promise)
      .mockReturnValueOnce(rightcodeCapabilities.promise)
    useAgentChatStore.setState({
      planReasoningEffort: 'max',
      collaborationCapabilities: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: 'codex',
      },
      collaborationCapabilitiesModel: 'gpt-5.5',
    } as never)

    const staleLoad = useAgentChatStore.getState().loadCollaborationCapabilities('apiyi')
    await vi.waitFor(() => expect(getCollaborationCapabilities).toHaveBeenCalledTimes(1))

    useAgentChatStore.getState().invalidateCollaborationCapabilities()
    expect(useAgentChatStore.getState().collaborationCapabilities).toBeUndefined()
    expect(selectEffectivePlanReasoningEffort(useAgentChatStore.getState())).toBe('auto')

    const currentLoad = useAgentChatStore.getState().loadCollaborationCapabilities('rightcode')
    await vi.waitFor(() => expect(getCollaborationCapabilities).toHaveBeenCalledTimes(2))
    apiyiCapabilities.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: 'codex',
      },
    })
    await staleLoad
    expect(useAgentChatStore.getState().collaborationCapabilities).toBeUndefined()

    rightcodeCapabilities.resolve({
      ok: true,
      data: {
        providerId: 'rightcode',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
        source: 'codex',
      },
    })
    await currentLoad

    expect(useAgentChatStore.getState().collaborationCapabilities).toMatchObject({
      providerId: 'rightcode',
      supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
    })
    expect(useAgentChatStore.getState().planReasoningEffort).toBe('auto')
  })

  it('submits one deferred Plan effort update after matching capabilities confirm support', async () => {
    const modelBCapabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(modelBCapabilities.promise)
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    } as never)

    useAgentChatStore.getState().setSelectedModel('gpt-5.4')
    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')
    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toEqual({
      model: 'gpt-5.4',
      effort: 'xhigh',
      threadId: 'thread-1',
    })

    modelBCapabilities.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['high', 'xhigh'],
        source: 'codex',
      },
    })

    await vi.waitFor(() => expect(updateCollaborationMode).toHaveBeenCalledTimes(1))
    expect(updateCollaborationMode).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.4',
      planReasoningEffort: 'xhigh',
    }))
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()
  })

  it('never applies thread A deferred effort to thread B after switching', async () => {
    const capabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(capabilities.promise)
    useAgentChatStore.setState({
      threadId: 'thread-a',
      collabModeKind: 'plan',
      collabModeByThread: {
        'thread-a': 'plan',
        'thread-b': 'plan',
      },
      threadSlices: {
        'thread-b': { messages: [], isRunning: false },
      },
    } as never)

    useAgentChatStore.getState().setSelectedModel('gpt-5.4')
    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toEqual({
      model: 'gpt-5.4',
      effort: 'xhigh',
      threadId: 'thread-a',
    })

    await useAgentChatStore.getState().switchThread('thread-b')
    expect(useAgentChatStore.getState().threadId).toBe('thread-b')
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()
    // Exercise the final owner check independently of switchThread cleanup:
    // even a stale intent that survived a lifecycle race must not target B.
    useAgentChatStore.setState({
      deferredPlanEffortIntent: {
        model: 'gpt-5.4',
        effort: 'xhigh',
        threadId: 'thread-a',
      },
    } as never)
    capabilities.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['xhigh'],
        source: 'codex',
      },
    })

    await vi.waitFor(() => {
      expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.4')
    })
    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()

    await useAgentChatStore.getState().switchThread('thread-a')
    expect(useAgentChatStore.getState().threadId).toBe('thread-a')
    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()
  })

  it('invalidates a deferred effort when the canonical model changes again', async () => {
    const modelB = deferred<AgentCollaborationCapabilitiesResult>()
    const modelC = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities
      .mockReturnValueOnce(modelB.promise)
      .mockReturnValueOnce(modelC.promise)
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    } as never)

    useAgentChatStore.getState().setSelectedModel('gpt-5.4')
    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')
    useAgentChatStore.getState().setSelectedModel('gpt-5.6-terra')

    modelB.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['xhigh'],
        source: 'codex',
      },
    })
    modelC.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['xhigh'],
        source: 'codex',
      },
    })

    await vi.waitFor(() => {
      expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.6-terra')
    })
    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()
  })

  it('does not submit a stale deferred effort after preference changes or mode becomes Default', async () => {
    const preferenceCapabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(preferenceCapabilities.promise)
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    } as never)
    useAgentChatStore.getState().setSelectedModel('gpt-5.4')
    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')
    useAgentChatStore.setState({ planReasoningEffort: 'high' } as never)
    preferenceCapabilities.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['high', 'xhigh'],
        source: 'codex',
      },
    })
    await vi.waitFor(() => {
      expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.4')
    })
    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()

    const defaultCapabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(defaultCapabilities.promise)
    useAgentChatStore.setState({
      selectedModelId: 'gpt-5.5',
      collaborationCapabilitiesModel: 'gpt-5.4',
      collabModeKind: 'plan',
    } as never)
    void useAgentChatStore.getState().loadCollaborationCapabilities()
    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')
    useAgentChatStore.setState({ collabModeKind: 'default' } as never)
    defaultCapabilities.resolve({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['xhigh'],
        source: 'codex',
      },
    })
    await vi.waitFor(() => {
      expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.5')
    })
    expect(updateCollaborationMode).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()
  })

  it('keeps normal model effort isolated across Plan → Default → Plan', async () => {
    useAgentChatStore.setState({
      selectedModelId: 'gpt-5.5',
      modelReasoningEffortByModel: { 'gpt-5.5': 'xhigh' },
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
    } as never)
    await useAgentChatStore.getState().setPlanReasoningEffort('low')
    updateCollaborationMode.mockClear()

    await useAgentChatStore.getState().requestCollabMode('default')
    expect(updateCollaborationMode.mock.calls[0][0]).toMatchObject({
      mode: 'default',
      defaultReasoningEffort: 'xhigh',
      planReasoningEffort: 'low',
    })
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-1',
      mode: 'default',
      model: 'gpt-5.5',
      effort: 'xhigh',
    })
    await useAgentChatStore.getState().requestCollabMode('plan')
    expect(updateCollaborationMode.mock.calls[1][0]).toMatchObject({
      mode: 'plan',
      planReasoningEffort: 'low',
    })
    expect(Object.prototype.hasOwnProperty.call(
      updateCollaborationMode.mock.calls[1][0],
      'defaultReasoningEffort',
    )).toBe(false)
  })

  it('resets an unsupported saved effort to Auto and notifies only once', async () => {
    useAgentChatStore.setState({ planReasoningEffort: 'xhigh' } as never)
    localStorage.setItem(PLAN_EFFORT_STORAGE_KEY, 'xhigh')
    getCollaborationCapabilities.mockResolvedValue({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium'],
        source: 'codex',
      },
    })

    await useAgentChatStore.getState().loadCollaborationCapabilities()
    await useAgentChatStore.getState().loadCollaborationCapabilities()

    expect(useAgentChatStore.getState().planReasoningEffort).toBe('auto')
    expect(localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)).toBe('auto')
    expect(useAgentChatStore.getState().notices.filter(
      (notice) => notice.id === 'collaboration-plan-effort-reset',
    )).toHaveLength(1)
  })

  it('preserves saved High through fallback while effective payloads use Auto', async () => {
    useAgentChatStore.setState({
      planReasoningEffort: 'high',
      collaborationCapabilities: undefined,
      collaborationCapabilitiesModel: undefined,
    } as never)
    localStorage.setItem(PLAN_EFFORT_STORAGE_KEY, 'high')
    getCollaborationCapabilities.mockResolvedValue({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: null,
        supportedPlanEfforts: [],
        source: 'fallback',
      },
    })

    await useAgentChatStore.getState().loadCollaborationCapabilities()
    await useAgentChatStore.getState().requestCollabMode('plan')
    useAgentChatStore.setState({ input: 'safe fallback' } as never)
    await useAgentChatStore.getState().send()

    const state = useAgentChatStore.getState()
    expect(state.planReasoningEffort).toBe('high')
    expect(localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)).toBe('high')
    expect(selectEffectivePlanReasoningEffort(state)).toBe('auto')
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      planReasoningEffort: 'auto',
    }))
    expect(updateCollaborationMode).toHaveBeenCalledWith(expect.objectContaining({
      planReasoningEffort: 'auto',
    }))
  })

  it('restores effective High and resubmits exactly once when Codex capabilities recover', async () => {
    useAgentChatStore.setState({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-1': 'plan' },
      planReasoningEffort: 'high',
      collaborationCapabilities: undefined,
      collaborationCapabilitiesModel: undefined,
    } as never)
    localStorage.setItem(PLAN_EFFORT_STORAGE_KEY, 'high')
    getCollaborationCapabilities
      .mockResolvedValueOnce({
        ok: true,
        data: {
          providerId: 'apiyi',
          planDefaultEffort: null,
          supportedPlanEfforts: [],
          source: 'fallback',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          providerId: 'apiyi',
          planDefaultEffort: 'medium',
          supportedPlanEfforts: ['high'],
          source: 'codex',
        },
      })

    await useAgentChatStore.getState().loadCollaborationCapabilities()
    expect(selectEffectivePlanReasoningEffort(useAgentChatStore.getState())).toBe('auto')
    expect(updateCollaborationMode).not.toHaveBeenCalled()

    await useAgentChatStore.getState().loadCollaborationCapabilities()

    expect(selectEffectivePlanReasoningEffort(useAgentChatStore.getState())).toBe('high')
    expect(updateCollaborationMode).toHaveBeenCalledTimes(1)
    expect(updateCollaborationMode).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      planReasoningEffort: 'high',
    }))
    expect(useAgentChatStore.getState().deferredPlanEffortIntent).toBeUndefined()

    await useAgentChatStore.getState().loadCollaborationCapabilities()
    expect(updateCollaborationMode).toHaveBeenCalledTimes(1)
  })

  it('normalises an explicitly unsupported UI effort to Auto', async () => {
    useAgentChatStore.setState({
      collaborationCapabilities: {
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium'],
        source: 'codex',
      },
    } as never)

    await useAgentChatStore.getState().setPlanReasoningEffort('xhigh')

    expect(useAgentChatStore.getState().planReasoningEffort).toBe('auto')
    expect(localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)).toBe('auto')
  })

  it('loads capabilities with the selected canonical model when selection changes', async () => {
    useAgentChatStore.getState().setSelectedModel('gpt-5.6-sol')
    await vi.waitFor(() => {
      expect(getCollaborationCapabilities).toHaveBeenCalledWith('gpt-5.6-sol')
      expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.6-sol')
    })
  })

  it('degrades safely when the capabilities API fails without discarding useful state', async () => {
    useAgentChatStore.setState({
      collaborationCapabilities: undefined,
      collaborationCapabilitiesModel: undefined,
    } as never)
    getCollaborationCapabilities.mockRejectedValueOnce(new Error('transport down'))

    await expect(
      useAgentChatStore.getState().loadCollaborationCapabilities(),
    ).resolves.toBeUndefined()
    expect(useAgentChatStore.getState().planReasoningEffort).toBe('auto')
    expect(
      useAgentChatStore.getState().collaborationCapabilities?.source === 'fallback'
      || Boolean(useAgentChatStore.getState().collaborationError),
    ).toBe(true)

    const usefulCapabilities = {
      providerId: 'apiyi',
      planDefaultEffort: 'medium',
      supportedPlanEfforts: ['low', 'medium', 'high'],
      source: 'codex' as const,
    }
    useAgentChatStore.setState({
      planReasoningEffort: 'high',
      collaborationCapabilities: usefulCapabilities,
      collaborationCapabilitiesModel: 'gpt-5.5',
      collaborationError: undefined,
    } as never)
    getCollaborationCapabilities.mockResolvedValueOnce({
      ok: false,
      error: 'temporarily unavailable',
    })

    await expect(
      useAgentChatStore.getState().loadCollaborationCapabilities(),
    ).resolves.toBeUndefined()
    expect(useAgentChatStore.getState().planReasoningEffort).toBe('high')
    expect(useAgentChatStore.getState().collaborationCapabilities).toEqual(usefulCapabilities)
  })

  it('suppresses but preserves the preference when different-model capability loading fails', async () => {
    useAgentChatStore.setState({
      selectedModelId: 'gpt-5.4',
      planReasoningEffort: 'xhigh',
      collaborationCapabilities: {
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['high', 'xhigh'],
        source: 'codex',
      },
      collaborationCapabilitiesModel: 'gpt-5.5',
    } as never)
    localStorage.setItem(PLAN_EFFORT_STORAGE_KEY, 'xhigh')
    getCollaborationCapabilities.mockRejectedValueOnce(new Error('model catalog unavailable'))

    await useAgentChatStore.getState().loadCollaborationCapabilities()

    expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.4')
    expect(useAgentChatStore.getState().collaborationCapabilities).toEqual({
      providerId: 'unknown',
      planDefaultEffort: null,
      supportedPlanEfforts: [],
      source: 'fallback',
    })
    expect(useAgentChatStore.getState().planReasoningEffort).toBe('xhigh')
    expect(localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)).toBe('xhigh')
    expect(selectEffectivePlanReasoningEffort(useAgentChatStore.getState())).toBe('auto')
  })

  it('retains known Codex capabilities when the same model returns temporary fallback', async () => {
    const knownCapabilities = {
      providerId: 'apiyi',
      planDefaultEffort: 'medium',
      supportedPlanEfforts: ['low', 'medium', 'high'],
      source: 'codex' as const,
    }
    useAgentChatStore.setState({
      selectedModelId: 'gpt-5.5',
      modelReasoningEffortByModel: { 'gpt-5.5': 'xhigh' },
      planReasoningEffort: 'high',
      collaborationCapabilities: knownCapabilities,
      collaborationCapabilitiesModel: 'gpt-5.5',
    } as never)
    getCollaborationCapabilities.mockResolvedValueOnce({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: null,
        supportedPlanEfforts: [],
        source: 'fallback',
      },
    })

    await useAgentChatStore.getState().loadCollaborationCapabilities()

    expect(useAgentChatStore.getState().collaborationCapabilitiesModel).toBe('gpt-5.5')
    expect(useAgentChatStore.getState().collaborationCapabilities).toEqual(knownCapabilities)
    expect(useAgentChatStore.getState().planReasoningEffort).toBe('high')
    expect(selectEffectivePlanReasoningEffort(useAgentChatStore.getState())).toBe('high')
  })
})

describe('thread isolation and restart persistence', () => {
  it('restores target-thread mode on switch and lets server events override local cache', async () => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      collabModeKind: 'default',
      collabModeByThread: { 'thread-1': 'default', 'thread-2': 'plan' },
      threadSlices: { 'thread-2': { messages: [], isRunning: false } },
    } as never)

    await useAgentChatStore.getState().switchThread('thread-2')
    expect(useAgentChatStore.getState().collabModeKind).toBe('plan')

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-2',
      mode: 'default',
      model: 'gpt-5.5',
      effort: null,
    })
    expect(useAgentChatStore.getState().collabModeKind).toBe('default')
    expect(localStorage.getItem(THREAD_MODE_STORAGE_KEY)).toContain('"thread-2":"default"')
  })

  it('restores a next-turn target across thread switches without promoting it to confirmed', async () => {
    updateCollaborationMode.mockResolvedValue({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 1 },
    })
    useAgentChatStore.setState({
      threadId: 'thread-a',
      collabModeKind: 'default',
      collabModeByThread: { 'thread-a': 'default', 'thread-b': 'default' },
      threadSlices: { 'thread-b': { messages: [], isRunning: false } },
    } as never)

    await useAgentChatStore.getState().requestCollabMode('plan')
    await useAgentChatStore.getState().switchThread('thread-b')
    expect(useAgentChatStore.getState().collabModeKind).toBe('default')
    await useAgentChatStore.getState().switchThread('thread-a')

    expect(useAgentChatStore.getState().collabModeKind).toBe('plan')
    expect(useAgentChatStore.getState().collabModeByThread['thread-a']).toBe('default')
    expect(useAgentChatStore.getState().collabModeNextTurnByThread['thread-a']).toBe('plan')
  })

  it('never reuses requestVersion after delete and explicit same-id reopen', async () => {
    const oldResponse = deferred<AgentCollaborationModeUpdateResult>()
    const newResponse = deferred<AgentCollaborationModeUpdateResult>()
    updateCollaborationMode
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise)
    useAgentChatStore.setState({
      threadId: 'thread-a',
      collabModeKind: 'default',
      collabModeByThread: { 'thread-a': 'default' },
    } as never)

    const oldRequest = useAgentChatStore.getState().requestCollabMode('plan')
    await vi.waitFor(() => expect(updateCollaborationMode).toHaveBeenCalledTimes(1))
    const oldVersion = updateCollaborationMode.mock.calls[0][0].requestVersion

    await useAgentChatStore.getState().deleteThread('thread-a')
    await useAgentChatStore.getState().switchThread('thread-a')
    const newRequest = useAgentChatStore.getState().requestCollabMode('plan')
    await vi.waitFor(() => expect(updateCollaborationMode).toHaveBeenCalledTimes(2))
    const newVersion = updateCollaborationMode.mock.calls[1][0].requestVersion

    expect(newVersion).toBeGreaterThan(oldVersion)
    oldResponse.resolve({
      ok: false,
      error: 'old lifecycle failure',
      requestVersion: oldVersion,
    })
    await oldRequest
    expect(useAgentChatStore.getState().collabModePendingByThread['thread-a']).toEqual({
      target: 'plan',
      requestVersion: newVersion,
    })
    expect(useAgentChatStore.getState().collaborationErrorByThread['thread-a']).toBeUndefined()
    expect(useAgentChatStore.getState().collabModeByThread['thread-a']).toBeUndefined()

    newResponse.resolve({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: newVersion },
    })
    await newRequest
    expect(useAgentChatStore.getState().collabModePendingByThread['thread-a']).toBeUndefined()
    expect(useAgentChatStore.getState().collabModeNextTurnByThread['thread-a']).toBe('plan')
  })

  it('drops a capability failure that resolves while its owner remains deleted', async () => {
    const capabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(capabilities.promise)
    useAgentChatStore.setState({
      threadId: 'thread-a',
      collaborationCapabilities: undefined,
      collaborationCapabilitiesModel: undefined,
    } as never)

    const loading = useAgentChatStore.getState().loadCollaborationCapabilities()
    await vi.waitFor(() => expect(getCollaborationCapabilities).toHaveBeenCalledTimes(1))
    await useAgentChatStore.getState().deleteThread('thread-a')
    capabilities.resolve({ ok: false, error: 'deleted lifecycle failure' })
    await loading

    expect(useAgentChatStore.getState().collaborationErrorByThread).not.toHaveProperty('thread-a')
    expect(useAgentChatStore.getState().collaborationError).toBeUndefined()
    expect(useAgentChatStore.getState().collaborationCapabilities).toBeUndefined()
  })

  it('isolates reopened lifecycle from old capability results and accepts new requests', async () => {
    const oldCapabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(oldCapabilities.promise)
    useAgentChatStore.setState({
      threadId: 'thread-a',
      collaborationCapabilities: undefined,
      collaborationCapabilitiesModel: undefined,
    } as never)

    const oldLoading = useAgentChatStore.getState().loadCollaborationCapabilities()
    await vi.waitFor(() => expect(getCollaborationCapabilities).toHaveBeenCalledTimes(1))
    await useAgentChatStore.getState().deleteThread('thread-a')
    await useAgentChatStore.getState().switchThread('thread-a')
    oldCapabilities.resolve({ ok: false, error: 'old reopened failure' })
    await oldLoading

    expect(useAgentChatStore.getState().collaborationErrorByThread['thread-a']).toBeUndefined()
    expect(useAgentChatStore.getState().collaborationError).toBeUndefined()

    getCollaborationCapabilities
      .mockResolvedValueOnce({ ok: false, error: 'new lifecycle failure' })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          providerId: 'apiyi',
          planDefaultEffort: 'medium',
          supportedPlanEfforts: ['high'],
          source: 'codex',
        },
      })
    await useAgentChatStore.getState().loadCollaborationCapabilities()
    expect(useAgentChatStore.getState().collaborationErrorByThread['thread-a']).toContain(
      '暂不可用',
    )
    expect(useAgentChatStore.getState().collaborationError).toContain('暂不可用')

    await useAgentChatStore.getState().loadCollaborationCapabilities()
    expect(useAgentChatStore.getState().collaborationErrorByThread['thread-a']).toBeUndefined()
    expect(useAgentChatStore.getState().collaborationError).toBeUndefined()
    expect(useAgentChatStore.getState().collaborationCapabilities).toMatchObject({
      source: 'codex',
      supportedPlanEfforts: ['high'],
    })
  })

  it('drops a pending open when delete advances the same thread lifecycle', async () => {
    const opening = deferred<unknown>()
    openThread.mockReturnValueOnce(opening.promise)
    useAgentChatStore.setState({
      threadId: 'thread-current',
      collabModeByThread: { 'thread-current': 'default' },
    } as never)

    const switching = useAgentChatStore.getState().switchThread('thread-a')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('thread-a'))
    const openingGeneration =
      useAgentChatStore.getState().collabModeLifecycleByThread['thread-a']

    await useAgentChatStore.getState().deleteThread('thread-a')
    expect(useAgentChatStore.getState().collabModeLifecycleByThread['thread-a'])
      .toBeGreaterThan(openingGeneration)
    opening.resolve({ messages: [] })
    await switching

    expect(useAgentChatStore.getState().threadId).toBe('thread-current')
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-a',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-a')
  })

  it('keeps tombstone protection until a successful explicit reopen commits', async () => {
    const reopening = deferred<unknown>()
    useAgentChatStore.setState({
      threadId: 'thread-current',
      collabModeByThread: { 'thread-current': 'default' },
    } as never)
    await useAgentChatStore.getState().deleteThread('thread-a')
    const deletedGeneration =
      useAgentChatStore.getState().collabModeLifecycleByThread['thread-a']
    openThread.mockReturnValueOnce(reopening.promise)

    const switching = useAgentChatStore.getState().switchThread('thread-a')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('thread-a'))
    const reopenGeneration =
      useAgentChatStore.getState().collabModeLifecycleByThread['thread-a']
    expect(reopenGeneration).toBeGreaterThan(deletedGeneration)

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-a',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-a')

    reopening.resolve({ messages: [] })
    await switching
    expect(useAgentChatStore.getState()).toMatchObject({
      threadId: 'thread-a',
      collabModeKind: 'default',
    })

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-a',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(useAgentChatStore.getState()).toMatchObject({
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-a': 'plan' },
    })
  })

  it('never exposes maps or persistence when an explicit reopen fails', async () => {
    const reopening = deferred<unknown>()
    useAgentChatStore.setState({
      threadId: 'thread-current',
      collabModeByThread: { 'thread-a': 'plan' },
    } as never)
    localStorage.setItem(THREAD_MODE_STORAGE_KEY, JSON.stringify({ 'thread-a': 'plan' }))
    await useAgentChatStore.getState().deleteThread('thread-a')
    openThread.mockReturnValueOnce(reopening.promise)

    const switching = useAgentChatStore.getState().switchThread('thread-a')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('thread-a'))
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-a',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-a')

    reopening.reject(new Error('open failed'))
    await expect(switching).rejects.toThrow('open failed')

    expect(useAgentChatStore.getState().threadId).toBe('thread-current')
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-a',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-a')
    expect(localStorage.getItem(THREAD_MODE_STORAGE_KEY)).not.toContain('thread-a')
  })

  it('keeps A tombstoned when its explicit reopen becomes navigation-stale', async () => {
    const reopeningA = deferred<unknown>()
    openThread.mockImplementation((threadId) =>
      threadId === 'thread-a'
        ? reopeningA.promise
        : Promise.resolve({ messages: [] }),
    )
    useAgentChatStore.setState({ threadId: 'thread-current' } as never)
    await useAgentChatStore.getState().deleteThread('thread-a')

    const switchA = useAgentChatStore.getState().switchThread('thread-a')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('thread-a'))
    await useAgentChatStore.getState().switchThread('thread-b')
    expect(useAgentChatStore.getState().threadId).toBe('thread-b')

    reopeningA.resolve({ messages: [] })
    await switchA
    expect(useAgentChatStore.getState().threadId).toBe('thread-b')

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-a',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-a')
  })

  it('keeps the later delete authoritative over a pending explicit reopen', async () => {
    const reopening = deferred<unknown>()
    useAgentChatStore.setState({ threadId: 'thread-current' } as never)
    await useAgentChatStore.getState().deleteThread('thread-a')
    openThread.mockReturnValueOnce(reopening.promise)

    const switching = useAgentChatStore.getState().switchThread('thread-a')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('thread-a'))
    const reopenGeneration =
      useAgentChatStore.getState().collabModeLifecycleByThread['thread-a']
    await useAgentChatStore.getState().deleteThread('thread-a')
    expect(useAgentChatStore.getState().collabModeLifecycleByThread['thread-a'])
      .toBeGreaterThan(reopenGeneration)

    reopening.resolve({ messages: [] })
    await switching
    expect(useAgentChatStore.getState().threadId).toBe('thread-current')

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-a',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-a')
  })

  it('keeps the latest B navigation when an earlier A open resolves last', async () => {
    const openingA = deferred<unknown>()
    const openingB = deferred<unknown>()
    openThread.mockImplementation((threadId) =>
      threadId === 'thread-a' ? openingA.promise : openingB.promise,
    )
    useAgentChatStore.setState({ threadId: 'thread-current' } as never)

    const switchA = useAgentChatStore.getState().switchThread('thread-a')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('thread-a'))
    const switchB = useAgentChatStore.getState().switchThread('thread-b')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('thread-b'))

    openingB.resolve({ messages: [] })
    await switchB
    expect(useAgentChatStore.getState().threadId).toBe('thread-b')

    openingA.resolve({ messages: [] })
    await switchA
    expect(useAgentChatStore.getState().threadId).toBe('thread-b')
  })

  it('conservatively drops capability results after their generation is evicted', async () => {
    const capabilities = deferred<AgentCollaborationCapabilitiesResult>()
    getCollaborationCapabilities.mockReturnValueOnce(capabilities.promise)
    useAgentChatStore.setState({
      threadId: 'evicted-capability',
      collaborationCapabilities: undefined,
      collaborationCapabilitiesModel: undefined,
    } as never)

    const loading = useAgentChatStore.getState().loadCollaborationCapabilities()
    await vi.waitFor(() => expect(getCollaborationCapabilities).toHaveBeenCalledTimes(1))
    expect(useAgentChatStore.getState().collabModeLifecycleByThread['evicted-capability'])
      .toBeGreaterThan(0)
    for (let index = 0; index < 200; index += 1) {
      await useAgentChatStore.getState().deleteThread(`capability-eviction-${index}`)
    }
    expect(useAgentChatStore.getState().collabModeLifecycleByThread)
      .not.toHaveProperty('evicted-capability')

    capabilities.resolve({ ok: false, error: 'evicted stale result' })
    await loading
    expect(useAgentChatStore.getState().collaborationErrorByThread)
      .not.toHaveProperty('evicted-capability')
    expect(useAgentChatStore.getState().collaborationCapabilities).toBeUndefined()
  })

  it('conservatively drops open results after their generation is evicted', async () => {
    const opening = deferred<unknown>()
    openThread.mockReturnValueOnce(opening.promise)
    useAgentChatStore.setState({ threadId: 'thread-current' } as never)

    const switching = useAgentChatStore.getState().switchThread('evicted-open')
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledWith('evicted-open'))
    expect(useAgentChatStore.getState().collabModeLifecycleByThread['evicted-open'])
      .toBeGreaterThan(0)
    for (let index = 0; index < 200; index += 1) {
      await useAgentChatStore.getState().deleteThread(`open-eviction-${index}`)
    }
    expect(useAgentChatStore.getState().collabModeLifecycleByThread)
      .not.toHaveProperty('evicted-open')

    opening.resolve({ messages: [] })
    await switching
    expect(useAgentChatStore.getState().threadId).toBe('thread-current')
  })

  it('keeps a delayed thread B failure out of active thread A until switching back', async () => {
    const response = deferred<AgentCollaborationModeUpdateResult>()
    updateCollaborationMode.mockReturnValueOnce(response.promise)
    useAgentChatStore.setState({
      threadId: 'thread-b',
      collabModeKind: 'default',
      collabModeByThread: { 'thread-a': 'default', 'thread-b': 'default' },
      threadSlices: {
        'thread-a': { messages: [], isRunning: false },
      },
      collabModeCompatibilityByThread: {
        'thread-a': 'immediate',
        'thread-b': 'immediate',
      },
      collaborationErrorByThread: {},
    } as never)

    const request = useAgentChatStore.getState().requestCollabMode('plan')
    await vi.waitFor(() => expect(updateCollaborationMode).toHaveBeenCalledTimes(1))
    await useAgentChatStore.getState().switchThread('thread-a')
    response.resolve({ ok: false, error: 'B timed out', requestVersion: 1 })
    await request

    expect(useAgentChatStore.getState().threadId).toBe('thread-a')
    expect(useAgentChatStore.getState().collaborationError).toBeUndefined()
    expect(useAgentChatStore.getState().collaborationErrorByThread['thread-b']).toContain(
      'B timed out',
    )

    await useAgentChatStore.getState().switchThread('thread-b')
    expect(useAgentChatStore.getState().collaborationError).toContain('B timed out')
  })

  it('keeps A next-turn projection when background B confirmation becomes immediate', async () => {
    useAgentChatStore.setState({
      threadId: 'thread-a',
      collabModeKind: 'plan',
      collabModeByThread: { 'thread-a': 'default', 'thread-b': 'default' },
      collabModeNextTurnByThread: { 'thread-a': 'plan', 'thread-b': 'plan' },
      collabModeCompatibility: 'next-turn',
      collabModeCompatibilityByThread: {
        'thread-a': 'next-turn',
        'thread-b': 'next-turn',
      },
      threadSlices: {
        'thread-b': { messages: [], isRunning: false },
      },
    } as never)

    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-b',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })

    expect(useAgentChatStore.getState().collabModeCompatibility).toBe('next-turn')
    expect(useAgentChatStore.getState().collabModeCompatibilityByThread).toMatchObject({
      'thread-a': 'next-turn',
      'thread-b': 'immediate',
    })

    await useAgentChatStore.getState().switchThread('thread-b')
    expect(useAgentChatStore.getState().collabModeCompatibility).toBe('immediate')
  })

  it('projects immediate compatibility and no collaboration error for a new composer', () => {
    useAgentChatStore.setState({
      collabModeCompatibility: 'next-turn',
      collaborationError: 'thread error',
      collabModeCompatibilityByThread: { 'thread-1': 'next-turn' },
      collaborationErrorByThread: { 'thread-1': 'thread error' },
    } as never)

    useAgentChatStore.getState().newThread()

    expect(useAgentChatStore.getState()).toMatchObject({
      threadId: undefined,
      collabModeCompatibility: 'immediate',
      collaborationError: undefined,
    })
  })

  it('cleans lifecycle-local maps while retaining monotonic delete authorities', async () => {
    localStorage.setItem(THREAD_MODE_STORAGE_KEY, JSON.stringify({
      'thread-delete': 'plan',
      'thread-keep': 'default',
    }))
    useAgentChatStore.setState({
      threadId: 'thread-keep',
      collabModeByThread: { 'thread-delete': 'plan', 'thread-keep': 'default' },
      collabModePendingByThread: {
        'thread-delete': { target: 'default', requestVersion: 3 },
      },
      collabModeRequestSequence: 3,
      collabModeRequestVersionByThread: { 'thread-delete': 3, 'thread-keep': 1 },
      collabModeLifecycleSequence: 4,
      collabModeLifecycleByThread: { 'thread-delete': 4, 'thread-keep': 2 },
      collabModeRestoredByThread: { 'thread-delete': true },
      collabModeNextTurnByThread: { 'thread-delete': 'default' },
      collabModeCompatibilityByThread: {
        'thread-delete': 'next-turn',
        'thread-keep': 'immediate',
      },
      collaborationErrorByThread: {
        'thread-delete': 'delete me',
        'thread-keep': 'keep me',
      },
    } as never)

    await useAgentChatStore.getState().deleteThread('thread-delete')

    expect(deleteThread).toHaveBeenCalledWith('thread-delete')
    expect(useAgentChatStore.getState().collabModeByThread).toEqual({
      'thread-keep': 'default',
    })
    expect(useAgentChatStore.getState().collabModePendingByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeRequestVersionByThread).toEqual({
      'thread-keep': 1,
    })
    expect(useAgentChatStore.getState().collabModeRequestSequence).toBe(3)
    expect(useAgentChatStore.getState().collabModeLifecycleSequence).toBe(5)
    expect(useAgentChatStore.getState().collabModeLifecycleByThread).toEqual({
      'thread-keep': 2,
      'thread-delete': 5,
    })
    expect(useAgentChatStore.getState().collabModeRestoredByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeNextTurnByThread).toEqual({})
    expect(useAgentChatStore.getState().collabModeCompatibilityByThread).toEqual({
      'thread-keep': 'immediate',
    })
    expect(useAgentChatStore.getState().collaborationErrorByThread).toEqual({
      'thread-keep': 'keep me',
    })
    expect(JSON.parse(localStorage.getItem(THREAD_MODE_STORAGE_KEY) ?? '{}')).toEqual({
      'thread-keep': 'default',
    })
  })

  it('bounds lifecycle generations while keeping their scalar sequence monotonic', async () => {
    for (let index = 0; index < 205; index += 1) {
      await useAgentChatStore.getState().deleteThread(`lifecycle-cap-${index}`)
    }

    const state = useAgentChatStore.getState()
    expect(state.collabModeLifecycleSequence).toBe(205)
    expect(Object.keys(state.collabModeLifecycleByThread)).toHaveLength(200)
    expect(state.collabModeLifecycleByThread).not.toHaveProperty('lifecycle-cap-0')
    expect(state.collabModeLifecycleByThread).toHaveProperty('lifecycle-cap-204', 205)
  })

  it('drops late settings events after delete and accepts them after a real reopen', async () => {
    useAgentChatStore.setState({
      threadId: 'thread-keep',
      collabModeByThread: { 'thread-delete': 'default', 'thread-keep': 'default' },
    } as never)

    await useAgentChatStore.getState().deleteThread('thread-delete')
    // A delayed lifecycle notification from the deleted instance is not proof
    // that the same id was explicitly recreated.
    useAgentChatStore.getState().applyEvent({
      type: 'thread_created',
      threadId: 'thread-delete',
    })
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-delete',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'medium',
    })

    expect(useAgentChatStore.getState().collabModeByThread).not.toHaveProperty('thread-delete')
    expect(
      JSON.parse(localStorage.getItem(THREAD_MODE_STORAGE_KEY) ?? '{}'),
    ).not.toHaveProperty('thread-delete')

    await useAgentChatStore.getState().switchThread('thread-delete')
    useAgentChatStore.getState().applyEvent({
      type: 'thread_settings_updated',
      threadId: 'thread-delete',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'medium',
    })
    expect(useAgentChatStore.getState().collabModeByThread['thread-delete']).toBe('plan')
  })

  it('caps persisted thread collaboration modes to the latest 200 entries', () => {
    useAgentChatStore.setState({
      collabModeByThread: {},
      collabModeRestoredByThread: {},
    } as never)

    for (let index = 0; index < 205; index += 1) {
      useAgentChatStore.getState().applyEvent({
        type: 'thread_settings_updated',
        threadId: `thread-${index}`,
        mode: index % 2 === 0 ? 'plan' : 'default',
        model: 'gpt-5.5',
        effort: null,
      })
    }

    const persisted = JSON.parse(
      localStorage.getItem(THREAD_MODE_STORAGE_KEY) ?? '{}',
    ) as Record<string, string>
    expect(Object.keys(persisted)).toHaveLength(200)
    expect(persisted).not.toHaveProperty('thread-0')
    expect(persisted).not.toHaveProperty('thread-4')
    expect(persisted['thread-5']).toBe('default')
    expect(persisted['thread-204']).toBe('plan')
  })

  it('restores a persisted thread selection as unconfirmed and explicitly resubmits next turn', async () => {
    localStorage.setItem(PLAN_EFFORT_STORAGE_KEY, 'high')
    localStorage.setItem(THREAD_MODE_STORAGE_KEY, JSON.stringify({ persisted: 'plan' }))
    vi.resetModules()
    const { useAgentChatStore: freshStore } = await import('../store')

    expect(freshStore.getState().collabModeByThread).toEqual({ persisted: 'plan' })
    expect(freshStore.getState().collabModeRestoredByThread).toEqual({ persisted: true })
    await freshStore.getState().switchThread('persisted')
    freshStore.setState({ input: 'resume explicitly' } as never)
    await freshStore.getState().send()

    expect(sendMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      threadId: 'persisted',
      collaborationModeKind: 'plan',
      planReasoningEffort: 'auto',
    })
    expect(freshStore.getState().planReasoningEffort).toBe('high')
    expect(freshStore.getState().collabModeRestoredByThread).toEqual({ persisted: true })
  })

  it('restores persisted Max while dropping malformed and unknown thread modes safely', async () => {
    localStorage.setItem(PLAN_EFFORT_STORAGE_KEY, 'max')
    localStorage.setItem(THREAD_MODE_STORAGE_KEY, '{"good":"plan","bad":"unknown"}')
    vi.resetModules()
    const { useAgentChatStore: freshStore } = await import('../store')

    expect(freshStore.getState().planReasoningEffort).toBe('max')
    expect(freshStore.getState().collabModeByThread).toEqual({ good: 'plan' })

    localStorage.setItem(THREAD_MODE_STORAGE_KEY, '{broken')
    vi.resetModules()
    const { useAgentChatStore: malformedStore } = await import('../store')
    expect(malformedStore.getState().collabModeByThread).toEqual({})
  })
})
