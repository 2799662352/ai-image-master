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
