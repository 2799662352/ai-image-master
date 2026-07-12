/**
 * AgentManager → collaborationMode wiring: the renderer only sends a preset
 * KIND (`collaborationModeKind: 'plan'`); the manager expands it into the full
 * codex `CollaborationMode` (mode + settings with the resolved model) on
 * AgentInput so CodexProtocolClient forwards it via `turn/start`.
 * `settings.developer_instructions: null` deliberately means "use codex's
 * built-in mode instructions". Explicit Plan/Default are expanded; only an
 * absent kind leaves the input untouched for legacy callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type {
  AgentCollaborationModeUpdatePayload,
  AgentStreamEvent,
} from '../../../types/agent'
import type {
  CodexModel,
  CodexModelListParams,
  CodexModelListResponse,
  CollaborationModeListResponse,
  ThreadSettingsUpdateParams,
} from '../codexProtocol'

interface BackendCall {
  threadId: string | undefined
  input: AgentInput
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-collab-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeBackend(): IAgentBackend & { calls: BackendCall[] } {
  const calls: BackendCall[] = []
  return {
    calls,
    async start() { },
    async stop() { },
    isHealthy() { return true },
    async cancel() { },
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
    },
  }
}

/**
 * Backend variant that also exposes `collaborationMode/list` (like the real
 * CodexLocalBackend). The upstream Plan preset mask carries
 * `reasoning_effort: "medium"` — per app-server README, "the Plan preset
 * selects medium reasoning effort" while presets never select a model.
 */
function makeBackendWithPresets(
  listImpl: () => Promise<CollaborationModeListResponse>,
): IAgentBackend & { calls: BackendCall[]; listCalls: number } {
  const base = makeBackend()
  const backend = base as IAgentBackend & { calls: BackendCall[]; listCalls: number }
  backend.listCalls = 0
  backend.listCollaborationModes = async () => {
    backend.listCalls += 1
    return listImpl()
  }
  backend.listModels = async () => ({
    data: [
      modelRow({
        id: 'gpt-5.2-codex',
        model: 'gpt-5.2-codex',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'low' },
          { reasoningEffort: 'medium', description: 'medium' },
          { reasoningEffort: 'high', description: 'high' },
          { reasoningEffort: 'xhigh', description: 'xhigh' },
        ],
      }),
      modelRow({
        id: 'gpt-5.5',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'low' },
          { reasoningEffort: 'medium', description: 'medium' },
          { reasoningEffort: 'high', description: 'high' },
          { reasoningEffort: 'xhigh', description: 'xhigh' },
          { reasoningEffort: 'max', description: 'max' },
        ],
      }),
    ],
    nextCursor: null,
  })
  return backend
}

const UPSTREAM_PRESETS: CollaborationModeListResponse = {
  data: [
    { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
    { name: 'Code', mode: 'default', model: null, reasoning_effort: null },
  ],
}

function modelRow(overrides: Partial<CodexModel> = {}): CodexModel {
  return {
    id: 'gpt-5.5-high',
    model: 'gpt-5.5',
    displayName: 'GPT-5.5 High',
    description: 'test model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'minimal', description: 'not a Plan option' },
      { reasoningEffort: 'high', description: 'high' },
      { reasoningEffort: 'low', description: 'low' },
      { reasoningEffort: 'high', description: 'duplicate' },
    ],
    defaultReasoningEffort: 'high',
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: true,
    upgrade: null,
    ...overrides,
  }
}

interface CollaborationBackend extends IAgentBackend {
  calls: BackendCall[]
  listCalls: number
  modelCalls: CodexModelListParams[]
  updateCalls: ThreadSettingsUpdateParams[]
  restartCalls: number
  resumeCalls: string[]
  queuedThreadIds: string[]
  healthy: boolean
  epoch?: number
}

