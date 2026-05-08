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
})
