/**
 * agent IPC channels for the Codex cross-session memory surface. Mirrors the
 * harness in ipc.compact.test.ts — a fake `ipcMain` records handlers so we can
 * assert the memory channels register and forward to the AgentManager Rpc
 * wrappers.
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
    setThreadMemoryModeRpc: vi.fn().mockResolvedValue({ ok: true }),
    resetMemoryRpc: vi.fn().mockResolvedValue({ ok: true }),
  }
}

const router = { handleRendererResponse: vi.fn() }
const get = (channel: string) =>
  (ipcMain as unknown as { __getHandler: (c: string) => ((...a: unknown[]) => unknown) | undefined }).__getHandler(channel)

describe('registerAgentIpc memory handlers', () => {
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

  it('agent:memory-mode-set forwards threadId + mode', async () => {
    const h = get('agent:memory-mode-set')
    expect(h).toBeTypeOf('function')
    await h!({}, 'db-1', 'disabled')
    expect(manager.setThreadMemoryModeRpc).toHaveBeenCalledWith('db-1', 'disabled')
  })

  it('agent:memory-reset forwards with no arguments', async () => {
    const h = get('agent:memory-reset')
    expect(h).toBeTypeOf('function')
    await h!({})
    expect(manager.resetMemoryRpc).toHaveBeenCalledWith()
  })
})
