import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'
import type { CodexProviderConfig } from '../codexLaunch'

interface BackendCall {
  threadId: string | undefined
  input: AgentInput
}

function makeStubBackend(
  scriptPerCall: Array<AgentStreamEvent[] | Error>,
): IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] } {
  const calls: BackendCall[] = []
  const cancelCalls: string[] = []
  const backend = {
    calls,
    cancelCalls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel(threadId: string) { cancelCalls.push(threadId) },
    async *send(threadId: string | undefined, input: AgentInput) {
      const idx = calls.length
      calls.push({ threadId, input })
      const events = scriptPerCall[idx] ?? []
      if (events instanceof Error) throw events
      for (const e of events) yield e
    },
  } satisfies IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] }
  return backend
}

function flushMicrotasks(times = 5): Promise<void> {
  let p: Promise<void> = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager codex api key', () => {
  it('reports maximum-permission Codex defaults in session status', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })

    expect(mgr.getSessionStatus()).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: 'live',
      writableRoots: [],
    })
  })

  it('returns empty string when codex-agent.json is absent', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('loads codex api key from disk on construction', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ openaiApiKey: 'sk-stored' }),
      'utf8',
    )
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('sk-stored')
  })

  it('returns empty string when codex-agent.json is malformed', async () => {
    await fs.writeFile(path.join(tmpDir, 'codex-agent.json'), 'not json {{{', 'utf8')
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('returns empty string when codex-agent.json has no openaiApiKey field', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ other: 'value' }),
      'utf8',
    )
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  // v4.3 moved Codex API key persistence from `codex-agent.json` (single key)
  // to `codex-providers.json` (per-provider keys, custom providers list, and
  // the active provider id). `setCodexApiKey` is now a thin alias that sets
  // the API key for the currently-active provider, so both layouts (legacy
  // file present, and the new file written by setCodexApiKey) need to round-
  // trip through getCodexApiKey().
  it('setCodexApiKey atomically writes to disk and updates the cache', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    await mgr.setCodexApiKey('  sk-new  ')

    expect(mgr.getCodexApiKey()).toBe('sk-new')

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    // Default active provider is `apiyi` — see codexProviders.ts.
    expect(onDisk.apiKeys.apiyi).toBe('sk-new')
    expect(onDisk.selectedProviderId).toBe('apiyi')

    const entries = await fs.readdir(tmpDir)
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('a second AgentManager construction reads back what setCodexApiKey wrote', async () => {
    const writer = new AgentManager({ userDataDir: tmpDir })
    await writer.setCodexApiKey('sk-persist')

    const reader = new AgentManager({ userDataDir: tmpDir })
    expect(reader.getCodexApiKey()).toBe('sk-persist')
  })
})

// The gateway key is injected into the codex process env at SPAWN time
// (buildCodexSpawnEnv). Before this suite existed, saving a new key for the
// active provider only updated the in-memory copy — the already-running codex
// kept its stale env until the user restarted the whole app. Now a change to
// the ACTIVE provider's key hot-restarts codex (change-guarded, healthy-only).
describe('AgentManager active provider key hot-reload', () => {
  function makeRestartBackend() {
    const restarts: unknown[] = []
    const backend = Object.assign(makeStubBackend([]), {
      async restartCodex(paths: unknown) {
        restarts.push(paths)
      },
    })
    return { backend, restarts }
  }

  it('restarts codex when the active provider key changes, but not on idempotent re-push', async () => {
    const { backend, restarts } = makeRestartBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    // Default active provider is apiyi.
    await mgr.setProviderApiKey('apiyi', 'sk-first')
    await flushMicrotasks()
    expect(restarts.length).toBe(1)

    // Same key again (renderer re-pushes idempotently) → no restart storm.
    await mgr.setProviderApiKey('apiyi', 'sk-first')
    await flushMicrotasks()
    expect(restarts.length).toBe(1)

    // Real change → restart again.
    await mgr.setProviderApiKey('apiyi', 'sk-second')
    await flushMicrotasks()
    expect(restarts.length).toBe(2)

    // A key for an INACTIVE provider is consumed at the next provider switch /
    // spawn — no restart now.
    await mgr.setProviderApiKey('rightcode', 'sk-rc')
    await flushMicrotasks()
    expect(restarts.length).toBe(2)
  })

  it('skips the restart when the backend has not started yet (key lands at next spawn)', async () => {
    const { backend, restarts } = makeRestartBackend()
    backend.isHealthy = () => false
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    await mgr.setProviderApiKey('apiyi', 'sk-early')
    await flushMicrotasks()
    expect(restarts.length).toBe(0)
    expect(mgr.getCodexApiKey()).toBe('sk-early')
  })
})

