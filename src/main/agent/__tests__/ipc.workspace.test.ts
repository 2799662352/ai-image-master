import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, Set<unknown>>()
  const removedHandlers: string[] = []
  return {
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => {
        removedHandlers.push(channel)
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
      __channels: () => [...handlers.keys()],
      __getHandler: (channel: string) => handlers.get(channel),
      __removedHandlers: () => [...removedHandlers],
      __reset: () => {
        handlers.clear()
        listeners.clear()
        removedHandlers.length = 0
      },
    },
  }
})

import { ipcMain } from 'electron'
import { registerAgentIpc } from '../ipc'

const WORKSPACE_CHANNELS = [
  'agent:list-skills',
  'agent:get-skill-detail',
  'agent:save-skill',
  'agent:delete-skill',
  'agent:get-workspace-logs',
  'agent:restart-codex',
  'agent:mcp-status-snapshot',
]

interface FakeManager {
  listSkills: ReturnType<typeof vi.fn>
  getSkillDetail: ReturnType<typeof vi.fn>
  saveSkill: ReturnType<typeof vi.fn>
  deleteSkill: ReturnType<typeof vi.fn>
  getWorkspaceLogs: ReturnType<typeof vi.fn>
  restartCodex: ReturnType<typeof vi.fn>
  getMcpStatusSnapshotRpc: ReturnType<typeof vi.fn>
}

function makeManager(): FakeManager {
  return {
    listSkills: vi.fn().mockResolvedValue([]),
    getSkillDetail: vi.fn().mockResolvedValue({ id: 'skill-1' }),
    saveSkill: vi.fn().mockResolvedValue({ ok: true, id: 'skill-1' }),
    deleteSkill: vi.fn().mockResolvedValue({ ok: true }),
    getWorkspaceLogs: vi.fn().mockResolvedValue([]),
    restartCodex: vi.fn().mockResolvedValue(undefined),
    getMcpStatusSnapshotRpc: vi.fn().mockReturnValue({ ok: true, snapshot: {} }),
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

const channels = (): string[] => {
  return (ipcMain as unknown as { __channels: () => string[] }).__channels()
}

const removedHandlers = (): string[] => {
  return (ipcMain as unknown as { __removedHandlers: () => string[] }).__removedHandlers()
}

describe('agent IPC workspace handlers', () => {
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

  it('registers skill, log, and restart channels', () => {
    expect(channels()).toEqual(expect.arrayContaining(WORKSPACE_CHANNELS))
  })

  it('returns a success envelope when agent:restart-codex resolves', async () => {
    const handler = get('agent:restart-codex')

    await expect(handler!({})).resolves.toEqual({ ok: true })

    expect(manager.restartCodex).toHaveBeenCalledOnce()
  })

  it('returns an error envelope when agent:restart-codex throws', async () => {
    const handler = get('agent:restart-codex')
    manager.restartCodex.mockRejectedValueOnce(new Error('restart failed'))

    await expect(handler!({})).resolves.toEqual({ ok: false, error: 'restart failed' })
  })

  it('removes workspace handlers before re-registering after an Electron dev reload', () => {
    const nextManager = makeManager()

    registerAgentIpc(
      nextManager as unknown as Parameters<typeof registerAgentIpc>[0],
      router as unknown as Parameters<typeof registerAgentIpc>[1],
    )

    expect(get('agent:save-skill')).toBeTypeOf('function')
    expect(removedHandlers()).toEqual(expect.arrayContaining(WORKSPACE_CHANNELS))
  })
})