function makeCollaborationBackend(options: {
  listModes?: () => Promise<CollaborationModeListResponse>
  listModels?: (params?: CodexModelListParams) => Promise<CodexModelListResponse>
  updateThreadSettings?: (params: ThreadSettingsUpdateParams) => Promise<Record<string, never>>
  restartCodex?: (backend: CollaborationBackend) => Promise<void>
  resumeThread?: (threadId: string) => Promise<void>
  queuedThreadIds?: string[]
  healthy?: boolean
  initialEpoch?: number
} = {}): CollaborationBackend {
  const calls: BackendCall[] = []
  const backend: CollaborationBackend = {
    calls,
    listCalls: 0,
    modelCalls: [],
    updateCalls: [],
    restartCalls: 0,
    resumeCalls: [],
    queuedThreadIds: [...(options.queuedThreadIds ?? [])],
    healthy: options.healthy ?? true,
    epoch: options.initialEpoch,
    async start() { },
    async stop() { },
    isHealthy() { return backend.healthy },
    async cancel() { },
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
      const createdThreadId = backend.queuedThreadIds.shift()
      if (createdThreadId) {
        yield { type: 'thread_created', threadId: createdThreadId }
        yield { type: 'turn_completed', threadId: createdThreadId }
      }
    },
  }
  if (options.listModes) {
    backend.listCollaborationModes = async () => {
      backend.listCalls += 1
      return options.listModes!()
    }
  }
  const listModels = options.listModels
    ?? (options.updateThreadSettings
      ? async () => ({
          data: [modelRow({
            id: 'gpt-5.5',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'low' },
              { reasoningEffort: 'medium', description: 'medium' },
              { reasoningEffort: 'high', description: 'high' },
              { reasoningEffort: 'xhigh', description: 'xhigh' },
              { reasoningEffort: 'max', description: 'max' },
            ],
          })],
          nextCursor: null,
        })
      : undefined)
  if (listModels) {
    backend.listModels = async (params) => {
      backend.modelCalls.push(params ?? {})
      return listModels(params)
    }
  }
  if (options.updateThreadSettings) {
    backend.updateThreadSettings = async (params) => {
      backend.updateCalls.push(params)
      return options.updateThreadSettings!(params)
    }
  }
  if (options.restartCodex) {
    backend.restartCodex = async () => {
      backend.restartCalls += 1
      await options.restartCodex!(backend)
    }
  }
  if (options.resumeThread) {
    backend.resumeThread = async (threadId) => {
      backend.resumeCalls.push(threadId)
      await options.resumeThread!(threadId)
    }
  }
  if (options.initialEpoch !== undefined) {
    backend.currentEpoch = () => backend.epoch!
  }
  return backend
}

function makeManager(
  backend: IAgentBackend,
  eventSink?: (event: AgentStreamEvent) => void,
): AgentManager {
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async () => ({ id: 'msg-1' }),
      updateLastMessageAt: async () => undefined,
    } as any,
    attachments: { ingest: async () => [] } as any,
    eventSink,
  })
}

function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

const UPDATE_PAYLOAD: AgentCollaborationModeUpdatePayload = {
  threadId: 'db-thread-1',
  mode: 'plan',
  model: 'gpt-5.5',
  defaultReasoningEffort: 'high',
  planReasoningEffort: 'high',
  requestVersion: 7,
}

async function createCodexThreadMapping(
  manager: AgentManager,
  dbThreadId = 'db-thread-1',
): Promise<void> {
  await manager.sendMessage({
    threadId: dbThreadId,
    content: 'create mapping',
    attachments: [],
  })
  await flushMicrotasks(20)
}

