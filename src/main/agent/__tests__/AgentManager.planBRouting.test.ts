import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { CodexThreadConfigOverrides } from '../codexProtocol'
import type {
  AgentStreamEvent,
  AgentThreadRoutingSnapshot,
} from '../../../types/agent'

/**
 * Plan B per-thread provider routing, manager-level wiring:
 *
 * - A same-gateway sibling switch (the LIVE spawn registered the target
 *   Channel) is served WITHOUT restarting codex — the thread resumes onto its
 *   own provider table and the binding is persisted per thread.
 * - A send on a bound thread keeps riding the thread's Channel even after the
 *   GLOBAL selection moved on.
 * - A new thread routing off the process-active Channel carries
 *   `modelProvider` (+ context pin) into `thread/start` and binds immediately.
 */

let tmpDir: string

interface PlanBHarness {
  manager: AgentManager
  restartCodex: ReturnType<typeof vi.fn>
  resumeThreadCalls: Array<{ threadId: string; overrides?: CodexThreadConfigOverrides }>
  forkThreadCalls: Array<{ threadId: string; overrides?: CodexThreadConfigOverrides }>
  unsubscribeThreadCalls: string[]
  sentThreadIds: Array<string | undefined>
  sentInputs: AgentInput[]
  setThreadRouting: ReturnType<typeof vi.fn>
  setCodexThreadId: ReturnType<typeof vi.fn>
  gatewayId: () => string
  grok: () => { id: string; contextWindow: number }
}

