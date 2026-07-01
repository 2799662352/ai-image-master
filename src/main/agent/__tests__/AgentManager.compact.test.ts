/**
 * AgentManager.compactThreadRpc envelope for the Codex native `/compact` surface
 * (thread/compact/start, app-server v2). Resolves the renderer's DB thread id to
 * the codex thread id (in-memory map, falling back to the persisted id via the
 * store), delegates to the backend passthrough, and wraps the result in the
 * standard `{ ok, error?, data? }` shape. Mirrors AgentManager.goals.test.ts.
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-compact-'))
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
    compactThread: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

function fakeStore(codexThreadId: string | null) {
  return { getCodexThreadId: vi.fn().mockResolvedValue(codexThreadId) }
}

function makeManager(backend: ReturnType<typeof fakeBackend>, store?: ReturnType<typeof fakeStore>) {
  return new AgentManager({ userDataDir: tmpDir, backend: backend as any, store: store as any })
}

describe('AgentManager.compactThreadRpc', () => {
  it('maps DB id → codex id and kicks off compaction', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.compactThreadRpc('db-1')
    expect(backend.compactThread).toHaveBeenCalledWith('thr_codex')
    expect(res).toEqual({ ok: true, data: { started: true } })
  })

  it('returns a friendly error when no codex thread exists yet', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore(null))
    const res = await mgr.compactThreadRpc('db-1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/\/compact/)
    expect(backend.compactThread).not.toHaveBeenCalled()
  })

  it('returns ok:false when the backend lacks the compact API', async () => {
    const backend = fakeBackend({ compactThread: undefined })
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.compactThreadRpc('db-1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unavailable/i)
  })

  it('returns ok:false with the message when the backend throws', async () => {
    const backend = fakeBackend({ compactThread: vi.fn().mockRejectedValue(new Error('boom')) })
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.compactThreadRpc('db-1')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })
})
