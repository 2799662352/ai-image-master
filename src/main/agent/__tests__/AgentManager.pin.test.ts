/**
 * AgentManager.setThreadPinned — sidebar pin (design D1).
 *
 * The DB column is authoritative: it is written first and unconditionally.
 * Codex's own persisted pin (`thread/metadata/update { isPinned }`, PR #34840,
 * bundled codex-cli ≥ 0.152) is mirrored best-effort through the backend when
 * a codex thread id is resolvable; every mirror failure mode (no method on an
 * older backend, backend down, thread never started, RPC error) must leave the
 * local pin intact and never surface to the caller.
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pin-'))
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
    updateThreadMetadata: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function fakeStore(codexThreadId: string | null) {
  return {
    getCodexThreadId: vi.fn().mockResolvedValue(codexThreadId),
    setThreadPinned: vi.fn().mockResolvedValue(undefined),
  }
}

function makeManager(backend: ReturnType<typeof fakeBackend>, store: ReturnType<typeof fakeStore>) {
  return new AgentManager({ userDataDir: tmpDir, backend: backend as any, store: store as any })
}

describe('AgentManager.setThreadPinned', () => {
  it('persists the pin locally and mirrors it to codex when the thread has a codex id', async () => {
    const backend = fakeBackend()
    const store = fakeStore('thr_codex')
    await makeManager(backend, store).setThreadPinned('db-1', true)
    expect(store.setThreadPinned).toHaveBeenCalledWith('db-1', true)
    expect(backend.updateThreadMetadata).toHaveBeenCalledWith('thr_codex', { isPinned: true })
  })

  it('unpin mirrors isPinned:false', async () => {
    const backend = fakeBackend()
    const store = fakeStore('thr_codex')
    await makeManager(backend, store).setThreadPinned('db-1', false)
    expect(store.setThreadPinned).toHaveBeenCalledWith('db-1', false)
    expect(backend.updateThreadMetadata).toHaveBeenCalledWith('thr_codex', { isPinned: false })
  })

  it('skips the mirror (but still persists) when the thread never talked to codex', async () => {
    const backend = fakeBackend()
    const store = fakeStore(null)
    await makeManager(backend, store).setThreadPinned('db-1', true)
    expect(store.setThreadPinned).toHaveBeenCalledWith('db-1', true)
    expect(backend.updateThreadMetadata).not.toHaveBeenCalled()
  })

  it('skips the mirror when the backend predates thread/metadata/update', async () => {
    const backend = fakeBackend({ updateThreadMetadata: undefined })
    const store = fakeStore('thr_codex')
    await expect(makeManager(backend, store).setThreadPinned('db-1', true)).resolves.toBeUndefined()
    expect(store.setThreadPinned).toHaveBeenCalledWith('db-1', true)
  })

  it('skips the mirror while the backend is down', async () => {
    const backend = fakeBackend({ isHealthy: vi.fn().mockReturnValue(false) })
    const store = fakeStore('thr_codex')
    await makeManager(backend, store).setThreadPinned('db-1', true)
    expect(store.setThreadPinned).toHaveBeenCalled()
    expect(backend.updateThreadMetadata).not.toHaveBeenCalled()
  })

  it('swallows a mirror RPC failure — the local pin is the truth', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const backend = fakeBackend({ updateThreadMetadata: vi.fn().mockRejectedValue(new Error('method not found')) })
    const store = fakeStore('thr_codex')
    await expect(makeManager(backend, store).setThreadPinned('db-1', true)).resolves.toBeUndefined()
    expect(store.setThreadPinned).toHaveBeenCalledWith('db-1', true)
    expect(warn).toHaveBeenCalled()
  })

  it('propagates a local persistence failure instead of hiding it', async () => {
    const backend = fakeBackend()
    const store = fakeStore('thr_codex')
    store.setThreadPinned.mockRejectedValue(new Error('db locked'))
    await expect(makeManager(backend, store).setThreadPinned('db-1', true)).rejects.toThrow('db locked')
    expect(backend.updateThreadMetadata).not.toHaveBeenCalled()
  })
})
