/**
 * P1: AgentManager `*Rpc` envelopes for the Codex native plugin / marketplace /
 * apps / external-agent-import surface (app-server v2, ≥0.140). Each wraps the
 * backend passthrough in the standard `{ ok, error?, data? }` shape and surfaces
 * a clean error when the backend doesn't implement the method (e.g. a non-Codex
 * backend or a backend that hasn't started).
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-plugins-'))
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
    listPlugins: vi.fn().mockResolvedValue({ marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }),
    listInstalledPlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    readPlugin: vi.fn().mockResolvedValue({ plugin: { id: 'p1' } }),
    installPlugin: vi.fn().mockResolvedValue({ authPolicy: 'ON_USE', appsNeedingAuth: [] }),
    uninstallPlugin: vi.fn().mockResolvedValue(undefined),
    addMarketplace: vi.fn().mockResolvedValue({ marketplace: { name: 'm1' } }),
    removeMarketplace: vi.fn().mockResolvedValue({ removed: true }),
    upgradeMarketplaces: vi.fn().mockResolvedValue({ upgraded: [], errors: [] }),
    listApps: vi.fn().mockResolvedValue({ apps: [], nextCursor: null }),
    detectExternalAgentConfig: vi.fn().mockResolvedValue({ migrationItems: [] }),
    importExternalAgentConfig: vi.fn().mockResolvedValue({ imported: [] }),
    ...overrides,
  }
}

function makeManager(backend: ReturnType<typeof fakeBackend>) {
  return new AgentManager({ userDataDir: tmpDir, backend: backend as any })
}

describe('AgentManager plugin/connector Rpc envelopes', () => {
  it('listPluginsRpc delegates and wraps data', async () => {
    const backend = fakeBackend()
    const mgr = makeManager(backend)
    const res = await mgr.listPluginsRpc({ marketplaceKinds: ['local'] })
    expect(backend.listPlugins).toHaveBeenCalledWith({ marketplaceKinds: ['local'] })
    expect(res).toEqual({ ok: true, data: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] } })
  })

  it('listInstalledPluginsRpc delegates', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).listInstalledPluginsRpc()
    expect(backend.listInstalledPlugins).toHaveBeenCalledOnce()
    expect(res).toEqual({ ok: true, data: { plugins: [] } })
  })

  it('readPluginRpc forwards params', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).readPluginRpc({ pluginId: 'p1' } as any)
    expect(backend.readPlugin).toHaveBeenCalledWith({ pluginId: 'p1' })
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ plugin: { id: 'p1' } })
  })

  it('installPluginRpc forwards params', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).installPluginRpc({ marketplaceName: 'm', pluginName: 'p' } as any)
    expect(backend.installPlugin).toHaveBeenCalledWith({ marketplaceName: 'm', pluginName: 'p' })
    expect(res.ok).toBe(true)
  })

  it('uninstallPluginRpc forwards the plugin id', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).uninstallPluginRpc('inst-1')
    expect(backend.uninstallPlugin).toHaveBeenCalledWith('inst-1')
    expect(res).toEqual({ ok: true })
  })

  it('addMarketplaceRpc forwards params', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).addMarketplaceRpc({ source: { type: 'git', url: 'https://x' } } as any)
    expect(backend.addMarketplace).toHaveBeenCalledWith({ source: { type: 'git', url: 'https://x' } })
    expect(res.ok).toBe(true)
  })

  it('removeMarketplaceRpc forwards the name', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).removeMarketplaceRpc('curated')
    expect(backend.removeMarketplace).toHaveBeenCalledWith('curated')
    expect(res.ok).toBe(true)
  })

  it('upgradeMarketplacesRpc forwards optional name', async () => {
    const backend = fakeBackend()
    await makeManager(backend).upgradeMarketplacesRpc('curated')
    expect(backend.upgradeMarketplaces).toHaveBeenCalledWith('curated')
    await makeManager(backend).upgradeMarketplacesRpc()
    expect(backend.upgradeMarketplaces).toHaveBeenLastCalledWith(undefined)
  })

  it('listAppsRpc delegates', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).listAppsRpc({ cursor: 'c1' } as any)
    expect(backend.listApps).toHaveBeenCalledWith({ cursor: 'c1' })
    expect(res.ok).toBe(true)
  })

  it('detectExternalAgentConfigRpc delegates', async () => {
    const backend = fakeBackend()
    const res = await makeManager(backend).detectExternalAgentConfigRpc()
    expect(backend.detectExternalAgentConfig).toHaveBeenCalledOnce()
    expect(res.ok).toBe(true)
  })

  it('importExternalAgentConfigRpc forwards migration items', async () => {
    const backend = fakeBackend()
    const items = [{ kind: 'mcp', name: 'ctx7' }] as any
    const res = await makeManager(backend).importExternalAgentConfigRpc(items)
    expect(backend.importExternalAgentConfig).toHaveBeenCalledWith(items)
    expect(res.ok).toBe(true)
  })

  it('returns ok:false when the backend lacks the method', async () => {
    const backend = fakeBackend({ listPlugins: undefined })
    const res = await makeManager(backend).listPluginsRpc()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unavailable/i)
  })

  it('returns ok:false with the message when the backend throws', async () => {
    const backend = fakeBackend({ installPlugin: vi.fn().mockRejectedValue(new Error('boom')) })
    const res = await makeManager(backend).installPluginRpc({} as any)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })
})
