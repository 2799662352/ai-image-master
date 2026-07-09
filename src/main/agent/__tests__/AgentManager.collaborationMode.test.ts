/**
 * AgentManager → collaborationMode wiring: the renderer only sends a preset
 * KIND (`collaborationModeKind: 'plan'`); the manager expands it into the full
 * codex `CollaborationMode` (mode + settings with the resolved model) on
 * AgentInput so CodexProtocolClient forwards it via `turn/start`.
 * `settings.developer_instructions: null` deliberately means "use codex's
 * built-in Plan-mode instructions". Absent/'default' kind must leave the
 * input untouched (stable wire behaviour).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'
import type { CollaborationModeListResponse } from '../codexProtocol'

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
  return backend
}

const UPSTREAM_PRESETS: CollaborationModeListResponse = {
  data: [
    { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
    { name: 'Code', mode: 'default', model: null, reasoning_effort: null },
  ],
}

function makeManager(backend: IAgentBackend): AgentManager {
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async () => ({ id: 'msg-1' }),
      updateLastMessageAt: async () => undefined,
    } as any,
    attachments: { ingest: async () => [] } as any,
  })
}

function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
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

  it('falls back to reasoning_effort: null when collaborationMode/list rejects', async () => {
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
        reasoning_effort: null,
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

  it("expands 'plan' with null reasoning_effort when the backend lacks collaborationMode/list", async () => {
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

  it("treats collaborationModeKind 'default' the same as absent (no preset sent)", async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [], collaborationModeKind: 'default' })
    await flushMicrotasks()

    expect(backend.calls[0].input.collaborationMode).toBeUndefined()
  })
})
