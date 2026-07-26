/**
 * AgentManager `*Rpc` envelopes for the Codex cross-session memory surface
 * (thread/memoryMode/set + memory/reset, app-server v2, `#[experimental]` @
 * rust-v0.145.0). `setThreadMemoryModeRpc` resolves the renderer's DB thread
 * id to the codex thread id exactly like the goal Rpc wrappers;
 * `resetMemoryRpc` is global (no thread id). Both wrap results in the
 * standard `{ ok, error?, data? }` shape. Mirrors AgentManager.goals.test.ts.
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-memory-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function fakeBackend(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    cancel: vi.fn(),
    isHealthy: vi.fn().mockReturnValue(true),
    onMcpNotification: vi.fn(),
    setThreadMemoryMode: vi.fn().mockResolvedValue({}),
    resetMemory: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

/** A store stub that maps a DB thread id to a codex thread id. */
function fakeStore(codexThreadId: string | null) {
  return { getCodexThreadId: vi.fn().mockResolvedValue(codexThreadId) }
}

function makeManager(backend: ReturnType<typeof fakeBackend>, store?: ReturnType<typeof fakeStore>) {
  return new AgentManager({ userDataDir: tmpDir, backend: backend as any, store: store as any })
}

describe('AgentManager memory Rpc envelopes', () => {
  it('setThreadMemoryModeRpc maps DB id → codex id and forwards the mode', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.setThreadMemoryModeRpc('db-1', 'disabled')
    expect(backend.setThreadMemoryMode).toHaveBeenCalledWith('thr_codex', 'disabled')
    expect(res).toEqual({ ok: true })
  })

  it('setThreadMemoryModeRpc rejects an invalid mode before touching the backend', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.setThreadMemoryModeRpc('db-1', 'bogus' as never)
    expect(res.ok).toBe(false)
    expect(backend.setThreadMemoryMode).not.toHaveBeenCalled()
  })

  it('setThreadMemoryModeRpc returns a friendly error when no codex thread exists yet', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore(null))
    const res = await mgr.setThreadMemoryModeRpc('db-1', 'enabled')
    expect(res.ok).toBe(false)
    expect(backend.setThreadMemoryMode).not.toHaveBeenCalled()
  })

  it('setThreadMemoryModeRpc returns ok:false when the backend lacks the API', async () => {
    const backend = fakeBackend({ setThreadMemoryMode: undefined })
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.setThreadMemoryModeRpc('db-1', 'enabled')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unavailable/i)
  })

  it('resetMemoryRpc delegates to the backend', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.resetMemoryRpc()
    expect(backend.resetMemory).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: true })
  })

  it('resetMemoryRpc returns ok:false when the backend lacks the API', async () => {
    const backend = fakeBackend({ resetMemory: undefined })
    const mgr = makeManager(backend, fakeStore(null))
    const res = await mgr.resetMemoryRpc()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unavailable/i)
  })

  it('resetMemoryRpc returns ok:false with the message when the backend throws', async () => {
    const backend = fakeBackend({ resetMemory: vi.fn().mockRejectedValue(new Error('boom')) })
    const mgr = makeManager(backend, fakeStore(null))
    const res = await mgr.resetMemoryRpc()
    expect(res).toEqual({ ok: false, error: 'boom' })
  })
})

/**
 * The DURABLE half of the feature. `thread/memoryMode/set` needs a live codex
 * thread id, but users decide "remember this one or not" independently of when
 * a codex thread happens to exist — and every fork/rebind/restart mints a new
 * one. So the choice is persisted and replayed, and these tests pin both halves.
 */
