import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, Set<unknown>>()
  return {
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel)
      },
      on: (channel: string, handler: unknown) => {
        const set = listeners.get(channel) ?? new Set<unknown>()
        set.add(handler)
        listeners.set(channel, set)
      },
      removeAllListeners: (channel: string) => {
        listeners.delete(channel)
      },
      __getHandler: (channel: string) => handlers.get(channel),
      __listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
      __reset: () => {
        handlers.clear()
        listeners.clear()
      },
    },
  }
})

import { ipcMain } from 'electron'
import { registerAgentIpc } from '../ipc'

interface FakeManager {
  openThread: ReturnType<typeof vi.fn>
  renameThread: ReturnType<typeof vi.fn>
  deleteThread: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  listThreads: ReturnType<typeof vi.fn>
  loadThread: ReturnType<typeof vi.fn>
  setCodexApiKey: ReturnType<typeof vi.fn>
  testConnection: ReturnType<typeof vi.fn>
  getSessionStatus: ReturnType<typeof vi.fn>
  setSessionConfigPatch: ReturnType<typeof vi.fn>
  setAllowedRoots: ReturnType<typeof vi.fn>
  respondToApprovalResponse: ReturnType<typeof vi.fn>
  listCodexThreads: ReturnType<typeof vi.fn>
  readCodexThread: ReturnType<typeof vi.fn>
  forkCodexThread: ReturnType<typeof vi.fn>
}

function makeManager(): FakeManager {
  return {
    openThread: vi.fn().mockResolvedValue({ id: 't1' }),
    renameThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    cancel: vi.fn(),
    listThreads: vi.fn(),
    loadThread: vi.fn(),
    setCodexApiKey: vi.fn(),
    testConnection: vi.fn(),
    getSessionStatus: vi.fn(),
    setSessionConfigPatch: vi.fn(),
    setAllowedRoots: vi.fn(),
    respondToApprovalResponse: vi.fn().mockResolvedValue({ ok: true }),
    listCodexThreads: vi.fn().mockResolvedValue([]),
    readCodexThread: vi.fn().mockResolvedValue({ id: 'codex-1' }),
    forkCodexThread: vi.fn().mockResolvedValue({ id: 'codex-fork-1' }),
  }
}

const router = { handleRendererResponse: vi.fn() } as unknown as {
  handleRendererResponse: (response: unknown) => void
}

const get = (channel: string): ((...args: unknown[]) => unknown) | undefined => {
  return (
    ipcMain as unknown as { __getHandler: (c: string) => ((...a: unknown[]) => unknown) | undefined }
  ).__getHandler(channel)
}

const listenerCount = (channel: string): number => {
  return (ipcMain as unknown as { __listenerCount: (c: string) => number }).__listenerCount(channel)
}

describe('registerAgentIpc thread management handlers', () => {
  let manager: FakeManager

  beforeEach(() => {
    ;(ipcMain as unknown as { __reset: () => void }).__reset()
    manager = makeManager()
    registerAgentIpc(
      manager as unknown as Parameters<typeof registerAgentIpc>[0],
      router as unknown as Parameters<typeof registerAgentIpc>[1],
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers agent:open-thread and forwards the threadId', async () => {
    const handler = get('agent:open-thread')
    expect(handler).toBeTypeOf('function')
    await handler!({}, 'thread-abc')
    expect(manager.openThread).toHaveBeenCalledWith('thread-abc')
  })

  it('registers agent:rename-thread and forwards id + title', async () => {
    const handler = get('agent:rename-thread')
    expect(handler).toBeTypeOf('function')
    await handler!({}, 'thread-abc', 'New title')
    expect(manager.renameThread).toHaveBeenCalledWith('thread-abc', 'New title')
  })

  it('registers agent:delete-thread and forwards the id', async () => {
    const handler = get('agent:delete-thread')
    expect(handler).toBeTypeOf('function')
    await handler!({}, 'thread-abc')
    expect(manager.deleteThread).toHaveBeenCalledWith('thread-abc')
  })

  it('can be registered again after an Electron dev reload', () => {
    const nextManager = makeManager()
    registerAgentIpc(
      nextManager as unknown as Parameters<typeof registerAgentIpc>[0],
      router as unknown as Parameters<typeof registerAgentIpc>[1],
    )

    expect(get('agent:open-thread')).toBeTypeOf('function')
    expect(listenerCount('agent:tool-response')).toBe(1)
  })

  it('validates and forwards approval responses', async () => {
    const handler = get('agent:respond-approval')
    expect(handler).toBeTypeOf('function')

    await handler!({}, { id: '41', approved: false, message: 'not now' })

    expect(manager.respondToApprovalResponse).toHaveBeenCalledWith({
      id: '41',
      approved: false,
      message: 'not now',
    })
  })

  it('rejects invalid approval responses', async () => {
    const handler = get('agent:respond-approval')
    expect(handler).toBeTypeOf('function')

    await expect(handler!({}, { id: '', approved: true })).rejects.toThrow(/id/)
    expect(manager.respondToApprovalResponse).not.toHaveBeenCalled()
  })

  it('registers agent:list-codex-threads and forwards to manager', async () => {
    const handler = get('agent:list-codex-threads')
    expect(handler).toBeTypeOf('function')
    await handler!({})
    expect(manager.listCodexThreads).toHaveBeenCalled()
  })

  it('validates and forwards codex thread read/fork ids', async () => {
    const readHandler = get('agent:read-codex-thread')
    const forkHandler = get('agent:fork-codex-thread')
    expect(readHandler).toBeTypeOf('function')
    expect(forkHandler).toBeTypeOf('function')

    await readHandler!({}, 'codex-1')
    await forkHandler!({}, 'codex-1')

    expect(manager.readCodexThread).toHaveBeenCalledWith('codex-1')
    expect(manager.forkCodexThread).toHaveBeenCalledWith('codex-1')
    await expect(readHandler!({}, '')).rejects.toThrow(/non-empty/)
    await expect(forkHandler!({}, '   ')).rejects.toThrow(/non-empty/)
  })
})
