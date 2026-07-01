/**
 * AgentManager `*Rpc` envelopes for the Codex native `/goal` surface
 * (thread/goal/set|get|clear, app-server v2). Each resolves the renderer's DB
 * thread id to the codex thread id (in-memory map, falling back to the persisted
 * id via the store), delegates to the backend passthrough, and wraps the result
 * in the standard `{ ok, error?, data? }` shape. Mirrors AgentManager.plugins.test.ts.
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-goals-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

const sampleGoal = {
  threadId: 'thr_codex',
  objective: 'ship it',
  status: 'active' as const,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
}

function fakeBackend(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    cancel: vi.fn(),
    isHealthy: vi.fn().mockReturnValue(true),
    onMcpNotification: vi.fn(),
    setThreadGoal: vi.fn().mockResolvedValue({ goal: sampleGoal }),
    getThreadGoal: vi.fn().mockResolvedValue({ goal: sampleGoal }),
    clearThreadGoal: vi.fn().mockResolvedValue({ cleared: true }),
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

describe('AgentManager goal Rpc envelopes', () => {
  it('setThreadGoalRpc maps DB id → codex id and forwards params', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.setThreadGoalRpc('db-1', { objective: 'ship it' })
    expect(backend.setThreadGoal).toHaveBeenCalledWith({ threadId: 'thr_codex', objective: 'ship it' })
    expect(res).toEqual({ ok: true, data: sampleGoal })
  })

  it('setThreadGoalRpc forwards a status change (pause/resume)', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    await mgr.setThreadGoalRpc('db-1', { status: 'paused' })
    expect(backend.setThreadGoal).toHaveBeenCalledWith({ threadId: 'thr_codex', status: 'paused' })
  })

  it('setThreadGoalRpc returns a friendly error when no codex thread exists yet', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore(null))
    const res = await mgr.setThreadGoalRpc('db-1', { objective: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/\/goal/)
    expect(backend.setThreadGoal).not.toHaveBeenCalled()
  })

  it('getThreadGoalRpc returns data:null when no codex thread exists (not fetched)', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore(null))
    const res = await mgr.getThreadGoalRpc('db-1')
    expect(res).toEqual({ ok: true, data: null })
    expect(backend.getThreadGoal).not.toHaveBeenCalled()
  })

  it('getThreadGoalRpc delegates and unwraps the goal', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.getThreadGoalRpc('db-1')
    expect(backend.getThreadGoal).toHaveBeenCalledWith('thr_codex')
    expect(res).toEqual({ ok: true, data: sampleGoal })
  })

  it('clearThreadGoalRpc delegates and returns cleared', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.clearThreadGoalRpc('db-1')
    expect(backend.clearThreadGoal).toHaveBeenCalledWith('thr_codex')
    expect(res).toEqual({ ok: true, data: { cleared: true } })
  })

  it('clearThreadGoalRpc returns cleared:false when no codex thread exists', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend, fakeStore(null))
    const res = await mgr.clearThreadGoalRpc('db-1')
    expect(res).toEqual({ ok: true, data: { cleared: false } })
  })

  it('returns ok:false when the backend lacks the goal API', async () => {
    const backend = fakeBackend({ setThreadGoal: undefined })
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.setThreadGoalRpc('db-1', { objective: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unavailable/i)
  })

  it('returns ok:false with the message when the backend throws', async () => {
    const backend = fakeBackend({ setThreadGoal: vi.fn().mockRejectedValue(new Error('boom')) })
    const mgr = makeManager(backend, fakeStore('thr_codex'))
    const res = await mgr.setThreadGoalRpc('db-1', { objective: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })
})