describe('AgentManager collaborationMode', () => {
  it("expands 'plan' using the upstream preset mask (reasoning_effort: medium)", async () => {
    const backend = makeBackendWithPresets(async () => UPSTREAM_PRESETS)
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({
      content: 'plan this',
      attachments: [],
      model: 'gpt-5.2-codex',
      collaborationModeKind: 'plan',
    })
    await flushMicrotasks()

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.2-codex',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })

  it('caches collaborationMode/list across plan turns (single RPC)', async () => {
    const backend = makeBackendWithPresets(async () => UPSTREAM_PRESETS)
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'a', attachments: [], collaborationModeKind: 'plan' })
    await flushMicrotasks()
    await mgr.sendMessage({ content: 'b', attachments: [], collaborationModeKind: 'plan' })
    await flushMicrotasks()

    expect(backend.calls).toHaveLength(2)
    expect(backend.listCalls).toBe(1)
  })

  it('does not call collaborationMode/list for default turns', async () => {
    const backend = makeBackendWithPresets(async () => UPSTREAM_PRESETS)
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [] })
    await flushMicrotasks()

    expect(backend.listCalls).toBe(0)
  })

  it('falls back to Plan Auto reasoning_effort: medium when collaborationMode/list rejects', async () => {
    const backend = makeBackendWithPresets(async () => {
      throw new Error('experimental RPC unavailable')
    })
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({
      content: 'plan this',
      attachments: [],
      model: 'gpt-5.2-codex',
      collaborationModeKind: 'plan',
    })
    await flushMicrotasks()

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.2-codex',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })

  it('retries the preset fetch on the next plan turn after a failure', async () => {
    let failFirst = true
    const backend = makeBackendWithPresets(async () => {
      if (failFirst) {
        failFirst = false
        throw new Error('transient')
      }
      return UPSTREAM_PRESETS
    })
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'a', attachments: [], collaborationModeKind: 'plan' })
    await flushMicrotasks()
    await mgr.sendMessage({ content: 'b', attachments: [], collaborationModeKind: 'plan' })
    await flushMicrotasks()

    expect(backend.listCalls).toBe(2)
    expect(backend.calls[1].input.collaborationMode?.settings.reasoning_effort).toBe('medium')
  })

  it("does not fabricate Plan Auto effort when the backend exposes no model capabilities", async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({
      content: 'plan this',
      attachments: [],
      model: 'gpt-5.2-codex',
      collaborationModeKind: 'plan',
    })
    await flushMicrotasks()

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.2-codex',
        reasoning_effort: null,
        developer_instructions: null,
      },
    })
  })

  it('leaves collaborationMode off the input when no kind is sent', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [] })
    await flushMicrotasks()

    expect(backend.calls[0].input.collaborationMode).toBeUndefined()
  })

  it("expands explicit 'default' with the canonical model and normal picker effort", async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({
      content: 'hello',
      attachments: [],
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      collaborationModeKind: 'default',
      planReasoningEffort: 'low',
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    })
  })
})

describe('AgentManager collaboration mode effort isolation', () => {
  it('uses the official Plan preset for Plan Auto', async () => {
    const backend = makeBackendWithPresets(async () => UPSTREAM_PRESETS)
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')

    await manager.sendMessage({
      content: 'plan auto',
      attachments: [],
      model: 'gpt-5.5',
      reasoningEffort: 'low',
      collaborationModeKind: 'plan',
      planReasoningEffort: 'auto',
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.collaborationMode?.settings.reasoning_effort).toBe('medium')
  })

  it('uses the first supported effort when Plan Auto preset and medium are unsupported', async () => {
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({
          id: 'gpt-5.5',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'only supported effort' },
          ],
        })],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')

    await manager.sendMessage({
      content: 'plan safely',
      attachments: [],
      model: 'gpt-5.5',
      collaborationModeKind: 'plan',
      planReasoningEffort: 'auto',
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.collaborationMode?.settings.reasoning_effort).toBe('low')
  })

  it('blocks explicit Plan Max on Right Code gpt-5.5 before a send reaches the backend', async () => {
    const events: AgentStreamEvent[] = []
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({
          id: 'gpt-5.5',
          supportedReasoningEfforts: [
            { reasoningEffort: 'xhigh', description: 'supported' },
            { reasoningEffort: 'max', description: 'filtered by provider' },
          ],
        })],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend, (event) => events.push(event))
    await manager.setActiveProvider('rightcode')
    await manager.setCodexApiKey('sk-test')

    await manager.sendMessage({
      content: 'must not send',
      attachments: [],
      model: 'gpt-5.5',
      collaborationModeKind: 'plan',
      planReasoningEffort: 'max',
    })
    await flushMicrotasks()

    expect(backend.calls).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      error: expect.stringMatching(/max.*not supported/i),
    }))
  })

  it('allows explicit Plan Max on Right Code gpt-5.6-sol send', async () => {
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6-sol',
          supportedReasoningEfforts: [
            { reasoningEffort: 'max', description: 'supported' },
          ],
        })],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')
    await manager.setCodexApiKey('sk-test')

    await manager.sendMessage({
      content: 'use max',
      attachments: [],
      model: 'gpt-5.6-sol',
      collaborationModeKind: 'plan',
      planReasoningEffort: 'max',
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.collaborationMode?.settings.reasoning_effort).toBe('max')
  })

  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'uses explicit Plan %s without requesting the preset',
    async (planReasoningEffort) => {
      const backend = makeBackendWithPresets(async () => UPSTREAM_PRESETS)
      const manager = makeManager(backend)
      await manager.setCodexApiKey('sk-test')

      await manager.sendMessage({
        content: `plan ${planReasoningEffort}`,
        attachments: [],
        model: 'gpt-5.5',
        reasoningEffort: 'low',
        collaborationModeKind: 'plan',
        planReasoningEffort,
      })
      await flushMicrotasks()

      expect(backend.calls[0].input.collaborationMode?.settings.reasoning_effort)
        .toBe(planReasoningEffort)
      expect(backend.listCalls).toBe(0)
    },
  )

  it('does not let a Plan effort preference contaminate explicit Default', async () => {
    const backend = makeBackendWithPresets(async () => UPSTREAM_PRESETS)
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')

    await manager.sendMessage({
      content: 'default high',
      attachments: [],
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      collaborationModeKind: 'default',
      planReasoningEffort: 'low',
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    })
    expect(backend.listCalls).toBe(0)
  })
})

