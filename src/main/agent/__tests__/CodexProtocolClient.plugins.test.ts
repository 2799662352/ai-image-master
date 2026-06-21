import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

// Drives the new Codex app-server v2 plugin/marketplace/apps/import RPCs against
// a fake WebSocketServer (same harness style as CodexProtocolClient.mcp.test.ts)
// so we assert the exact wire method strings + params without spawning the real
// Rust binary. Method strings are pinned from openai/codex
// `app-server-protocol/src/protocol/common.rs` (client_request_definitions!) at
// tag rust-v0.141.0.
function createTestServer(port: number) {
  const wss = new WebSocketServer({ port })
  const messages: unknown[] = []
  let respondTo: ((msg: any) => any) | null = null

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      messages.push(msg)
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
        return
      }
      if (respondTo && msg.id !== undefined) {
        const result = respondTo(msg)
        ws.send(JSON.stringify({ id: msg.id, result }))
      }
    })
  })

  return {
    wss,
    messages,
    setResponder(fn: (msg: any) => any) { respondTo = fn },
    sent(method: string) { return messages.find((m: any) => m.method === method) as any },
    close() { wss.close() },
  }
}

describe('CodexProtocolClient plugin/connector methods', () => {
  const PORT = 17402
  let server: ReturnType<typeof createTestServer>
  let client: CodexProtocolClient

  beforeEach(async () => {
    server = createTestServer(PORT)
    client = new CodexProtocolClient({
      url: `ws://127.0.0.1:${PORT}`,
      clientInfo: { name: 'test', version: '0.0.1' },
      connectTimeoutMs: 3000,
      connectIntervalMs: 50,
    })
    await client.start()
  })

  afterEach(async () => {
    await client.stop()
    server.close()
  })

  // ─── Plugins ────────────────────────────────────────────────────────────

  it('listPlugins sends plugin/list and parses marketplaces', async () => {
    server.setResponder(() => ({
      marketplaces: [{ name: 'curated', path: null, interface: null, plugins: [] }],
      marketplaceLoadErrors: [],
      featuredPluginIds: ['foo'],
    }))
    const result = await client.listPlugins()
    expect(server.sent('plugin/list')).toBeTruthy()
    expect(result.marketplaces).toHaveLength(1)
    expect(result.marketplaces[0].name).toBe('curated')
    expect(result.featuredPluginIds).toEqual(['foo'])
  })

  it('listPlugins forwards marketplaceKinds filter', async () => {
    server.setResponder(() => ({ marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }))
    await client.listPlugins({ marketplaceKinds: ['vertical', 'created-by-me-remote'] })
    const sent = server.sent('plugin/list')
    expect(sent.params.marketplaceKinds).toEqual(['vertical', 'created-by-me-remote'])
  })

  it('listInstalledPlugins sends plugin/installed', async () => {
    server.setResponder(() => ({ marketplaces: [], marketplaceLoadErrors: [] }))
    const result = await client.listInstalledPlugins()
    expect(server.sent('plugin/installed')).toBeTruthy()
    expect(result.marketplaces).toEqual([])
  })

  it('readPlugin sends plugin/read with pluginName', async () => {
    server.setResponder(() => ({ plugin: { summary: { id: 'p1', name: 'P1' } } }))
    const result = await client.readPlugin({ pluginName: 'P1' })
    const sent = server.sent('plugin/read')
    expect(sent.params.pluginName).toBe('P1')
    expect(result.plugin.summary.id).toBe('p1')
  })

  it('installPlugin sends plugin/install and returns authPolicy', async () => {
    server.setResponder(() => ({ authPolicy: 'ON_USE', appsNeedingAuth: [] }))
    const result = await client.installPlugin({ pluginName: 'P1', remoteMarketplaceName: 'curated' })
    const sent = server.sent('plugin/install')
    expect(sent.params.pluginName).toBe('P1')
    expect(sent.params.remoteMarketplaceName).toBe('curated')
    expect(result.authPolicy).toBe('ON_USE')
  })

  it('uninstallPlugin sends plugin/uninstall with pluginId', async () => {
    server.setResponder(() => ({}))
    await client.uninstallPlugin('p1')
    const sent = server.sent('plugin/uninstall')
    expect(sent.params.pluginId).toBe('p1')
  })

  // ─── Marketplace sources ──────────────────────────────────────────────────

  it('addMarketplace sends marketplace/add with source', async () => {
    server.setResponder(() => ({ marketplaceName: 'mine', installedRoot: '/root', alreadyAdded: false }))
    const result = await client.addMarketplace({ source: 'https://github.com/me/catalog' })
    const sent = server.sent('marketplace/add')
    expect(sent.params.source).toBe('https://github.com/me/catalog')
    expect(result.marketplaceName).toBe('mine')
  })

  it('removeMarketplace sends marketplace/remove with name', async () => {
    server.setResponder(() => ({ marketplaceName: 'mine', installedRoot: null }))
    await client.removeMarketplace('mine')
    const sent = server.sent('marketplace/remove')
    expect(sent.params.marketplaceName).toBe('mine')
  })

  it('upgradeMarketplaces sends marketplace/upgrade (all when no name)', async () => {
    server.setResponder(() => ({ selectedMarketplaces: ['mine'], upgradedRoots: ['/root'], errors: [] }))
    const result = await client.upgradeMarketplaces()
    expect(server.sent('marketplace/upgrade')).toBeTruthy()
    expect(result.selectedMarketplaces).toEqual(['mine'])
  })

  // ─── Apps / connectors ────────────────────────────────────────────────────

  it('listApps sends apps/list and parses {data,nextCursor}', async () => {
    server.setResponder(() => ({ data: [{ id: 'a1', name: 'App1' }], nextCursor: null }))
    const result = await client.listApps()
    expect(server.sent('apps/list')).toBeTruthy()
    expect(result.data).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
  })

  // ─── External agent config import ─────────────────────────────────────────

  it('detectExternalAgentConfig sends externalAgentConfig/detect', async () => {
    server.setResponder(() => ({ items: [] }))
    await client.detectExternalAgentConfig({ includeHome: true })
    const sent = server.sent('externalAgentConfig/detect')
    expect(sent.params.includeHome).toBe(true)
  })

  it('importExternalAgentConfig sends externalAgentConfig/import with migrationItems', async () => {
    server.setResponder(() => ({ importId: 'imp-1' }))
    const result = await client.importExternalAgentConfig([{ kind: 'claude' } as any])
    const sent = server.sent('externalAgentConfig/import')
    expect(sent.params.migrationItems).toHaveLength(1)
    expect(result.importId).toBe('imp-1')
  })

  // ─── Thread permanent delete ──────────────────────────────────────────────

  it('deleteThread sends thread/delete with threadId', async () => {
    server.setResponder(() => ({}))
    await client.deleteThread('th-1')
    const sent = server.sent('thread/delete')
    expect(sent.params.threadId).toBe('th-1')
  })
})
