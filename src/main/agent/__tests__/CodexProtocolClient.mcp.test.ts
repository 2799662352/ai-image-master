import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

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
      if (respondTo) {
        const result = respondTo(msg)
        ws.send(JSON.stringify({ id: msg.id, result }))
      }
    })
  })

  return {
    wss,
    messages,
    setResponder(fn: (msg: any) => any) { respondTo = fn },
    close() { wss.close() },
  }
}

describe('CodexProtocolClient MCP methods', () => {
  const PORT = 17399
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

  it('listMcpServers sends mcpServerStatus/list with detail:full and parses {data,nextCursor}', async () => {
    server.setResponder((msg: any) => {
      if (msg.method === 'mcpServerStatus/list') {
        // Pinned by openai/codex/codex-rs/app-server-protocol/schema/typescript/v2/
        // ListMcpServerStatusResponse.ts -- list lives under `data` (camelCase fields)
        return {
          data: [
            { name: 'test-server', tools: {}, resources: [], resourceTemplates: [], authStatus: 'unsupported' },
          ],
          nextCursor: null,
        }
      }
      return {}
    })
    const result = await client.listMcpServers()
    expect(result.data).toHaveLength(1)
    expect(result.data[0].name).toBe('test-server')
    expect(result.data[0].authStatus).toBe('unsupported')
    expect(result.nextCursor).toBeNull()
    const sent = server.messages.find((m: any) => m.method === 'mcpServerStatus/list') as any
    expect(sent.params.detail).toBe('full')
  })

  it('batchWriteConfig sends config/batchWrite with edits', async () => {
    server.setResponder(() => ({}))
    await client.batchWriteConfig([{ keyPath: 'mcp_servers.foo', value: { command: 'bar' } }])
    const sent = server.messages.find((m: any) => m.method === 'config/batchWrite') as any
    expect(sent.params.edits).toHaveLength(1)
    expect(sent.params.edits[0].keyPath).toBe('mcp_servers.foo')
    expect(sent.params.reloadUserConfig).toBe(true)
  })

  it('writeConfigValue sends config/value/write', async () => {
    server.setResponder(() => ({}))
    await client.writeConfigValue('mcp_servers.foo.enabled', false)
    const sent = server.messages.find((m: any) => m.method === 'config/value/write') as any
    expect(sent.params.keyPath).toBe('mcp_servers.foo.enabled')
    expect(sent.params.value).toBe(false)
  })

  it('reloadMcpServers sends config/mcpServer/reload', async () => {
    server.setResponder(() => ({}))
    await client.reloadMcpServers()
    const sent = server.messages.find((m: any) => m.method === 'config/mcpServer/reload')
    expect(sent).toBeTruthy()
  })

  it('mcpOAuthLogin sends mcpServer/oauth/login and returns url', async () => {
    server.setResponder((msg: any) => {
      if (msg.method === 'mcpServer/oauth/login') {
        return { authorization_url: 'https://auth.example.com/login' }
      }
      return {}
    })
    const result = await client.mcpOAuthLogin('my-server')
    expect(result.authorization_url).toBe('https://auth.example.com/login')
  })
})