describe('AgentManager collaboration capabilities', () => {
  it('waits for the queued Provider respawn before reading capability metadata', async () => {
    let releaseRestart!: () => void
    const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve })
    const backend = makeCollaborationBackend({
      initialEpoch: 1,
      restartCodex: async (instance) => {
        await restartGate
        instance.epoch = 2
      },
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({
          id: 'gpt-5.5',
          supportedReasoningEfforts: [
            { reasoningEffort: 'medium', description: 'medium' },
          ],
        })],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')

    const pending = manager.getCollaborationCapabilitiesRpc('gpt-5.5')
    await flushMicrotasks()
    expect(backend.modelCalls).toEqual([])

    releaseRestart()
    await expect(pending).resolves.toEqual({
      ok: true,
      data: {
        providerId: 'rightcode',
        backendEpoch: 2,
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['medium'],
        source: 'codex',
      },
    })
  })

  it('returns fallback capabilities when the Provider respawn cannot confirm a new epoch', async () => {
    const backend = makeCollaborationBackend({
      initialEpoch: 1,
      restartCodex: async () => undefined,
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({ id: 'gpt-5.5' })],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')

    await expect(manager.getCollaborationCapabilitiesRpc('gpt-5.5')).resolves.toEqual({
      ok: true,
      data: {
        providerId: 'rightcode',
        backendEpoch: 1,
        planDefaultEffort: null,
        supportedPlanEfforts: [],
        source: 'fallback',
      },
    })
    expect(backend.modelCalls).toEqual([])
  })

  it('keeps Plan Max for Right Code gpt-5.6-sol through the shared provider policy', async () => {
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6-sol',
          supportedReasoningEfforts: [
            { reasoningEffort: 'ultra', description: 'unknown' },
            { reasoningEffort: 'max', description: 'max' },
            { reasoningEffort: 'xhigh', description: 'xhigh' },
            { reasoningEffort: 'high', description: 'high' },
            { reasoningEffort: 'medium', description: 'medium' },
            { reasoningEffort: 'low', description: 'low' },
          ],
        })],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')

    await expect(manager.getCollaborationCapabilitiesRpc('gpt-5.6-sol')).resolves.toEqual({
      ok: true,
      data: {
        providerId: 'rightcode',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: 'codex',
      },
    })
  })

  it('filters Plan Max for Right Code gpt-5.5 through the shared provider policy', async () => {
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({
          id: 'gpt-5.5',
          model: 'gpt-5.5',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'low' },
            { reasoningEffort: 'medium', description: 'medium' },
            { reasoningEffort: 'high', description: 'high' },
            { reasoningEffort: 'xhigh', description: 'xhigh' },
            { reasoningEffort: 'max', description: 'max' },
            { reasoningEffort: 'ultra', description: 'unknown' },
          ],
        })],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')

    await expect(manager.getCollaborationCapabilitiesRpc('gpt-5.5')).resolves.toEqual({
      ok: true,
      data: {
        providerId: 'rightcode',
        planDefaultEffort: 'medium',
        supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh'],
        source: 'codex',
      },
    })
  })

  it('combines the Plan preset with normalized model capabilities matched by canonical model', async () => {
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow()],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)

    await expect(manager.getCollaborationCapabilitiesRpc('gpt-5.5')).resolves.toEqual({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'low',
        supportedPlanEfforts: ['low', 'high'],
        source: 'codex',
      },
    })
    expect(backend.modelCalls).toEqual([{ includeHidden: true }])
    expect(backend.listCalls).toBe(1)
  })

  it('also matches a model catalog row by picker id', async () => {
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow()],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)

    const result = await manager.getCollaborationCapabilitiesRpc('gpt-5.5-high')

    expect(result).toEqual({
      ok: true,
      data: {
        providerId: 'apiyi',
        planDefaultEffort: 'low',
        supportedPlanEfforts: ['low', 'high'],
        source: 'codex',
      },
    })
  })

  it('prefers an exact model row id over an earlier canonical-model alias match', async () => {
    const backend = makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [
          modelRow({
            id: 'canonical-alias',
            model: 'gpt-5.6-sol',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'alias row' },
            ],
          }),
          modelRow({
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            supportedReasoningEfforts: [
              { reasoningEffort: 'max', description: 'exact row' },
            ],
          }),
        ],
        nextCursor: null,
      }),
    })
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')

    await expect(manager.getCollaborationCapabilitiesRpc('gpt-5.6-sol')).resolves.toEqual({
      ok: true,
      data: {
        providerId: 'rightcode',
        planDefaultEffort: 'max',
        supportedPlanEfforts: ['max'],
        source: 'codex',
      },
    })
  })

  it.each([
    ['collaborationMode/list unavailable', makeCollaborationBackend({
      listModels: async () => ({ data: [modelRow()], nextCursor: null }),
    }), {
      providerId: 'apiyi',
      planDefaultEffort: 'low',
      supportedPlanEfforts: ['low', 'high'],
      source: 'codex',
    }],
    ['model/list unavailable', makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
    }), {
      providerId: 'apiyi',
      planDefaultEffort: null,
      supportedPlanEfforts: [],
      source: 'fallback',
    }],
    ['collaborationMode/list failure', makeCollaborationBackend({
      listModes: async () => { throw new Error('presets failed') },
      listModels: async () => ({ data: [modelRow()], nextCursor: null }),
    }), {
      providerId: 'apiyi',
      planDefaultEffort: 'low',
      supportedPlanEfforts: ['low', 'high'],
      source: 'codex',
    }],
    ['model/list failure', makeCollaborationBackend({
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => { throw new Error('models failed') },
    }), {
      providerId: 'apiyi',
      planDefaultEffort: null,
      supportedPlanEfforts: [],
      source: 'fallback',
    }],
  ])('returns safe capabilities when %s', async (_label, backend, expected) => {
    const manager = makeManager(backend)

    await expect(manager.getCollaborationCapabilitiesRpc('gpt-5.5')).resolves.toEqual({
      ok: true,
      data: expected,
    })
  })
})

