// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSettingsCatalog,
  AgentModelSettingsEntry,
} from '../../../../../types/agent'
import { useAgentChatStore } from '../store'

function catalogEntry(
  id: string,
  overrides: Partial<AgentModelSettingsEntry> = {},
): AgentModelSettingsEntry {
  return {
    id,
    displayName: id,
    description: `${id} entry`,
    hidden: false,
    isDefault: false,
    family: 'other',
    route: {
      gatewayId: 'rightcode',
      channelId: 'rightcode-standard',
      modelId: id,
      family: 'other',
    },
    availability: { status: 'available' },
    capabilities: {
      model: id,
      provider: 'rightcode',
      defaultContextWindow: 272_000,
      contextOptions: [{ value: 272_000, experimental: false }],
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    },
    ...overrides,
  }
}

function catalog(): AgentModelSettingsCatalog {
  return {
    gatewayId: 'rightcode',
    revision: 'catalog-1',
    source: 'codex',
    models: [
      catalogEntry('gpt-5.5'),
      catalogEntry('grok-4.5', {
        route: {
          gatewayId: 'rightcode',
          channelId: 'rightcode-grok',
          modelId: 'grok-4.5',
          family: 'xai',
        },
        capabilities: {
          model: 'grok-4.5',
          provider: 'rightcode',
          defaultContextWindow: 1_000_000,
          contextOptions: [{ value: 1_000_000, experimental: false }],
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
        },
      }),
    ],
  }
}

function installAgentApi(agent: Record<string, unknown>): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { agent }
}

/** Neutralizes the post-adoption capability refresh (out of scope here). */
function stubCapabilityLoad(): void {
  useAgentChatStore.setState({
    loadCollaborationCapabilities: vi.fn(async () => undefined),
  } as never)
}

beforeEach(() => {
  localStorage.clear()
  useAgentChatStore.setState({
    threadId: undefined,
    messages: [],
    isRunning: false,
    error: undefined,
    tokenUsage: undefined,
    pendingApprovals: [],
    threadSlices: {},
    runningByThread: {},
    modelByThread: {},
    selectedModelId: 'gpt-5.5',
    modelSettingsCatalog: catalog(),
    modelSelectionPending: undefined,
    input: '',
    attachments: [],
    pendingReferences: [],
  } as never)
  stubCapabilityLoad()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('per-thread model binding (Plan B renderer mirror)', () => {
  it('switchThread adopts the opened threads persisted model into the picker', async () => {
    const openThread = vi.fn(async () => ({
      id: 'T1',
      model: 'grok-4.5',
      messages: [],
    }))
    installAgentApi({ openThread })

    await useAgentChatStore.getState().switchThread('T1')

    expect(openThread).toHaveBeenCalledWith('T1')
    expect(useAgentChatStore.getState().threadId).toBe('T1')
    expect(useAgentChatStore.getState().selectedModelId).toBe('grok-4.5')
    expect(useAgentChatStore.getState().modelByThread.T1).toBe('grok-4.5')
    // Adoption refreshes capability ownership for the new model.
    expect(
      useAgentChatStore.getState().loadCollaborationCapabilities,
    ).toHaveBeenCalled()
  })

  it('records but does NOT adopt a bound model missing from the current catalog', async () => {
    const openThread = vi.fn(async () => ({
      id: 'T2',
      model: 'off-catalog-model',
      messages: [],
    }))
    installAgentApi({ openThread })

    await useAgentChatStore.getState().switchThread('T2')

    expect(useAgentChatStore.getState().threadId).toBe('T2')
    // Picker keeps the servable global selection; mirror still remembers the row.
    expect(useAgentChatStore.getState().selectedModelId).toBe('gpt-5.5')
    expect(useAgentChatStore.getState().modelByThread.T2).toBe('off-catalog-model')
  })

  it('restores the mirror binding when switching back to a live background slice', async () => {
    const openThread = vi.fn()
    installAgentApi({ openThread })
    useAgentChatStore.setState({
      threadId: 'A',
      modelByThread: { B: 'grok-4.5' },
      threadSlices: {
        B: {
          messages: [],
          isRunning: false,
          tokenUsage: undefined,
          error: undefined,
        },
      },
    } as never)

    await useAgentChatStore.getState().switchThread('B')

    expect(openThread).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().threadId).toBe('B')
    expect(useAgentChatStore.getState().selectedModelId).toBe('grok-4.5')
  })

  it('keeps selection ownership while a selection transaction is pending', async () => {
    const openThread = vi.fn(async () => ({
      id: 'T3',
      model: 'grok-4.5',
      messages: [],
    }))
    installAgentApi({ openThread })
    useAgentChatStore.setState({
      modelSelectionPending: {
        gatewayId: 'rightcode',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        catalogRevision: 'catalog-1',
        requestVersion: 7,
      },
    } as never)

    await useAgentChatStore.getState().switchThread('T3')

    // The in-flight transaction owns `selectedModelId`; adoption is skipped.
    expect(useAgentChatStore.getState().selectedModelId).toBe('gpt-5.5')
    expect(useAgentChatStore.getState().modelByThread.T3).toBe('grok-4.5')
  })

  it('setSelectedModel confirmation records the active threads binding', async () => {
    const applyModelSelection = vi.fn(async (
      payload: AgentModelSelectionApplyPayload,
    ): Promise<AgentModelSelectionApplyResult> => ({
      ok: true,
      data: {
        gatewayId: 'rightcode',
        channelId: 'rightcode-grok',
        modelId: 'grok-4.5',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        catalogRevision: 'catalog-1',
        backendEpoch: 2,
        threadRestored: true,
        requestVersion: payload.requestVersion,
      },
    }))
    installAgentApi({ applyModelSelection })
    useAgentChatStore.setState({ threadId: 'T4' } as never)

    await expect(
      useAgentChatStore.getState().setSelectedModel('grok-4.5'),
    ).resolves.toBe(true)

    expect(applyModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'T4', modelId: 'grok-4.5' }),
    )
    expect(useAgentChatStore.getState().selectedModelId).toBe('grok-4.5')
    expect(useAgentChatStore.getState().modelByThread.T4).toBe('grok-4.5')
  })

  it('send mirrors the resolved model onto the resolved thread id', async () => {
    const sendMessage = vi.fn(async () => ({ threadId: 'NEW-T' }))
    const listThreads = vi.fn(async () => [])
    installAgentApi({ sendMessage, listThreads })
    useAgentChatStore.setState({
      input: 'hello there',
      selectedModelId: 'grok-4.5',
    } as never)

    await useAgentChatStore.getState().send()

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'grok-4.5' }),
    )
    expect(useAgentChatStore.getState().threadId).toBe('NEW-T')
    expect(useAgentChatStore.getState().modelByThread['NEW-T']).toBe('grok-4.5')
  })

  it('deleteThread drops the threads binding from the mirror', async () => {
    const deleteThread = vi.fn(async () => undefined)
    installAgentApi({ deleteThread })
    useAgentChatStore.setState({
      threadId: undefined,
      modelByThread: { GONE: 'grok-4.5', KEPT: 'gpt-5.5' },
    } as never)

    await useAgentChatStore.getState().deleteThread('GONE')

    expect(useAgentChatStore.getState().modelByThread).toEqual({
      KEPT: 'gpt-5.5',
    })
  })
})
