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

interface FakeManager {
  listMcp: ReturnType<typeof vi.fn>
  getMcpDetail: ReturnType<typeof vi.fn>
  saveMcp: ReturnType<typeof vi.fn>
  deleteMcp: ReturnType<typeof vi.fn>
  setMcpEnabled: ReturnType<typeof vi.fn>
  listSkills: ReturnType<typeof vi.fn>
  getSkillDetail: ReturnType<typeof vi.fn>
  saveSkill: ReturnType<typeof vi.fn>
  deleteSkill: ReturnType<typeof vi.fn>
  getWorkspaceLogs: ReturnType<typeof vi.fn>
  restartCodex: ReturnType<typeof vi.fn>
}

function makeManager(): FakeManager {
  return {
    listMcp: vi.fn().mockResolvedValue([]),
    getMcpDetail: vi.fn().mockResolvedValue({ id: 'mcp-1' }),
    saveMcp: vi.fn().mockResolvedValue({ ok: true, id: 'mcp-1' }),
    deleteMcp: vi.fn().mockResolvedValue({ ok: true }),
    setMcpEnabled: vi.fn().mockResolvedValue({ ok: true }),
    listSkills: vi.fn().mockResolvedValue([]),
    getSkillDetail: vi.fn().mockResolvedValue({ id: 'skill-1' }),
    saveSkill: vi.fn().mockResolvedValue({ ok: true, id: 'skill-1' }),
    deleteSkill: vi.fn().mockResolvedValue({ ok: true }),
    getWorkspaceLogs: vi.fn().mockResolvedValue([]),
    restartCodex: vi.fn().mockResolvedValue({ ok: true }),
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

  it('registers MCP, skill, log, and restart channels', () => {
    expect(channels()).toEqual(expect.arrayContaining([
      'agent:list-mcp',
      'agent:get-mcp-detail',
      'agent:save-mcp',
      'agent:delete-mcp',
      'agent:set-mcp-enabled',
      'agent:list-skills',
      'agent:get-skill-detail',
      'agent:save-skill',
      'agent:delete-skill',
      'agent:get-workspace-logs',
      'agent:restart-codex',
    ]))
  })

  it('forwards agent:save-mcp input and returns the manager result', async () => {
    const handler = get('agent:save-mcp')
    const input = { id: 'mcp-1', command: 'npx', args: ['example-server'] }
    const result = { ok: true, id: 'mcp-1' }
    manager.saveMcp.mockResolvedValueOnce(result)

    await expect(handler!({}, input)).resolves.toBe(result)

    expect(manager.saveMcp).toHaveBeenCalledWith(input)
  })

  it('validates and forwards agent:set-mcp-enabled payloads', async () => {
    const handler = get('agent:set-mcp-enabled')

    await expect(handler!({}, { id: 'mcp-1', enabled: false })).resolves.toEqual({ ok: true })
    await expect(handler!({}, { id: '', enabled: false })).resolves.toEqual({
      ok: false,
      error: 'MCP server id must be a non-empty string',
    })
    await expect(handler!({}, { id: 'mcp-1', enabled: 'false' })).resolves.toEqual({
      ok: false,
      error: 'MCP enabled state must be a boolean',
    })

    expect(manager.setMcpEnabled).toHaveBeenCalledTimes(1)
    expect(manager.setMcpEnabled).toHaveBeenCalledWith('mcp-1', false)
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

    expect(get('agent:save-mcp')).toBeTypeOf('function')
    expect(removedHandlers()).toContain('agent:save-mcp')
  })
})