describe('AgentManager collaboration mode updates', () => {
  it('returns a structured error and blocks Right Code gpt-5.5 Max before thread update', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({
        data: [modelRow({
          id: 'gpt-5.5',
          supportedReasoningEfforts: [
            { reasoningEffort: 'xhigh', description: 'supported' },
            { reasoningEffort: 'max', description: 'filtered by provider' },
          ],
        })],
        nextCursor: null,
      }),
      updateThreadSettings: async () => ({}),
    })
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)

    await expect(manager.updateCollaborationModeRpc({
      ...UPDATE_PAYLOAD,
      planReasoningEffort: 'max',
    })).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/max.*not supported/i),
      requestVersion: 7,
    })
    expect(backend.updateCalls).toEqual([])
  })

  it('maps an existing DB thread to Codex and updates complete settings immediately', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      listModes: async () => UPSTREAM_PRESETS,
      updateThreadSettings: async () => ({}),
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)

    await expect(manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)).resolves.toEqual({
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 7 },
    })
    expect(backend.updateCalls).toEqual([{
      threadId: 'codex-thread-1',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5.5',
          reasoning_effort: 'high',
          developer_instructions: null,
        },
      },
    }])
    expect((manager as any).threadSettingsUpdateSupport).toBe('supported')
  })

  it('resumes a stale Codex thread generation before updating its settings', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      initialEpoch: 1,
      resumeThread: async () => undefined,
      updateThreadSettings: async () => ({}),
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)
    backend.epoch = 2

    const result = await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)

    expect(result).toEqual({
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 7 },
    })
    expect(backend.resumeCalls).toEqual(['codex-thread-1'])
    expect(backend.updateCalls[0]?.threadId).toBe('codex-thread-1')
  })

  it('does not update when a stale Codex thread cannot be resumed', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      initialEpoch: 1,
      resumeThread: async () => {
        throw new Error('rollout unavailable')
      },
      updateThreadSettings: async () => ({}),
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)
    backend.epoch = 2

    const result = await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)

    expect(result).toEqual({
      ok: false,
      error: 'No resumable Codex thread exists for DB thread db-thread-1',
      requestVersion: 7,
    })
    expect(backend.resumeCalls).toEqual(['codex-thread-1'])
    expect(backend.updateCalls).toEqual([])
  })

  it('hydrates and resumes a persisted Codex thread after a full app restart before updating', async () => {
    const backend = makeCollaborationBackend({
      initialEpoch: 4,
      resumeThread: async () => undefined,
      updateThreadSettings: async () => ({}),
    })
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        getCodexThreadId: vi.fn().mockResolvedValue('persisted-codex-thread'),
      } as any,
    })

    const result = await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)

    expect(result).toEqual({
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 7 },
    })
    expect(backend.resumeCalls).toEqual(['persisted-codex-thread'])
    expect(backend.updateCalls[0]?.threadId).toBe('persisted-codex-thread')
  })

  it('builds Default from its own effort without consulting or inheriting Plan effort', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      listModes: async () => UPSTREAM_PRESETS,
      updateThreadSettings: async () => ({}),
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)

    const result = await manager.updateCollaborationModeRpc({
      ...UPDATE_PAYLOAD,
      mode: 'default',
      defaultReasoningEffort: 'low',
      planReasoningEffort: 'xhigh',
    })

    expect(result.ok).toBe(true)
    expect(backend.updateCalls[0].collaborationMode?.settings.reasoning_effort).toBe('low')
    expect(backend.listCalls).toBe(0)
  })

  it('returns a normal error when the backend update API is unavailable', async () => {
    const backend = makeCollaborationBackend({ queuedThreadIds: ['codex-thread-1'] })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)

    await expect(manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)).resolves.toEqual({
      ok: false,
      error: 'Codex thread settings update API is unavailable',
      requestVersion: 7,
    })
  })

  it('returns a normal error when the DB thread has no live Codex thread', async () => {
    const backend = makeCollaborationBackend({
      updateThreadSettings: async () => ({}),
    })
    const manager = makeManager(backend)

    await expect(manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)).resolves.toEqual({
      ok: false,
      error: 'No resumable Codex thread exists for DB thread db-thread-1',
      requestVersion: 7,
    })
    expect(backend.updateCalls).toEqual([])
  })

  it.each([
    'Method not found',
    'Unknown method thread/settings/update',
    'thread/settings/update is unsupported by this server',
    'thread/settings/update requires experimentalApi capability',
  ])('falls back to next-turn only for compatibility error: %s', async (message) => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      updateThreadSettings: async () => { throw new Error(message) },
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)

    await expect(manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)).resolves.toEqual({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 7 },
    })
  })

  it.each([
    '401 Unauthorized',
    'validation failed: invalid model',
    'Codex RPC thread/settings/update timed out after 30000ms',
  ])('returns an error instead of next-turn for ordinary failure: %s', async (message) => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      updateThreadSettings: async () => { throw new Error(message) },
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)

    await expect(manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)).resolves.toEqual({
      ok: false,
      error: message,
      requestVersion: 7,
    })
  })

  it('caches unsupported support for the current process and skips repeated RPC calls', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      updateThreadSettings: async () => {
        throw new Error('Method not found')
      },
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)

    const first = await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)
    const second = await manager.updateCollaborationModeRpc({
      ...UPDATE_PAYLOAD,
      requestVersion: 8,
    })

    expect(first).toEqual({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 7 },
    })
    expect(second).toEqual({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 8 },
    })
    expect(backend.updateCalls).toHaveLength(1)
  })

  it('returns next-turn from cached unsupported without resolving an unmapped DB thread', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      initialEpoch: 1,
      resumeThread: async () => {
        throw new Error('must not resume')
      },
      updateThreadSettings: async () => {
        throw new Error('Method not found')
      },
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)
    await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)

    ;(manager as any).codexThreadIdByDbThreadId.delete('db-thread-1')
    ;(manager as any).codexThreadEpochByDbThreadId.delete('db-thread-1')
    const resolveSpy = vi.spyOn(manager as any, 'resolveCodexThreadForSend')

    const second = await manager.updateCollaborationModeRpc({
      ...UPDATE_PAYLOAD,
      requestVersion: 8,
    })

    expect(second).toEqual({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 8 },
    })
    expect(resolveSpy).not.toHaveBeenCalled()
    expect(backend.resumeCalls).toEqual([])
    expect(backend.updateCalls).toHaveLength(1)
  })

  it('re-probes support and presets after a crash self-heal advances the epoch', async () => {
    let updates = 0
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      initialEpoch: 1,
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({ data: [modelRow()], nextCursor: null }),
      resumeThread: async () => undefined,
      updateThreadSettings: async () => {
        updates += 1
        if (updates === 1) throw new Error('Method not found')
        return {}
      },
    })
    const manager = makeManager(backend)
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)
    await manager.getCollaborationCapabilitiesRpc('gpt-5.5')
    await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)

    backend.epoch = 2
    const updated = await manager.updateCollaborationModeRpc({
      ...UPDATE_PAYLOAD,
      planReasoningEffort: 'auto',
      requestVersion: 9,
    })
    await manager.getCollaborationCapabilitiesRpc('gpt-5.5')

    expect(updated).toEqual({
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 9 },
    })
    expect(backend.resumeCalls).toEqual(['codex-thread-1'])
    expect(backend.updateCalls).toHaveLength(2)
    expect(backend.listCalls).toBe(2)
  })

  it('keeps support and preset caches when restart returns without changing epoch', async () => {
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      initialEpoch: 1,
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({ data: [modelRow()], nextCursor: null }),
      updateThreadSettings: async () => {
        throw new Error('Method not found')
      },
      restartCodex: async () => undefined,
    })
    const manager = makeManager(backend)
    backend.healthy = false
    await manager.setCodexApiKey('sk-test')
    backend.healthy = true
    await createCodexThreadMapping(manager)
    await manager.getCollaborationCapabilitiesRpc('gpt-5.5')
    await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)

    await manager.restartCodex()

    const updated = await manager.updateCollaborationModeRpc({
      ...UPDATE_PAYLOAD,
      requestVersion: 9,
    })
    await manager.getCollaborationCapabilitiesRpc('gpt-5.5')

    expect(updated).toEqual({
      ok: true,
      data: { compatibility: 'next-turn', requestVersion: 9 },
    })
    expect(backend.updateCalls).toHaveLength(1)
    expect(backend.listCalls).toBe(1)
    expect(backend.restartCalls).toBe(1)
  })

  it('clears process caches when restart changes epoch and allows a fresh probe', async () => {
    let updates = 0
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-thread-1'],
      initialEpoch: 1,
      listModes: async () => UPSTREAM_PRESETS,
      listModels: async () => ({ data: [modelRow()], nextCursor: null }),
      resumeThread: async () => undefined,
      updateThreadSettings: async () => {
        updates += 1
        if (updates === 1) throw new Error('Method not found')
        return {}
      },
      restartCodex: async (target) => {
        target.epoch = 2
      },
    })
    const manager = makeManager(backend)
    backend.healthy = false
    await manager.setCodexApiKey('sk-test')
    backend.healthy = true
    await createCodexThreadMapping(manager)
    await manager.getCollaborationCapabilitiesRpc('gpt-5.5')
    await manager.updateCollaborationModeRpc(UPDATE_PAYLOAD)

    await manager.restartCodex()

    const updated = await manager.updateCollaborationModeRpc({
      ...UPDATE_PAYLOAD,
      planReasoningEffort: 'auto',
      requestVersion: 9,
    })
    await manager.getCollaborationCapabilitiesRpc('gpt-5.5')

    expect(updated).toEqual({
      ok: true,
      data: { compatibility: 'immediate', requestVersion: 9 },
    })
    expect(backend.resumeCalls).toEqual(['codex-thread-1'])
    expect(backend.updateCalls).toHaveLength(2)
    expect(backend.listCalls).toBe(2)
    expect(backend.restartCalls).toBe(1)
  })
})

