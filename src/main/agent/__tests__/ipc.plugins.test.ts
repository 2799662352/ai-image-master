/**
 * P1: agent IPC channels for the Codex native plugin / marketplace / apps /
 * external-agent-import surface. Mirrors the harness in ipc.test.ts — a fake
 * `ipcMain` records handlers so we can assert each channel registers and
 * forwards to the matching AgentManager `*Rpc` method.
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
    listPluginsRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    listInstalledPluginsRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    readPluginRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    installPluginRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    uninstallPluginRpc: vi.fn().mockResolvedValue({ ok: true }),
    addMarketplaceRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    removeMarketplaceRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    upgradeMarketplacesRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    listAppsRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    detectExternalAgentConfigRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    importExternalAgentConfigRpc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  }
}

const router = { handleRendererResponse: vi.fn() }
const get = (channel: string) =>
  (ipcMain as unknown as { __getHandler: (c: string) => ((...a: unknown[]) => unknown) | undefined }).__getHandler(channel)

describe('registerAgentIpc plugin/connector handlers', () => {
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

  it('agent:plugin-list forwards params', async () => {
    const h = get('agent:plugin-list')
    expect(h).toBeTypeOf('function')
    await h!({}, { marketplaceKinds: ['local'] })
    expect(manager.listPluginsRpc).toHaveBeenCalledWith({ marketplaceKinds: ['local'] })
  })

  it('agent:plugin-installed forwards', async () => {
    await get('agent:plugin-installed')!({})
    expect(manager.listInstalledPluginsRpc).toHaveBeenCalled()
  })

  it('agent:plugin-read forwards params', async () => {
    await get('agent:plugin-read')!({}, { pluginId: 'p1' })
    expect(manager.readPluginRpc).toHaveBeenCalledWith({ pluginId: 'p1' })
  })

  it('agent:plugin-install forwards params', async () => {
    await get('agent:plugin-install')!({}, { marketplaceName: 'm', pluginName: 'p' })
    expect(manager.installPluginRpc).toHaveBeenCalledWith({ marketplaceName: 'm', pluginName: 'p' })
  })

  it('agent:plugin-uninstall forwards the id', async () => {
    await get('agent:plugin-uninstall')!({}, 'inst-1')
    expect(manager.uninstallPluginRpc).toHaveBeenCalledWith('inst-1')
  })

  it('agent:marketplace-add forwards params', async () => {
    await get('agent:marketplace-add')!({}, { source: { type: 'git', url: 'https://x' } })
    expect(manager.addMarketplaceRpc).toHaveBeenCalledWith({ source: { type: 'git', url: 'https://x' } })
  })

  it('agent:marketplace-remove forwards the name', async () => {
    await get('agent:marketplace-remove')!({}, 'curated')
    expect(manager.removeMarketplaceRpc).toHaveBeenCalledWith('curated')
  })

  it('agent:marketplace-upgrade forwards optional name', async () => {
    await get('agent:marketplace-upgrade')!({}, 'curated')
    expect(manager.upgradeMarketplacesRpc).toHaveBeenCalledWith('curated')
  })

  it('agent:apps-list forwards params', async () => {
    await get('agent:apps-list')!({}, { cursor: 'c1' })
    expect(manager.listAppsRpc).toHaveBeenCalledWith({ cursor: 'c1' })
  })

  it('agent:ext-agent-detect forwards', async () => {
    await get('agent:ext-agent-detect')!({})
    expect(manager.detectExternalAgentConfigRpc).toHaveBeenCalled()
  })

  it('agent:ext-agent-import forwards migration items', async () => {
    const items = [{ kind: 'mcp', name: 'ctx7' }]
    await get('agent:ext-agent-import')!({}, items)
    expect(manager.importExternalAgentConfigRpc).toHaveBeenCalledWith(items)
  })
})
