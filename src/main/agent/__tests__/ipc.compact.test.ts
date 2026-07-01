/**
 * agent IPC channel for the Codex native `/compact` surface. Mirrors the harness
 * in ipc.goals.test.ts — a fake `ipcMain` records handlers so we can assert the
 * compact channel registers and forwards to AgentManager.compactThreadRpc.
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
    compactThreadRpc: vi.fn().mockResolvedValue({ ok: true, data: { started: true } }),
  }
}

const router = { handleRendererResponse: vi.fn() }
const get = (channel: string) =>
  (ipcMain as unknown as { __getHandler: (c: string) => ((...a: unknown[]) => unknown) | undefined }).__getHandler(channel)

describe('registerAgentIpc compact handler', () => {
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

  it('agent:compact-start forwards the threadId', async () => {
    const h = get('agent:compact-start')
    expect(h).toBeTypeOf('function')
    await h!({}, 'db-1')
    expect(manager.compactThreadRpc).toHaveBeenCalledWith('db-1')
  })
})