describe('AgentManager transactional provider application', () => {
  function makeTransactionalBackend(
    restart: (call: number) => Promise<void>,
  ): IAgentBackend & {
    calls: BackendCall[]
    cancelCalls: string[]
    configuredProviders: Array<string | undefined>
    restartCalls: number
    epoch: number
  } {
    const backend = Object.assign(makeStubBackend([]), {
      configuredProviders: [] as Array<string | undefined>,
      restartCalls: 0,
      epoch: 1,
      currentEpoch() {
        return backend.epoch
      },
      setProvider(provider: CodexProviderConfig | undefined) {
        backend.configuredProviders.push(provider?.id)
      },
      async restartCodex() {
        backend.restartCalls += 1
        await restart(backend.restartCalls)
      },
    })
    return backend
  }

  it('confirms a successful switch only after a new backend epoch exists', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const backend = makeTransactionalBackend(async () => {
      await gate
      backend.epoch += 1
    })
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })
    let settled = false

    const pending = mgr.setActiveProvider('rightcode').finally(() => {
      settled = true
    })
    await flushMicrotasks()

    expect(settled).toBe(false)
    expect((await mgr.getProvidersSnapshot()).activeId).toBe('apiyi')
    release()
    await expect(pending).resolves.toEqual({
      ok: true,
      activeId: 'rightcode',
      providerGeneration: 2,
    })
    expect((await mgr.getProvidersSnapshot()).activeId).toBe('rightcode')
    expect(backend.configuredProviders).toEqual(['rightcode'])
  })

  it('rejects an in-flight switch and keeps the old Provider usable', async () => {
    const backend = makeTransactionalBackend(async (call) => {
      if (call === 1) {
        throw new Error('Current turn is running; retry after it completes')
      }
      backend.epoch += 1
    })
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
    })

    await expect(mgr.setActiveProvider('rightcode')).rejects.toThrow(/current turn.*retry/i)

    expect((await mgr.getProvidersSnapshot()).activeId).toBe('apiyi')
    expect(backend.configuredProviders).toEqual(['rightcode', 'apiyi'])
    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(persisted.selectedProviderId).toBe('apiyi')
    await mgr.setCodexApiKey('sk-old-provider')
    await mgr.sendMessage({ content: 'still old', attachments: [] })
    await vi.waitFor(() => expect(backend.calls).toHaveLength(1))
  })

  it('rolls back persisted, in-memory, and backend Provider state after spawn failure', async () => {
    const backend = makeTransactionalBackend(async () => {
      throw new Error('replacement spawn failed')
    })
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    await expect(mgr.setActiveProvider('rightcode')).rejects.toThrow(/spawn failed/i)

    expect(mgr.getCodexApiKey()).toBe('')
    expect(backend.configuredProviders).toEqual(['rightcode', 'apiyi'])
    expect(await mgr.getProvidersSnapshot()).toMatchObject({ activeId: 'apiyi' })
    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(persisted.selectedProviderId).toBe('apiyi')
  })

  it('serializes rapid A then B transitions so B is the final applied Provider', async () => {
    const releases: Array<() => void> = []
    const backend = makeTransactionalBackend(async () => {
      await new Promise<void>((resolve) => { releases.push(resolve) })
      backend.epoch += 1
    })
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    const a = mgr.setActiveProvider('rightcode')
    const b = mgr.setActiveProvider('apiyi')

    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases[0]()
    await a
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()
    await b

    expect((await mgr.getProvidersSnapshot()).activeId).toBe('apiyi')
    expect(backend.configuredProviders).toEqual(['rightcode', 'apiyi'])
    expect(backend.epoch).toBe(3)
  })

  it('continues with B after a slow A failure and leaves B applied', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const backend = makeTransactionalBackend(async (call) => {
      if (call === 1) {
        await firstGate
        throw new Error('A failed')
      }
      backend.epoch += 1
    })
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    const a = mgr.setActiveProvider('rightcode')
    const b = mgr.setActiveProvider('apiyi')
    await flushMicrotasks()
    releaseFirst()

    await expect(a).rejects.toThrow('A failed')
    await expect(b).resolves.toMatchObject({ activeId: 'apiyi' })
    expect((await mgr.getProvidersSnapshot()).activeId).toBe('apiyi')
    expect(backend.configuredProviders).toEqual(['rightcode', 'apiyi'])
  })

  it('applies active key, custom update, and active removal through confirmed generations', async () => {
    const backend = makeTransactionalBackend(async () => {
      backend.epoch += 1
    })
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    await expect(mgr.setProviderApiKey('apiyi', 'sk-applied')).resolves.toEqual({
      ok: true,
      activeId: 'apiyi',
      providerGeneration: 2,
    })
    const custom = await mgr.addCustomProvider({
      id: 'custom-transaction',
      name: 'Transaction',
      baseUrl: 'https://old.example.com/v1',
      envKey: 'OPENAI_API_KEY',
    })
    await mgr.setProviderApiKey(custom.id, 'sk-custom')
    await mgr.setActiveProvider(custom.id)

    await expect(mgr.updateCustomProvider(custom.id, {
      baseUrl: 'https://new.example.com/v1',
      model: 'gpt-5.6-sol',
    })).resolves.toEqual({
      ok: true,
      activeId: custom.id,
      providerGeneration: 4,
    })
    await expect(mgr.removeCustomProvider(custom.id)).resolves.toEqual({
      ok: true,
      activeId: 'apiyi',
      providerGeneration: 5,
    })

    const snapshot = await mgr.getProvidersSnapshot()
    expect(snapshot.activeId).toBe('apiyi')
    expect(snapshot.custom).toEqual([])
    expect(backend.epoch).toBe(5)
  })

  it('restores active key and custom provider configuration when confirmed apply fails', async () => {
    let failNext = false
    const backend = makeTransactionalBackend(async () => {
      if (failNext) {
        failNext = false
        throw new Error('apply failed')
      }
      backend.epoch += 1
    })
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })
    await mgr.setProviderApiKey('apiyi', 'sk-old')

    failNext = true
    await expect(mgr.setProviderApiKey('apiyi', 'sk-new')).rejects.toThrow('apply failed')
    expect(mgr.getCodexApiKey()).toBe('sk-old')

    const custom = await mgr.addCustomProvider({
      id: 'custom-rollback',
      name: 'Rollback',
      baseUrl: 'https://old.example.com/v1',
      envKey: 'OPENAI_API_KEY',
    })
    await mgr.setActiveProvider(custom.id)

    failNext = true
    await expect(mgr.updateCustomProvider(custom.id, {
      baseUrl: 'https://broken.example.com/v1',
    })).rejects.toThrow('apply failed')
    expect((await mgr.getProvidersSnapshot()).custom).toContainEqual(
      expect.objectContaining({
        id: custom.id,
        baseUrl: 'https://old.example.com/v1',
      }),
    )

    failNext = true
    await expect(mgr.removeCustomProvider(custom.id)).rejects.toThrow('apply failed')
    expect(await mgr.getProvidersSnapshot()).toMatchObject({
      activeId: custom.id,
      custom: [expect.objectContaining({ id: custom.id })],
    })
  })
})