async function createPlanBHarness(options: {
  routingSnapshot?: AgentThreadRoutingSnapshot
  hasRegisteredProviderChannel?: (channelId: string) => boolean
  hasInFlightWork?: () => boolean
  hasInFlightWorkForThread?: (codexThreadId: string) => boolean
  persistedCodexThreadId?: string | null
} = {}): Promise<PlanBHarness> {
  let epoch = 1
  const restartCodex = vi.fn(async () => {
    epoch += 1
  })
  const resumeThreadCalls: PlanBHarness['resumeThreadCalls'] = []
  const forkThreadCalls: PlanBHarness['forkThreadCalls'] = []
  const unsubscribeThreadCalls: string[] = []
  const sentInputs: AgentInput[] = []
  const sentThreadIds: Array<string | undefined> = []
  const backend = {
    async start() {},
    async stop() {},
    isHealthy: () => true,
    currentEpoch: () => epoch,
    setProvider: vi.fn(),
    restartCodex,
    async cancel() {},
    async *send(
      threadId: string | undefined,
      input: AgentInput,
    ): AsyncIterable<AgentStreamEvent> {
      sentThreadIds.push(threadId)
      sentInputs.push(input)
    },
    async resumeThread(
      threadId: string,
      overrides?: CodexThreadConfigOverrides,
    ) {
      resumeThreadCalls.push({ threadId, ...(overrides ? { overrides } : {}) })
    },
    async forkThread(
      threadId: string,
      overrides?: CodexThreadConfigOverrides,
    ) {
      forkThreadCalls.push({ threadId, ...(overrides ? { overrides } : {}) })
      return {
        id: `${threadId}-fork-${forkThreadCalls.length}`,
        title: 'forked',
        createdAt: '',
        updatedAt: '',
      }
    },
    async unsubscribeThread(threadId: string) {
      unsubscribeThreadCalls.push(threadId)
    },
    hasRegisteredProviderChannel:
      options.hasRegisteredProviderChannel ?? (() => true),
    hasInFlightWork: options.hasInFlightWork ?? (() => false),
    hasInFlightWorkForThread:
      options.hasInFlightWorkForThread ?? (() => false),
  } satisfies IAgentBackend
  // Stateful, like the real ThreadStore: a persisted binding written by
  // setThreadRouting is visible to the next getThreadRoutingSnapshot read.
  // This is load-bearing — the coordinator's "already bound" fast path is what
  // stops a send right after an in-process switch from re-forking the thread.
  let routingState: AgentThreadRoutingSnapshot | undefined = options.routingSnapshot
  let persistedCodexThreadId: string | null = options.persistedCodexThreadId ?? null
  const setThreadRouting = vi.fn(
    async (
      _threadId: string,
      routing: { model: string; gatewayId: string; modelProvider: string },
    ) => {
      routingState = { exists: true, ...routing }
    },
  )
  const setCodexThreadId = vi.fn(async (_threadId: string, codexThreadId: string) => {
    persistedCodexThreadId = codexThreadId
  })
  const store = {
    createThread: async () => ({ id: 'thread-plan-b' }),
    addMessage: async () => ({ id: 'message-plan-b' }),
    updateLastMessageAt: async () => undefined,
    getCodexThreadId: async () => persistedCodexThreadId,
    setCodexThreadId,
    setThreadRouting,
    getThreadRoutingSnapshot: async (): Promise<AgentThreadRoutingSnapshot> =>
      routingState
      ?? { exists: true, model: null, gatewayId: null, modelProvider: null },
    setThreadModel: async () => undefined,
  }
  const manager = new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: store as never,
    attachments: { ingest: async () => [] } as never,
    eventSink: () => {},
  })
  await manager.setCodexApiKey('test-key')
  const catalogResult = await manager.getModelSettingsCatalogRpc()
  if (!catalogResult.ok) throw new Error(catalogResult.error)
  const catalog = catalogResult.data
  const grokEntry = catalog.models.find((model) => model.id === 'grok-4.5')
  if (!grokEntry) throw new Error('Expected Grok catalog entry')
  // Boot-time config sync may legitimately restart once — only Channel-switch
  // restarts are under test.
  restartCodex.mockClear()
  return {
    manager,
    restartCodex,
    resumeThreadCalls,
    forkThreadCalls,
    unsubscribeThreadCalls,
    sentThreadIds,
    sentInputs,
    setThreadRouting,
    setCodexThreadId,
    gatewayId: () => catalog.gatewayId,
    grok: () => ({
      id: grokEntry.id,
      contextWindow: grokEntry.capabilities.defaultContextWindow,
    }),
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-plan-b-routing-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager Plan B per-thread provider routing', () => {
  it('serves a same-gateway sibling switch in-process: no restart, thread FORKS onto the sibling Channel, binding + codex id persisted', async () => {
    const harness = await createPlanBHarness({
      persistedCodexThreadId: 'codex-thread-1',
    })
    const grok = harness.grok()

    const result = await harness.manager.applyModelSelectionRpc({
      gatewayId: harness.gatewayId(),
      modelId: grok.id,
      contextWindow: grok.contextWindow,
      catalogRevision: (await harness.manager.getModelSettingsCatalogRpc() as { ok: true; data: { revision: string } }).data.revision,
      requestVersion: 1,
      threadId: 'db-thread-1',
    })

    expect(result).toMatchObject({
      ok: true,
      data: { modelId: grok.id, channelId: `${harness.gatewayId()}-grok` },
    })
    // In-process: codex is NEVER restarted for a registered sibling Channel.
    expect(harness.restartCodex).not.toHaveBeenCalled()
    // A LIVE (loaded) codex thread cannot be re-bound via thread/resume —
    // codex silently IGNORES model/modelProvider overrides for loaded threads
    // (upstream resume_running_thread "overrides ignored for loaded thread",
    // verified against the bundled binary by
    // scripts/smoke-live-thread-provider-switch.ts). The switch must FORK the
    // thread onto the sibling provider instead.
    expect(harness.resumeThreadCalls).toHaveLength(0)
    expect(harness.forkThreadCalls).toHaveLength(1)
    expect(harness.forkThreadCalls[0].threadId).toBe('codex-thread-1')
    expect(harness.forkThreadCalls[0].overrides).toMatchObject({
      model: grok.id,
      modelProvider: `${harness.gatewayId()}-grok`,
    })
    // The DB thread now maps to the forked codex thread id...
    expect(harness.setCodexThreadId).toHaveBeenCalledWith(
      'db-thread-1',
      'codex-thread-1-fork-1',
    )
    // ...and the abandoned source thread is unsubscribed (best-effort) so
    // codex can eventually unload it.
    expect(harness.unsubscribeThreadCalls).toContain('codex-thread-1')
    // The binding is persisted per thread, so a later GLOBAL switch can never
    // re-route this conversation.
    expect(harness.setThreadRouting).toHaveBeenCalledWith('db-thread-1', {
      model: grok.id,
      gatewayId: harness.gatewayId(),
      modelProvider: `${harness.gatewayId()}-grok`,
    })
  })

  it('sends the turn to the FORKED codex thread after an in-process switch', async () => {
    const harness = await createPlanBHarness({
      persistedCodexThreadId: 'codex-thread-2',
      routingSnapshot: {
        exists: true,
        model: null,
        gatewayId: null,
        modelProvider: null,
      },
    })
    const grok = harness.grok()

    await harness.manager.applyModelSelectionRpc({
      gatewayId: harness.gatewayId(),
      modelId: grok.id,
      contextWindow: grok.contextWindow,
      catalogRevision: (await harness.manager.getModelSettingsCatalogRpc() as { ok: true; data: { revision: string } }).data.revision,
      requestVersion: 1,
      threadId: 'db-thread-2',
    })
    expect(harness.forkThreadCalls).toHaveLength(1)

    await harness.manager.sendMessage({
      content: 'hello on the fork',
      attachments: [],
      threadId: 'db-thread-2',
      model: grok.id,
    })

    expect(harness.sentInputs).toHaveLength(1)
    expect(harness.sentThreadIds[0]).toBe('codex-thread-2-fork-1')
  })

  it('lets an in-process switch through while ANOTHER conversation is mid-turn', async () => {
    const harness = await createPlanBHarness({
      persistedCodexThreadId: 'codex-thread-idle',
      // Global gate reports busy (another thread is streaming)...
      hasInFlightWork: () => true,
      // ...but the TARGET thread itself is idle.
      hasInFlightWorkForThread: () => false,
    })
    const grok = harness.grok()

    const result = await harness.manager.applyModelSelectionRpc({
      gatewayId: harness.gatewayId(),
      modelId: grok.id,
      contextWindow: grok.contextWindow,
      catalogRevision: (await harness.manager.getModelSettingsCatalogRpc() as { ok: true; data: { revision: string } }).data.revision,
      requestVersion: 1,
      threadId: 'db-thread-idle',
    })

    expect(result).toMatchObject({ ok: true })
    expect(harness.restartCodex).not.toHaveBeenCalled()
  })

  it('falls back to the restart transaction when the spawn did not register the target Channel', async () => {
    const harness = await createPlanBHarness({
      hasRegisteredProviderChannel: () => false,
      persistedCodexThreadId: 'codex-thread-legacy',
    })
    const grok = harness.grok()

    const result = await harness.manager.applyModelSelectionRpc({
      gatewayId: harness.gatewayId(),
      modelId: grok.id,
      contextWindow: grok.contextWindow,
      catalogRevision: (await harness.manager.getModelSettingsCatalogRpc() as { ok: true; data: { revision: string } }).data.revision,
      requestVersion: 1,
      threadId: 'db-thread-legacy',
    })

    expect(result).toMatchObject({ ok: true })
    // Legacy path: the Channel switch restarts the process.
    expect(harness.restartCodex).toHaveBeenCalled()
  })

  it('keeps a bound conversation on ITS OWN model when the global selection moved on', async () => {
    const harness = await createPlanBHarness({
      // Bound to the default gateway's grok sibling (default gateway: apiyi).
      routingSnapshot: {
        exists: true,
        model: 'grok-4.5',
        gatewayId: 'apiyi',
        modelProvider: 'apiyi-grok',
      },
    })

    // Global selection stays on the default gpt-5.5; the send carries NO
    // explicit model — the thread's persisted binding must win.
    await harness.manager.sendMessage({
      content: 'stay on grok',
      attachments: [],
      threadId: 'db-thread-bound',
    })

    expect(harness.sentInputs).toHaveLength(1)
    expect(harness.sentInputs[0].model).toBe('grok-4.5')
    // Already bound to the target Channel: pure no-op selection, no restart.
    expect(harness.restartCodex).not.toHaveBeenCalled()
  })

  it('starts a NEW thread on a sibling Channel via thread/start routing fields and binds it immediately', async () => {
    const harness = await createPlanBHarness()
    const grok = harness.grok()

    await harness.manager.sendMessage({
      content: 'fresh grok conversation',
      attachments: [],
      model: grok.id,
    })

    expect(harness.restartCodex).not.toHaveBeenCalled()
    expect(harness.sentInputs).toHaveLength(1)
    // thread/start rides the sibling provider table + per-thread pin instead
    // of the process-active channel.
    expect(harness.sentInputs[0].modelProvider).toBe(`${harness.gatewayId()}-grok`)
    // The fresh conversation is bound at creation time.
    expect(harness.setThreadRouting).toHaveBeenCalledWith('thread-plan-b', {
      model: grok.id,
      gatewayId: harness.gatewayId(),
      modelProvider: `${harness.gatewayId()}-grok`,
    })
  })

  it('re-binds a bound thread to its OWN Channel on post-restart hydration resume', async () => {
    const harness = await createPlanBHarness({
      persistedCodexThreadId: 'codex-thread-hydrate',
      routingSnapshot: {
        exists: true,
        model: 'grok-4.5',
        gatewayId: 'apiyi',
        modelProvider: 'apiyi-grok',
      },
    })

    await harness.manager.sendMessage({
      content: 'continue after app restart',
      attachments: [],
      threadId: 'db-thread-hydrate',
    })

    // Hydration resumed the persisted codex thread with the BOUND provider,
    // not the process-active one.
    const hydrationResume = harness.resumeThreadCalls.find(
      (call) => call.threadId === 'codex-thread-hydrate',
    )
    expect(hydrationResume?.overrides).toMatchObject({
      model: 'grok-4.5',
      modelProvider: 'apiyi-grok',
    })
  })
})