describe('AgentManager thread settings notifications', () => {
  type ThreadSettingsEvent = Extract<AgentStreamEvent, { type: 'thread_settings_updated' }>

  const notification = (
    threadId: string,
  ): ThreadSettingsEvent => ({
    type: 'thread_settings_updated',
    threadId,
    mode: 'plan',
    model: 'gpt-5.5',
    effort: 'high',
  })

  it('connects the backend factory notification callback to DB-thread emission', async () => {
    const events: AgentStreamEvent[] = []
    const backend = makeCollaborationBackend({ queuedThreadIds: ['codex-thread-1'] })
    let notify: ((event: ThreadSettingsEvent) => void) | undefined
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backendFactory: (options) => {
        notify = options.onThreadSettingsNotification
        return backend
      },
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (event) => events.push(event),
    })
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)
    events.length = 0

    notify?.(notification('codex-thread-1'))

    expect(notify).toBeTypeOf('function')
    expect(events).toEqual([{
      ...notification('codex-thread-1'),
      threadId: 'db-thread-1',
    }])
  })

  it('maps a Codex thread id to the DB thread id before emitting', async () => {
    const events: AgentStreamEvent[] = []
    const backend = makeCollaborationBackend({ queuedThreadIds: ['codex-thread-1'] })
    const manager = makeManager(backend, (event) => events.push(event))
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager)
    events.length = 0

    ;(manager as any).handleThreadSettingsNotification(notification('codex-thread-1'))

    expect(events).toEqual([{
      ...notification('codex-thread-1'),
      threadId: 'db-thread-1',
    }])
  })

  it('ignores an unmapped Codex thread id', () => {
    const sink = vi.fn<(event: AgentStreamEvent) => void>()
    const manager = makeManager(makeCollaborationBackend(), sink)

    ;(manager as any).handleThreadSettingsNotification(notification('unmapped-codex-thread'))

    expect(sink).not.toHaveBeenCalled()
  })

  it('maps a background thread independently of the most recently used thread', async () => {
    const events: AgentStreamEvent[] = []
    const backend = makeCollaborationBackend({
      queuedThreadIds: ['codex-active', 'codex-background'],
    })
    const manager = makeManager(backend, (event) => events.push(event))
    await manager.setCodexApiKey('sk-test')
    await createCodexThreadMapping(manager, 'db-active')
    await createCodexThreadMapping(manager, 'db-background')
    events.length = 0

    ;(manager as any).handleThreadSettingsNotification(notification('codex-background'))

    expect(events).toEqual([{
      ...notification('codex-background'),
      threadId: 'db-background',
    }])
  })
})