// The renderer mirrors the 设置 → API易 key to the main process under the
// dedicated `apiyi-mcp` slot. AgentManager keeps an in-memory copy (injected at
// spawn via `-c mcp_servers.apiyi.env.APIYI_API_KEY`) and restarts codex ON
// CHANGE so the new key takes effect immediately. The change-guard is critical:
// the renderer re-pushes this key idempotently on every boot / MCP-page load, so
// an unchanged push must NOT trigger a restart storm.
describe('AgentManager apiyi-mcp key bridge', () => {
  function makeRestartBackend() {
    const restarts: unknown[] = []
    const backend = Object.assign(makeStubBackend([]), {
      async restartCodex(paths: unknown) {
        restarts.push(paths)
      },
    })
    return { backend, restarts }
  }

  it('persists the apiyi-mcp key under its dedicated slot and restarts codex only on change', async () => {
    const { backend, restarts } = makeRestartBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    await mgr.setProviderApiKey('apiyi-mcp', 'sk-apiyi')
    expect(restarts.length).toBe(1) // '' -> 'sk-apiyi' is a change

    // Idempotent re-push (same key) must NOT restart.
    await mgr.setProviderApiKey('apiyi-mcp', 'sk-apiyi')
    expect(restarts.length).toBe(1)

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(onDisk.apiKeys['apiyi-mcp']).toBe('sk-apiyi')
    // It must NOT have touched the codex gateway provider key (apiyi) or active id.
    expect(onDisk.apiKeys.apiyi).toBeUndefined()
    expect(onDisk.selectedProviderId).toBe('apiyi')
  })

  it('a fresh manager preloads the persisted apiyi-mcp key so an idempotent re-push does not restart', async () => {
    const first = new AgentManager({ userDataDir: tmpDir, backend: makeStubBackend([]) })
    await first.setProviderApiKey('apiyi-mcp', 'sk-keep')

    const { backend, restarts } = makeRestartBackend()
    const second = new AgentManager({ userDataDir: tmpDir, backend })

    // Same key as persisted at construction → cold-start re-push is a no-op.
    await second.setProviderApiKey('apiyi-mcp', 'sk-keep')
    expect(restarts.length).toBe(0)

    // A rotated key DOES restart.
    await second.setProviderApiKey('apiyi-mcp', 'sk-rotated')
    expect(restarts.length).toBe(1)
  })
})

// The cinematography-kb-mcp key bridge mirrors apiyi-mcp exactly: a dedicated
// key-only provider slot, injected at spawn via
// `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY`, change-guarded so the
// renderer's idempotent boot re-push never causes a restart storm.
describe('AgentManager cinematography-kb key bridge', () => {
  function makeRestartBackend() {
    const restarts: unknown[] = []
    const backend = Object.assign(makeStubBackend([]), {
      async restartCodex(paths: unknown) {
        restarts.push(paths)
      },
    })
    return { backend, restarts }
  }

  it('persists the cinematography-kb key under its dedicated slot and restarts codex only on change', async () => {
    const { backend, restarts } = makeRestartBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir, backend })

    await mgr.setProviderApiKey('cinematography-kb', 'sk-dashscope')
    expect(restarts.length).toBe(1) // '' -> 'sk-dashscope' is a change

    // Idempotent re-push (same key) must NOT restart.
    await mgr.setProviderApiKey('cinematography-kb', 'sk-dashscope')
    expect(restarts.length).toBe(1)

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(onDisk.apiKeys['cinematography-kb']).toBe('sk-dashscope')
    // It must NOT have touched the apiyi-mcp slot or the active id.
    expect(onDisk.apiKeys['apiyi-mcp']).toBeUndefined()
    expect(onDisk.selectedProviderId).toBe('apiyi')
  })

  it('a fresh manager preloads the persisted cinematography-kb key so an idempotent re-push does not restart', async () => {
    const first = new AgentManager({ userDataDir: tmpDir, backend: makeStubBackend([]) })
    await first.setProviderApiKey('cinematography-kb', 'sk-keep')

    const { backend, restarts } = makeRestartBackend()
    const second = new AgentManager({ userDataDir: tmpDir, backend })

    // Same key as persisted at construction → cold-start re-push is a no-op.
    await second.setProviderApiKey('cinematography-kb', 'sk-keep')
    expect(restarts.length).toBe(0)

    // A rotated key DOES restart.
    await second.setProviderApiKey('cinematography-kb', 'sk-rotated')
    expect(restarts.length).toBe(1)
  })
})

