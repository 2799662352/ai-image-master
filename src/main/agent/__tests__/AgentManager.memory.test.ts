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
