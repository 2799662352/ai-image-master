/**
 * agent IPC channels for the Codex native `/goal` surface. Mirrors the harness in
 * ipc.plugins.test.ts — a fake `ipcMain` records handlers so we can assert each
 * goal channel registers and forwards to the matching AgentManager `*Rpc` method.
 */

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
      removeHandler: (channel: string) => handlers.delete(channel),
      on: (channel: string, handler: unknown) => {
        const set = listeners.get(channel) ?? new Set<unknown>()
        set.add(handler)
        listeners.set(channel, set)
      },
      removeAllListeners: (channel: string) => listeners.delete(channel),
      __getHandler: (channel: string) => handlers.get(channel),
      __reset: () => {
        handlers.clear()
        listeners.clear()
      },
    },
  }
})

import { ipcMain } from 'electron'
import { registerAgentIpc } from '../ipc'

function makeManager() {
  return {
    setThreadGoalRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    getThreadGoalRpc: vi.fn().mockResolvedValue({ ok: true, data: null }),
    clearThreadGoalRpc: vi.fn().mockResolvedValue({ ok: true, data: { cleared: true } }),
  }
}

const router = { handleRendererResponse: vi.fn() }
const get = (channel: string) =>
  (ipcMain as unknown as { __getHandler: (c: string) => ((...a: unknown[]) => unknown) | undefined }).__getHandler(channel)

describe('registerAgentIpc goal handlers', () => {
  let manager: ReturnType<typeof makeManager>

  beforeEach(() => {
    ;(ipcMain as unknown as { __reset: () => void }).__reset()
    manager = makeManager()
    registerAgentIpc(
      () => Promise.resolve(manager as unknown as Awaited<ReturnType<Parameters<typeof registerAgentIpc>[0]>>),
      () => router as unknown as ReturnType<Parameters<typeof registerAgentIpc>[1]>,
    )
  })

  afterEach(() => vi.clearAllMocks())

  it('agent:goal-set forwards threadId + params', async () => {
    const h = get('agent:goal-set')
    expect(h).toBeTypeOf('function')
    await h!({}, 'db-1', { objective: 'ship it' })
    expect(manager.setThreadGoalRpc).toHaveBeenCalledWith('db-1', { objective: 'ship it' })
  })

  it('agent:goal-set defaults params to {} when omitted', async () => {
    await get('agent:goal-set')!({}, 'db-1', undefined)
    expect(manager.setThreadGoalRpc).toHaveBeenCalledWith('db-1', {})
  })

  it('agent:goal-get forwards the threadId', async () => {
    await get('agent:goal-get')!({}, 'db-1')
    expect(manager.getThreadGoalRpc).toHaveBeenCalledWith('db-1')
  })

  it('agent:goal-clear forwards the threadId', async () => {
    await get('agent:goal-clear')!({}, 'db-1')
    expect(manager.clearThreadGoalRpc).toHaveBeenCalledWith('db-1')
  })
})