// Regression — a v4.3.0-rc shipped with `provider: DEFAULT_PROVIDER` (an
// undefined identifier left over from the pre-multi-provider refactor) inside
// testConnection. The IPC call surfaced as `ReferenceError: DEFAULT_PROVIDER
// is not defined`, blocking the "测试 Codex 连接" button entirely. These
// tests pin testConnection to the *currently active* provider and exercise
// both the empty-key short-circuit and the resolution path.
describe('AgentManager testConnection provider resolution', () => {
  it('returns the "please fill in API key" error and never references DEFAULT_PROVIDER when key is empty', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    const result = await mgr.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/API Key/i)
    // The bug we are guarding against is a ReferenceError at module evaluation
    // time. If testConnection threw, vitest would surface it instead of the
    // structured error object above, so reaching this line proves the fix.
  })

  it('uses the currently selected provider for the probe backend (not a hard-coded default)', async () => {
    // Stub backend bypasses the real CodexLocalBackend constructor and its
    // restartCodex hook so we can swap active providers freely. testConnection
    // ignores opts.backend and builds its own fresh CodexLocalBackend, which
    // is exactly the path we want to exercise.
    const stub = makeStubBackend([])
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: stub })

    // Provision a key for rightcode before switching, so testConnection's
    // empty-key short-circuit doesn't fire after the swap.
    await mgr.setProviderApiKey('rightcode', 'sk-rightcode')
    await mgr.setActiveProvider('rightcode')
    expect(mgr.getCodexApiKey()).toBe('sk-rightcode')

    // Monkey-patch CodexLocalBackend.prototype.start so the test isolates the
    // constructor + provider plumbing without spawning an actual Codex
    // process. testConnection wraps `backend.start()` in try/catch and
    // returns { ok: false, error: msg }, so we get a clean assertion target.
    const { CodexLocalBackend } = await import('../CodexLocalBackend')
    const realStart = CodexLocalBackend.prototype.start
    const sentinel = new Error('STOP-PROBE')
    CodexLocalBackend.prototype.start = async function () {
      ;(globalThis as Record<string, unknown>).__capturedProvider = (
        this as unknown as { currentProvider?: { id?: string } }
      ).currentProvider
      throw sentinel
    }
    try {
      const result = await mgr.testConnection()
      expect(result.ok).toBe(false)
      expect(result.error).toBe('STOP-PROBE')
      const captured = (globalThis as Record<string, unknown>).__capturedProvider as
        | { id?: string }
        | undefined
      expect(captured?.id).toBe('rightcode')
    } finally {
      CodexLocalBackend.prototype.start = realStart
      delete (globalThis as Record<string, unknown>).__capturedProvider
    }
  })
})

describe('AgentManager sendMessage empty-key gate', () => {
  it('emits error event and does not start backend when sendMessage called with empty key', async () => {
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      eventSink: (event) => events.push(event),
    })

    const result = await mgr.sendMessage({
      threadId: 't1',
      content: 'hi',
      attachments: [],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      threadId: 't1',
      error: '请在设置页填写 Codex Agent API Key',
    })
    expect(result.threadId).toBe('t1')
  })

  it('uses a placeholder threadId when sendMessage called without threadId and key is empty', async () => {
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      eventSink: (event) => events.push(event),
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('error')
    expect(events[0]?.error).toBe('请在设置页填写 Codex Agent API Key')
    expect(typeof events[0]?.threadId).toBe('string')
    expect(events[0]?.threadId.length).toBeGreaterThan(0)
  })

  it('does not invoke store/attachments when key is empty', async () => {
    let createCalls = 0
    let ingestCalls = 0
    const fakeStore = {
      createThread: async () => {
        createCalls += 1
        return { id: 'should-not-happen' }
      },
    } as any
    const fakeAttachments = {
      ingest: async () => {
        ingestCalls += 1
        return []
      },
    } as any

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
    })

    await mgr.sendMessage({ threadId: 't-empty', content: 'hi', attachments: [] })

    expect(createCalls).toBe(0)
    expect(ingestCalls).toBe(0)
  })
})

