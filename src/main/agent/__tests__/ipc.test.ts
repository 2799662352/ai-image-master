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
  steer: ReturnType<typeof vi.fn>
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
  getProvidersSnapshot: ReturnType<typeof vi.fn>
  setActiveProvider: ReturnType<typeof vi.fn>
  setProviderApiKey: ReturnType<typeof vi.fn>
  addCustomProvider: ReturnType<typeof vi.fn>
  updateCustomProvider: ReturnType<typeof vi.fn>
  removeCustomProvider: ReturnType<typeof vi.fn>
}

function makeManager(): FakeManager {
  return {
    openThread: vi.fn().mockResolvedValue({ id: 't1' }),
    renameThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    steer: vi.fn().mockResolvedValue({ threadId: 't1' }),
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
    getProvidersSnapshot: vi.fn().mockResolvedValue({
      builtins: [{ id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' }],
      custom: [],
      activeId: 'apiyi',
      apiKeys: {},
    }),
    setActiveProvider: vi.fn().mockResolvedValue({
      ok: true,
      activeId: 'rightcode',
      providerGeneration: 2,
    }),
    setProviderApiKey: vi.fn().mockResolvedValue({
      ok: true,
      activeId: 'apiyi',
      providerGeneration: 3,
    }),
    addCustomProvider: vi.fn().mockResolvedValue({
      id: 'custom-1',
      name: 'My',
      baseUrl: 'https://x',
      envKey: 'OPENAI_API_KEY',
      isCustom: true,
    }),
    updateCustomProvider: vi.fn().mockResolvedValue({
      ok: true,
      activeId: 'custom-1',
      providerGeneration: 4,
    }),
    removeCustomProvider: vi.fn().mockResolvedValue({
      ok: true,
      activeId: 'apiyi',
      providerGeneration: 5,
    }),
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
      () => Promise.resolve(manager as unknown as Awaited<ReturnType<Parameters<typeof registerAgentIpc>[0]>>),
      () => router as unknown as ReturnType<Parameters<typeof registerAgentIpc>[1]>,
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

  it('normalizes message createdAt (Date | ISO string) to epoch numbers on open-thread', async () => {
    // A `Date` does not reliably survive structured-clone across the
    // contextBridge as a usable value; the renderer orders + timestamps the
    // timeline by a numeric createdAt, so the handler must emit numbers.
    const date = new Date('2026-06-05T10:00:00.000Z')
    manager.openThread.mockResolvedValueOnce({
      id: 't1',
      messages: [
        { id: 'm1', role: 'user', items: '[]', createdAt: date },
        { id: 'm2', role: 'assistant', items: '[]', createdAt: '2026-06-05T10:05:00.000Z' },
        { id: 'm3', role: 'assistant', items: '[]' },
      ],
    })

    const handler = get('agent:open-thread')!
    const result = (await handler({}, 't1')) as {
      messages: Array<{ id: string; createdAt?: unknown }>
    }

    expect(result.messages[0].createdAt).toBe(date.getTime())
    expect(result.messages[1].createdAt).toBe(Date.parse('2026-06-05T10:05:00.000Z'))
    // No usable timestamp → left untouched (renderer falls back to 0, not now).
    expect(result.messages[2].createdAt).toBeUndefined()
  })

  it('registers agent:turn-steer and forwards the payload to manager.steer', async () => {
    const handler = get('agent:turn-steer')
    expect(handler).toBeTypeOf('function')
    const payload = { threadId: 't1', content: 'actually, focus on the failing test', attachments: [] }
    const result = await handler!({}, payload)
    expect(manager.steer).toHaveBeenCalledWith(payload)
    expect(result).toEqual({ threadId: 't1' })
  })

  it.each([
    ['agent:send-message', 'sendMessage'],
    ['agent:turn-steer', 'steer'],
  ] as const)(
    '%s accepts concrete Max reasoning effort',
    async (channel, managerMethod) => {
      const payload = {
        threadId: 't1',
        content: 'use maximum ordinary reasoning',
        attachments: [],
        reasoningEffort: 'max',
      }

      await get(channel)!({}, payload)

      expect(manager[managerMethod]).toHaveBeenCalledWith(payload)
    },
  )

  it.each([
    ['agent:send-message', 'sendMessage', 'auto'],
    ['agent:send-message', 'sendMessage', 'ultra'],
    ['agent:send-message', 'sendMessage', 'future-level'],
    ['agent:send-message', 'sendMessage', 1],
    ['agent:turn-steer', 'steer', 'auto'],
    ['agent:turn-steer', 'steer', 'ultra'],
    ['agent:turn-steer', 'steer', 'future-level'],
    ['agent:turn-steer', 'steer', null],
  ] as const)(
    '%s rejects invalid ordinary reasoning effort %j',
    async (channel, managerMethod, reasoningEffort) => {
      const payload = {
        threadId: 't1',
        content: 'do not forward',
        attachments: [],
        reasoningEffort,
      }

      await expect(get(channel)!({}, payload)).rejects.toThrow(/reasoningEffort.*concrete/i)
      expect(manager[managerMethod]).not.toHaveBeenCalled()
    },
  )

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
      () => Promise.resolve(nextManager as unknown as Awaited<ReturnType<Parameters<typeof registerAgentIpc>[0]>>),
      () => router as unknown as ReturnType<Parameters<typeof registerAgentIpc>[1]>,
    )

    expect(get('agent:open-thread')).toBeTypeOf('function')
    // Handlers registered AFTER the cleanup block must also be idempotent — the
    // canvas edit-queue handler used to throw "second handler" on dev reload
    // because it was missing from the cleanup list.
    expect(get('canvas:edit-queue-status')).toBeTypeOf('function')
    // `ipcMain.on` listeners must be torn down on re-register too, or each dev
    // reload stacks another listener (double tool-response / double enqueue).
    expect(listenerCount('agent:tool-response')).toBe(1)
    expect(listenerCount('image:task-update')).toBe(1)
    expect(listenerCount('canvas:submit-edit-request')).toBe(1)
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

  it('agent:get-providers wraps the snapshot with ok:true', async () => {
    const handler = get('agent:get-providers')
    expect(handler).toBeTypeOf('function')
    const result = (await handler!({})) as { ok: boolean; activeId?: string }
    expect(manager.getProvidersSnapshot).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    expect(result.activeId).toBe('apiyi')
  })

  it('agent:set-active-provider validates id and forwards through', async () => {
    const handler = get('agent:set-active-provider')
    expect(handler).toBeTypeOf('function')
    const result = (await handler!({}, 'rightcode')) as {
      ok: boolean
      activeId?: string
      providerGeneration?: number
    }
    expect(manager.setActiveProvider).toHaveBeenCalledWith('rightcode')
    expect(result).toEqual({ ok: true, activeId: 'rightcode', providerGeneration: 2 })

    const bad = (await handler!({}, '')) as { ok: boolean; error?: string }
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/non-empty/)
  })

  it('agent:set-provider-api-key forwards id and key', async () => {
    const handler = get('agent:set-provider-api-key')
    expect(handler).toBeTypeOf('function')
    const result = (await handler!({}, 'apiyi', 'sk-x')) as {
      ok: boolean
      activeId?: string
      providerGeneration?: number
    }
    expect(manager.setProviderApiKey).toHaveBeenCalledWith('apiyi', 'sk-x')
    expect(result).toEqual({ ok: true, activeId: 'apiyi', providerGeneration: 3 })

    // Non-string key gets coerced to '' so we never crash on undefined.
    await handler!({}, 'apiyi', undefined)
    expect(manager.setProviderApiKey).toHaveBeenLastCalledWith('apiyi', '')
  })

  it('agent:add-custom-provider validates required fields', async () => {
    const handler = get('agent:add-custom-provider')
    expect(handler).toBeTypeOf('function')

    const ok = (await handler!({}, {
      name: 'My Gateway',
      baseUrl: 'https://gw.example.com/v1',
    })) as { ok: boolean; provider?: unknown }
    expect(ok.ok).toBe(true)
    expect(manager.addCustomProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My Gateway',
        baseUrl: 'https://gw.example.com/v1',
        envKey: 'OPENAI_API_KEY',
      }),
    )

    const bad1 = (await handler!({}, { name: '', baseUrl: 'https://x' })) as { ok: boolean; error?: string }
    expect(bad1.ok).toBe(false)
    expect(bad1.error).toMatch(/name/i)

    const bad2 = (await handler!({}, { name: 'a', baseUrl: '' })) as { ok: boolean; error?: string }
    expect(bad2.ok).toBe(false)
    expect(bad2.error).toMatch(/baseUrl/i)
  })

  it('agent:add-custom-provider rejects non-scalar extraTopLevelConfig values', async () => {
    const handler = get('agent:add-custom-provider')!
    const result = (await handler({}, {
      name: 'X',
      baseUrl: 'https://x',
      extraTopLevelConfig: { evil: { nested: true } },
    })) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/extraTopLevelConfig/)
  })

  it('agent:update-custom-provider forwards id + sanitized patch', async () => {
    const handler = get('agent:update-custom-provider')
    expect(handler).toBeTypeOf('function')
    const result = await handler!({}, 'custom-1', { name: '  Renamed  ', model: 'gpt-5.5' })
    expect(manager.updateCustomProvider).toHaveBeenCalledWith('custom-1', {
      name: 'Renamed',
      model: 'gpt-5.5',
    })
    expect(result).toEqual({
      ok: true,
      activeId: 'custom-1',
      providerGeneration: 4,
    })

    const bad = (await handler!({}, '', { name: 'x' })) as { ok: boolean; error?: string }
    expect(bad.ok).toBe(false)
  })

  it('agent:remove-custom-provider forwards id and surfaces new active id', async () => {
    const handler = get('agent:remove-custom-provider')
    expect(handler).toBeTypeOf('function')
    const result = (await handler!({}, 'custom-1')) as {
      ok: boolean
      activeId?: string
      providerGeneration?: number
    }
    expect(manager.removeCustomProvider).toHaveBeenCalledWith('custom-1')
    expect(result).toEqual({ ok: true, activeId: 'apiyi', providerGeneration: 5 })
  })
})