function fakeDurableStore(overrides: Record<string, unknown> = {}) {
  return {
    getCodexThreadId: vi.fn().mockResolvedValue(null),
    setCodexThreadId: vi.fn().mockResolvedValue(undefined),
    setThreadMemoryMode: vi.fn().mockResolvedValue(undefined),
    getThreadMemoryMode: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

/** Let the fire-and-forget re-assert chain settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('AgentManager per-thread memory declaration', () => {
  it('persists the choice and pushes it when a codex thread already exists', async () => {
    const backend = fakeBackend()
    const store = fakeDurableStore({ getCodexThreadId: vi.fn().mockResolvedValue('thr_codex') })
    const mgr = makeManager(backend, store as never)

    const res = await mgr.declareThreadMemoryModeRpc('db-1', 'disabled')

    expect(store.setThreadMemoryMode).toHaveBeenCalledWith('db-1', 'disabled')
    expect(backend.setThreadMemoryMode).toHaveBeenCalledWith('thr_codex', 'disabled')
    expect(res).toEqual({ ok: true, pushed: true })
  })

  it('succeeds before any codex thread exists, reporting the choice as not yet live', async () => {
    const backend = fakeBackend()
    const store = fakeDurableStore()
    const mgr = makeManager(backend, store as never)

    const res = await mgr.declareThreadMemoryModeRpc('db-1', 'disabled')

    // The whole reason this exists instead of reusing setThreadMemoryModeRpc:
    // "no codex thread yet" is the normal case, not an error.
    expect(res).toEqual({ ok: true, pushed: false })
    expect(store.setThreadMemoryMode).toHaveBeenCalledWith('db-1', 'disabled')
    expect(backend.setThreadMemoryMode).not.toHaveBeenCalled()
  })

  it('rejects an invalid mode without writing anything', async () => {
    const backend = fakeBackend()
    const store = fakeDurableStore()
    const mgr = makeManager(backend, store as never)

    const res = await mgr.declareThreadMemoryModeRpc('db-1', 'bogus' as never)

    expect(res.ok).toBe(false)
    expect(store.setThreadMemoryMode).not.toHaveBeenCalled()
    expect(backend.setThreadMemoryMode).not.toHaveBeenCalled()
  })

  it('replays the persisted choice onto a newly established codex thread', async () => {
    const backend = fakeBackend()
    const store = fakeDurableStore({
      getThreadMemoryMode: vi.fn().mockResolvedValue('disabled'),
    })
    const mgr = makeManager(backend, store as never)

    // Every mint/re-establish path funnels through rememberCodexThread, so this
    // one call stands in for first start, fork, rebind, and restart hydration.
    ;(mgr as unknown as { rememberCodexThread(a: string, b: string): void })
      .rememberCodexThread('db-1', 'thr_fresh')
    await flushMicrotasks()

    expect(backend.setThreadMemoryMode).toHaveBeenCalledWith('thr_fresh', 'disabled')
  })

  it('leaves a thread that never chose a mode on the codex default', async () => {
    const backend = fakeBackend()
    const store = fakeDurableStore()
    const mgr = makeManager(backend, store as never)

    ;(mgr as unknown as { rememberCodexThread(a: string, b: string): void })
      .rememberCodexThread('db-1', 'thr_fresh')
    await flushMicrotasks()

    expect(backend.setThreadMemoryMode).not.toHaveBeenCalled()
  })

  it('disables memory on a channel that cannot write valid artifacts, even with no user choice', async () => {
    // The hole this closes: `supportsMemories: false` only emits the
    // process-wide `features.memories=false` when that channel is active AT
    // SPAWN. Switching gpt-5.5 → claude-opus-5 inside one rightcode spawn is
    // served by in-process routing (the sibling table is already registered),
    // so no restart happens and the launch flag still says memories are on —
    // leaving Claude free to write the malformed entries the flag exists to
    // prevent. Per-thread mode is the only lever that follows the binding.
    const backend = fakeBackend()
    const store = fakeDurableStore({
      getThreadRoutingSnapshot: vi.fn().mockResolvedValue({
        exists: true,
        model: 'claude-opus-5',
        modelProvider: 'rightcode-claude',
        gatewayId: 'rightcode',
      }),
    })
    const mgr = makeManager(backend, store as never)

    ;(mgr as unknown as { rememberCodexThread(a: string, b: string): void })
      .rememberCodexThread('db-1', 'thr_fresh')
    await flushMicrotasks()

    expect(backend.setThreadMemoryMode).toHaveBeenCalledWith('thr_fresh', 'disabled')
    // A capability override is not a user decision: the persisted choice must
    // survive untouched so moving the thread back to a GPT channel restores it.
    expect(store.setThreadMemoryMode).not.toHaveBeenCalled()
  })

  it('lets the channel override an explicit enabled, and restores it on a capable channel', async () => {
    const claudeBackend = fakeBackend()
    const claudeStore = fakeDurableStore({
      getThreadMemoryMode: vi.fn().mockResolvedValue('enabled'),
      getThreadRoutingSnapshot: vi.fn().mockResolvedValue({
        exists: true,
        model: 'claude-opus-5',
        modelProvider: 'rightcode-claude',
        gatewayId: 'rightcode',
      }),
    })
    const onClaude = makeManager(claudeBackend, claudeStore as never)
    ;(onClaude as unknown as { rememberCodexThread(a: string, b: string): void })
      .rememberCodexThread('db-1', 'thr_claude')
    await flushMicrotasks()
    expect(claudeBackend.setThreadMemoryMode).toHaveBeenCalledWith('thr_claude', 'disabled')

    const gptBackend = fakeBackend()
    const gptStore = fakeDurableStore({
      getThreadMemoryMode: vi.fn().mockResolvedValue('enabled'),
      getThreadRoutingSnapshot: vi.fn().mockResolvedValue({
        exists: true,
        model: 'gpt-5.5',
        modelProvider: 'rightcode-standard',
        gatewayId: 'rightcode',
      }),
    })
    const onGpt = makeManager(gptBackend, gptStore as never)
    ;(onGpt as unknown as { rememberCodexThread(a: string, b: string): void })
      .rememberCodexThread('db-1', 'thr_gpt')
    await flushMicrotasks()
    expect(gptBackend.setThreadMemoryMode).toHaveBeenCalledWith('thr_gpt', 'enabled')
  })

  it('reads the capability off the rebind target, not the binding it is replacing', async () => {
    // A rebind forks onto the new channel before the new binding is persisted,
    // so resolving through the store here would read the OUTGOING channel and
    // leave memory on for the incoming Claude thread.
    const backend = fakeBackend({
      forkThread: vi.fn().mockResolvedValue({ id: 'thr_forked' }),
      unsubscribeThread: vi.fn().mockResolvedValue(undefined),
    })
    const store = fakeDurableStore({
      getThreadRoutingSnapshot: vi.fn().mockResolvedValue({
        exists: true,
        model: 'gpt-5.5',
        modelProvider: 'rightcode-standard',
        gatewayId: 'rightcode',
      }),
    })
    const mgr = makeManager(backend, store as never)

    await (mgr as unknown as {
      rebindThreadInProcess(
        db: string,
        codex: string,
        target: { channelId: string; modelId: string; contextWindow: number },
      ): Promise<void>
    }).rebindThreadInProcess('db-1', 'thr_old', {
      channelId: 'rightcode-claude',
      modelId: 'claude-opus-5',
      contextWindow: 272_000,
    })
    await flushMicrotasks()

    expect(backend.setThreadMemoryMode).toHaveBeenCalledWith('thr_forked', 'disabled')
  })

  it('swallows a failed replay rather than breaking the turn it rides on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const backend = fakeBackend({
      setThreadMemoryMode: vi.fn().mockRejectedValue(new Error('backend down')),
    })
    const store = fakeDurableStore({
      getThreadMemoryMode: vi.fn().mockResolvedValue('disabled'),
    })
    const mgr = makeManager(backend, store as never)

    expect(() =>
      (mgr as unknown as { rememberCodexThread(a: string, b: string): void })
        .rememberCodexThread('db-1', 'thr_fresh'),
    ).not.toThrow()
    await flushMicrotasks()

    // Asserting the message, not just "warn fired": rememberCodexThread also
    // warns on a failed codexThreadId persist, so a bare call count could pass
    // for the wrong reason.
    expect(warn.mock.calls.some((args) => /memory mode/i.test(String(args[0])))).toBe(true)
  })
})