describe('AgentManager codex thread id mapping (regression: invalid thread id)', () => {
  // Codex's app-server requires that thread ids passed to turn/start are UUIDs
  // it itself generated via thread/start. Our DB row ids are CUIDs and must
  // never leak into the wire protocol. AgentManager is responsible for the
  // translation in both directions.
  const CODEX_UUID = '11111111-2222-3333-4444-555555555555'

  beforeEach(async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ openaiApiKey: 'sk-test' }),
      'utf8',
    )
  })

  // Shared no-op persistence hooks. Real flow requires addMessage +
  // updateLastMessageAt to exist on the store; tests that don't care about
  // persistence still need them defined to avoid "is not a function" crashes.
  const persistStubs = {
    addMessage: async () => ({ id: 'msg-stub' }),
    updateLastMessageAt: async () => undefined,
  }

  it('passes undefined to backend.send on first turn (lets backend create codex thread)', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-1' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].threadId).toBeUndefined()
  })

  it('rewrites event.threadId from codex UUID to DB cuid before forwarding to renderer', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-2' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'message_delta', threadId: CODEX_UUID, turnId: 't1', delta: 'hello' },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(events).toHaveLength(3)
    for (const e of events) expect(e.threadId).toBe('cm-db-id-2')
  })

  it('on a second sendMessage with same DB threadId, passes the cached codex UUID to backend.send', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-3' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
      [{ type: 'turn_completed', threadId: CODEX_UUID, turnId: 't2' }],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    const r1 = await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)
    expect(r1.threadId).toBe('cm-db-id-3')
    expect(backend.calls[0].threadId).toBeUndefined()

    await mgr.sendMessage({ threadId: 'cm-db-id-3', content: 'second', attachments: [] })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1].threadId).toBe(CODEX_UUID)
  })

  it('after codex restarts (epoch bump), starts a FRESH thread instead of wedging on the stale UUID', async () => {
    // Repro for the "闪退后同一对话无法连续对话" bug: when the codex app-server is
    // respawned mid-conversation (crash recovery or provider/config switch), the
    // in-memory thread is gone, but the AgentManager kept mapping db→old UUID, so
    // every later turn 404'd on `turn/start` and the chat was wedged until a full
    // app restart. The epoch guard must detect the respawn and start fresh.
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-epoch' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'ffffffff-0000-1111-2222-333333333333'

    let epoch = 1
    const calls: BackendCall[] = []
    const backend = {
      calls,
      cancelCalls: [] as string[],
      async start() {},
      async stop() {},
      isHealthy() { return true },
      currentEpoch() { return epoch },
      async cancel() {},
      async *send(threadId: string | undefined, input: AgentInput) {
        calls.push({ threadId, input })
        const created = calls.length === 1 ? CODEX_UUID : recoveredUuid
        yield { type: 'thread_created', threadId: created } as AgentStreamEvent
        yield { type: 'turn_completed', threadId: created, turnId: `t${calls.length}` } as AgentStreamEvent
      },
    } satisfies IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] }

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)
    expect(backend.calls[0].threadId).toBeUndefined()

    // Codex app-server was respawned (crash self-heal / provider switch).
    epoch = 2

    await mgr.sendMessage({ threadId: 'cm-db-epoch', content: 'second', attachments: [] })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(2)
    // FRESH start, NOT the stale UUID the dead app-server generation minted.
    expect(backend.calls[1].threadId).toBeUndefined()
    const notices = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'notice' }> => e.type === 'notice',
    )
    expect(notices.some((n) => n.notice.kind === 'threadContextReset')).toBe(true)
  })

  it('after codex restarts, RESUMES the same thread (preserving context) when the backend supports thread/resume', async () => {
    // Fix B: instead of discarding context, reload the persisted thread from
    // disk into the respawned app-server via `thread/resume`, then keep using
    // the SAME codex thread id so the conversation continues with full memory.
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-resume' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any

    let epoch = 1
    const calls: BackendCall[] = []
    const resumed: string[] = []
    const backend = {
      calls,
      cancelCalls: [] as string[],
      async start() {},
      async stop() {},
      isHealthy() { return true },
      currentEpoch() { return epoch },
      async resumeThread(threadId: string) { resumed.push(threadId) },
      async cancel() {},
      async *send(threadId: string | undefined, input: AgentInput) {
        calls.push({ threadId, input })
        if (calls.length === 1) {
          yield { type: 'thread_created', threadId: CODEX_UUID } as AgentStreamEvent
        }
        yield { type: 'turn_completed', threadId: CODEX_UUID, turnId: `t${calls.length}` } as AgentStreamEvent
      },
    } satisfies IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] }

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)
    expect(backend.calls[0].threadId).toBeUndefined()

    // Codex app-server respawned (crash self-heal / provider switch).
    epoch = 2

    await mgr.sendMessage({ threadId: 'cm-db-resume', content: 'second', attachments: [] })
    await flushMicrotasks(20)

    // Reloaded the persisted thread, then reused the SAME id → context kept.
    expect(resumed).toEqual([CODEX_UUID])
    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1].threadId).toBe(CODEX_UUID)
    // No "context was reset" notice — the whole point of resume is to keep it.
    const notices = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'notice' }> => e.type === 'notice',
    )
    expect(notices.some((n) => n.notice.kind === 'threadContextReset')).toBe(false)
  })

  it('after a FULL app restart (in-memory map wiped) hydrates the persisted codex thread id and RESUMES it', async () => {
    // Repro for "重启之后 对话又没有记忆了": Fix B only healed app-server respawns
    // WITHIN one app session (the in-memory epoch map survived). A full app
    // *process* restart wipes codexThreadIdByDbThreadId entirely, so the next
    // send started a brand-new codex thread → the model had zero memory of the
    // prior turns even though the rollout still lives on disk under CODEX_HOME.
    // The fix persists the codex thread id to the DB and, on first send after a
    // restart, hydrates it and `thread/resume`s before reusing the same id.
    const DB_ID = 'cm-db-restart'
    // Simulated AgentThread row shared across the two manager "processes".
    let persistedCodexThreadId: string | undefined
    const makeStore = () =>
      ({
        ...persistStubs,
        createThread: async () => ({ id: DB_ID }),
        setCodexThreadId: async (_threadId: string, codexThreadId: string) => {
          persistedCodexThreadId = codexThreadId
        },
        getCodexThreadId: async (_threadId: string) => persistedCodexThreadId,
      }) as any
    const fakeAttachments = { ingest: async () => [] } as any

    // ---- App session #1: thread created, codex id minted + persisted ----
    const backendA = {
      calls: [] as BackendCall[],
      cancelCalls: [] as string[],
      async start() {},
      async stop() {},
      isHealthy() { return true },
      currentEpoch() { return 1 },
      async cancel() {},
      async *send(threadId: string | undefined, input: AgentInput) {
        this.calls.push({ threadId, input })
        yield { type: 'thread_created', threadId: CODEX_UUID } as AgentStreamEvent
        yield { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' } as AgentStreamEvent
      },
    } satisfies IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] }
    const mgrA = new AgentManager({
      userDataDir: tmpDir,
      store: makeStore(),
      attachments: fakeAttachments,
      eventSink: () => {},
      backend: backendA,
    })
    await mgrA.sendMessage({ content: 'remember BANANA-42', attachments: [] })
    await flushMicrotasks(20)
    expect(persistedCodexThreadId).toBe(CODEX_UUID)

    // ---- App fully restarted: brand-new manager, empty in-memory maps,
    //      fresh app-server (epoch resets to 1 again), SAME persisted store ----
    const events: AgentStreamEvent[] = []
    const resumed: string[] = []
    const backendB = {
      calls: [] as BackendCall[],
      cancelCalls: [] as string[],
      async start() {},
      async stop() {},
      isHealthy() { return true },
      currentEpoch() { return 1 },
      async resumeThread(threadId: string) { resumed.push(threadId) },
      async cancel() {},
      async *send(threadId: string | undefined, input: AgentInput) {
        this.calls.push({ threadId, input })
        yield { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't2' } as AgentStreamEvent
      },
    } satisfies IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] }
    const mgrB = new AgentManager({
      userDataDir: tmpDir,
      store: makeStore(),
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend: backendB,
    })

    await mgrB.sendMessage({
      threadId: DB_ID,
      content: 'what did I ask you to remember?',
      attachments: [],
    })
    await flushMicrotasks(20)

    // The crux: resume the persisted thread and reuse the SAME id (memory kept).
    expect(resumed).toEqual([CODEX_UUID])
    expect(backendB.calls).toHaveLength(1)
    expect(backendB.calls[0].threadId).toBe(CODEX_UUID)
    const restartNotices = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'notice' }> => e.type === 'notice',
    )
    expect(restartNotices.some((n) => n.notice.kind === 'threadContextReset')).toBe(false)
  })

  it('retries on a new Codex thread when cached thread encryption is rejected', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-recover' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
      new Error('{"error":{"code":"invalid_encrypted_content","message":"encrypted content could not be decrypted"}}'),
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)
    await mgr.sendMessage({ threadId: 'cm-db-id-recover', content: 'second', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(3)
    expect(backend.calls[1].threadId).toBe(CODEX_UUID)
    expect(backend.calls[2].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
  })

  it('retries when encrypted content rejection arrives as a streamed error event', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-stream-error' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        {
          type: 'error',
          threadId: CODEX_UUID,
          turnId: 't1',
          error: '{"error":{"code":"invalid_encrypted_content","message":"encrypted content could not be decrypted"}}',
        },
      ],
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[0].threadId).toBeUndefined()
    expect(backend.calls[1].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events).toContainEqual({ type: 'turn_completed', threadId: 'cm-db-id-stream-error', turnId: 't2' })
  })

  it('retries on the "missing recognized prefix" encrypted-content variant (apiyi validation_error)', async () => {
    // Live repro 2026-06-11: apiyi's Responses emulation rejects replayed
    // reasoning blocks whose encrypted_content it didn't mint itself with
    //   {"error":{"message":"encrypted content missing recognized prefix
    //    (expected `rsn_` or `smry_`)","type":"invalid_request_error",
    //    "code":"validation_error"}}
    // — different code AND different wording from the two variants the
    // matcher knew, so the self-heal never fired and the raw JSON rendered
    // in chat. The poisoned thread must be retried on a FRESH codex thread.
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-prefix-error' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'cccccccc-dddd-eeee-ffff-000000000000'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        {
          type: 'error',
          threadId: CODEX_UUID,
          turnId: 't1',
          error:
            '{"error":{"message":"encrypted content missing recognized prefix (expected `rsn_` or `smry_`)","localized_message":"Unknown error","type":"invalid_request_error","param":"","code":"validation_error"}}',
        },
      ],
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events).toContainEqual({ type: 'turn_completed', threadId: 'cm-db-id-prefix-error', turnId: 't2' })
  })

  it('retries on a fresh thread when the gateway rejects with request_too_large (oversized replayed history)', async () => {
    // Live repro 2026-06-11: a 5-image view_image batch ballooned the replayed
    // history past apiyi's request-body byte cap. EVERY subsequent turn on
    // that codex thread re-sends the same oversized history → the thread is
    // permanently wedged ("卡住了之后不能继续对话") — openai/codex#11440
    // documents the dead-end and ships no client-side fix. Our escape hatch:
    // drop the poisoned codex thread mapping and re-send the CURRENT message
    // on a fresh thread (small request → succeeds; codex-side memory of the
    // old turns is lost, surfaced to the user via a notice).
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-too-large' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'dddddddd-eeee-ffff-0000-111111111111'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        {
          type: 'error',
          threadId: CODEX_UUID,
          turnId: 't1',
          error:
            '{"error":{"message":"Request exceeds the maximum allowed size","localized_message":"Unknown error","type":"invalid_request_error","param":"","code":"request_too_large"}}',
        },
      ],
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events).toContainEqual({ type: 'turn_completed', threadId: 'cm-db-id-too-large', turnId: 't2' })
    // The user must learn that codex-side memory was reset.
    const notices = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'notice' }> => e.type === 'notice',
    )
    expect(notices.some((n) => n.notice.kind === 'threadContextReset')).toBe(true)
  })

  it('forwards payload.model through to backend.send when caller selects a model', async () => {
    const fakeStore = {
      ...persistStubs,
      createThread: async (args: { model: string }) => ({ id: 'cm-db-id-5', _model: args.model }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [], model: 'o3-pro' })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.model).toBe('o3-pro')
  })

  it('falls back to default model when payload omits model', async () => {
    const fakeStore = { ...persistStubs, createThread: async () => ({ id: 'cm-db-id-6' }) } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(backend.calls[0].input.model).toBe('gpt-5.5')
  })

  it('persists user message immediately and assistant message on turn_completed (regression: empty thread history)', async () => {
    // Before this test was added, AgentManager.forwardEvents only forwarded
    // stream events to the renderer and never called store.addMessage. That
    // meant: (a) restarting the app showed no chat history because
    // AgentMessage rows didn't exist, and (b) ThreadTitleSummarizer's
    // `messages.length < 2` gate always tripped so threads kept the
    // 40-char content fallback as their title.
    const addMessageCalls: Array<{ threadId: string; role: string; items: unknown }> = []
    const lastMessageAtCalls: string[] = []
    const fakeStore = {
      createThread: async () => ({ id: 'cm-persist-1' }),
      addMessage: async (args: { threadId: string; role: string; items: unknown }) => {
        addMessageCalls.push(args)
        return { id: `m-${addMessageCalls.length}` }
      },
      updateLastMessageAt: async (threadId: string) => {
        lastMessageAtCalls.push(threadId)
      },
    } as any
    const fakeAttachments = { ingest: async () => [] } as any

    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'item_started', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text', payload: {} },
        { type: 'item_delta', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: 'hello ' } },
        { type: 'item_delta', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: 'world' } },
        { type: 'item_completed', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text', final: {} },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'hi there', attachments: [] })
    await flushMicrotasks(40)

    // First addMessage = the user turn (synchronous part of sendMessage).
    expect(addMessageCalls.length).toBeGreaterThanOrEqual(2)
    const userCall = addMessageCalls[0]
    expect(userCall).toMatchObject({ threadId: 'cm-persist-1', role: 'user' })
    expect(Array.isArray(userCall.items)).toBe(true)
    const userItems = userCall.items as Array<{ type: string; content?: string }>
    expect(userItems.find((i) => i.type === 'text')).toMatchObject({ type: 'text', content: 'hi there' })

    // Second addMessage = the assistant turn (accumulated from streamed deltas
    // and flushed on turn_completed).
    const asstCall = addMessageCalls[1]
    expect(asstCall).toMatchObject({ threadId: 'cm-persist-1', role: 'assistant' })
    const asstItems = asstCall.items as Array<{ type: string; content?: string; endedAt?: number }>
    const asstText = asstItems.find((i) => i.type === 'text')
    expect(asstText?.content).toBe('hello world')
    expect(asstText?.endedAt).toBeGreaterThan(0)

    // updateLastMessageAt should be bumped after each persisted message.
    expect(lastMessageAtCalls).toEqual(['cm-persist-1', 'cm-persist-1'])
  })

  it('persists assistant turn even when there is no streamed text item', async () => {
    // Tool-only or empty turns: the assistant accumulator may be empty after
    // streaming. We must NOT write a zero-item AgentMessage row, otherwise
    // the timeline shows a phantom blank assistant bubble after restart.
    const addMessageCalls: Array<{ role: string }> = []
    const fakeStore = {
      createThread: async () => ({ id: 'cm-persist-2' }),
      addMessage: async (args: { threadId: string; role: string; items: unknown }) => {
        addMessageCalls.push(args)
        return { id: 'm-x' }
      },
      updateLastMessageAt: async () => undefined,
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(40)

    // Exactly one addMessage call (the user one). No assistant row.
    expect(addMessageCalls.map((c) => c.role)).toEqual(['user'])
  })

  // The user uploads files via the renderer file picker, which only gives us
  // a buffer (no real path on disk visible to the agent). AttachmentService
  // writes that buffer to `userData/agent/uploads/<sha>.<ext>` and returns
  // an AgentAttachment row with `localPath`. Pre-fix `sendMessage` only
  // forwarded `localImage` items to the backend AND never told the agent
  // those paths in the prompt — so when the user asked "where is this
  // file?" the agent had to guess (and guessed `C:\Program Files\...`,
  // wasting tokens on shell tries). Fix: prepend a one-shot "[Attached
  // files at these local paths:]" block to the text item we send to the
  // backend, listing every uploaded file's localPath, original name, mime,
  // and size. This is the ONLY place the agent learns about non-image
  // attachments — they are never sent as protocol items.
  it('injects the localPath of every attachment (image AND non-image) into the prompt sent to the backend', async () => {
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-att' }),
    } as any
    const fakeAttachments = {
      ingest: async () => [
        {
          id: 'att-1',
          threadId: 'cm-db-id-att',
          originalName: 'photo.png',
          localPath: 'C:/uploads/abc.png',
          mime: 'image/png',
          size: 1234,
          uploadedAt: new Date(),
        },
        {
          id: 'att-2',
          threadId: 'cm-db-id-att',
          originalName: 'notes.txt',
          localPath: 'C:/uploads/def.txt',
          mime: 'text/plain',
          size: 5678,
          uploadedAt: new Date(),
        },
      ],
    } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({
      content: '这个文件地址在哪里',
      attachments: [
        { name: 'photo.png', mime: 'image/png', buffer: new Uint8Array([1, 2, 3]).buffer },
        { name: 'notes.txt', mime: 'text/plain', buffer: new Uint8Array([4, 5, 6]).buffer },
      ],
    })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(1)
    const items = backend.calls[0].input.items
    const textItem = items.find((i) => i.type === 'text') as { type: 'text'; text: string }
    expect(textItem).toBeDefined()
    // The agent must see BOTH paths verbatim — that's the whole point.
    expect(textItem.text).toContain('C:/uploads/abc.png')
    expect(textItem.text).toContain('C:/uploads/def.txt')
    // Original filename should be there too so the agent can refer to files
    // by the user-meaningful name when responding.
    expect(textItem.text).toContain('photo.png')
    expect(textItem.text).toContain('notes.txt')
    // The original user prompt must still be present (we wrap it, not
    // replace it).
    expect(textItem.text).toContain('这个文件地址在哪里')
    // Image still travels as a localImage protocol item so the model can
    // actually see its pixels (text-prompt path-only is not enough for
    // images). Non-images do NOT — they live only in the preamble.
    const localImagePaths = items
      .filter((i): i is Extract<typeof i, { type: 'localImage' }> => i.type === 'localImage')
      .map((i) => i.path)
    expect(localImagePaths).toEqual(['C:/uploads/abc.png'])
  })

  it('does not add an attachments preamble when there are no attachments', async () => {
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-noatt' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'plain question', attachments: [] })
    await flushMicrotasks(20)

    const textItem = backend.calls[0].input.items.find((i) => i.type === 'text') as {
      type: 'text'
      text: string
    }
    // Without attachments we keep the user's prompt EXACTLY as typed — no
    // surprise preamble bytes inflating their input tokens.
    expect(textItem.text).toBe('plain question')
  })

  it('cancel(dbThreadId) translates to backend.cancel(codexThreadId) when mapping exists', async () => {
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-4' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)

    await mgr.cancel('cm-db-id-4')
    expect(backend.cancelCalls).toEqual([CODEX_UUID])
  })

  // Regression: a swallowed bootstrap start() failure left the backend client
  // null, so the first send threw the opaque "CodexLocalBackend.send called
  // before start". sendMessage now (re)starts lazily and surfaces the REAL
  // startup error as a normal error event, keeping the turn recoverable.
  it('surfaces the real backend startup error as an error event instead of the cryptic "called before start"', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = { ...persistStubs, createThread: async () => ({ id: 'cm-db-id-startfail' }) } as any
    const fakeAttachments = { ingest: async () => [] } as any
    let sendCalled = false
    const backend: IAgentBackend = {
      async start() {
        throw new Error('`wire_api = "chat"` is no longer supported')
      },
      async stop() {},
      isHealthy() { return false },
      async cancel() {},
      async *send() { sendCalled = true },
    }
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(sendCalled).toBe(false)
    const err = events.find((e) => e.type === 'error') as
      | Extract<AgentStreamEvent, { type: 'error' }>
      | undefined
    expect(err).toBeTruthy()
    expect(err?.error).toContain('wire_api = "chat"')
  })

  it('lazily starts an unhealthy backend on send and dedupes concurrent starts', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = { ...persistStubs, createThread: async () => ({ id: 'cm-db-id-lazy' }) } as any
    const fakeAttachments = { ingest: async () => [] } as any
    let startCount = 0
    let healthy = false
    const backend: IAgentBackend = {
      async start() {
        startCount += 1
        await Promise.resolve()
        healthy = true
      },
      async stop() {},
      isHealthy() { return healthy },
      async cancel() {},
      async *send() {
        yield { type: 'thread_created', threadId: CODEX_UUID }
        yield { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' }
      },
    }
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await Promise.all([
      mgr.sendMessage({ content: 'a', attachments: [] }),
      mgr.sendMessage({ content: 'b', attachments: [] }),
    ])
    await flushMicrotasks(20)

    expect(startCount).toBe(1)
  })
})
