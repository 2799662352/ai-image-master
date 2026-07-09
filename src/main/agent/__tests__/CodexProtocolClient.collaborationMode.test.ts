import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentInput } from '../types'

/**
 * collaborationMode (EXPERIMENTAL, app-server v2):
 *
 *   initialize:              { clientInfo, capabilities: { experimentalApi: true } }
 *   collaborationMode/list:  {}  →  { data: CollaborationModeMask[] }
 *   turn/start:              { ..., collaborationMode?: { mode, settings } }
 *
 * The RPC and the turn/start field are gated behind the `experimentalApi`
 * capability (`#[experimental("collaborationMode/list")]` /
 * `#[experimental("turn/start.collaborationMode")]` in common.rs / v2/turn.rs).
 * Default behaviour must stay byte-identical: capabilities stays `null` and
 * turn/start omits the field unless explicitly requested (older binaries
 * reject unknown/null fields).
 */

interface FakeCodexServer {
  url: string
  receivedFromClient: any[]
  close: () => Promise<void>
}

async function startFakeCodexServer(): Promise<FakeCodexServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  const received: any[] = []
  let activeSocket: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      received.push(msg)
      if (msg.id === undefined) return
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      } else if (msg.method === 'collaborationMode/list') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            data: [
              { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null },
              { name: 'Code', mode: 'default', model: null, reasoning_effort: null },
            ],
          },
        }))
      } else if (msg.method === 'turn/start') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    receivedFromClient: received,
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('CodexProtocolClient collaborationMode', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('initialize keeps capabilities null by default (behaviour unchanged)', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    const init = server.receivedFromClient.find((m) => m.method === 'initialize')
    expect(init?.params.capabilities).toBeNull()
  })

  it('initialize sends capabilities.experimentalApi when the option is set', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    const init = server.receivedFromClient.find((m) => m.method === 'initialize')
    expect(init?.params.capabilities).toEqual({ experimentalApi: true })
  })

  it('listCollaborationModes sends collaborationMode/list and parses presets', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    const result = await client.listCollaborationModes()
    expect(server.receivedFromClient.some((m) => m.method === 'collaborationMode/list')).toBe(true)
    expect(result.data.map((m) => m.name)).toEqual(['Plan', 'Code'])
    expect(result.data[0].mode).toBe('plan')
  })

  it('turn/start carries collaborationMode when the input provides one', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    const collaborationMode = {
      mode: 'plan' as const,
      settings: { model: 'gpt-5.2-codex', reasoning_effort: null, developer_instructions: null },
    }
    const input = { items: [{ type: 'text', text: 'hi' }], collaborationMode } as unknown as AgentInput
    const iterator = client.send('thread-A', input)[Symbol.asyncIterator]()
    void iterator.next()
    await waitUntil(() => server!.receivedFromClient.some((m) => m.method === 'turn/start'))

    const turnStart = server.receivedFromClient.find((m) => m.method === 'turn/start')
    expect(turnStart?.params.collaborationMode).toEqual(collaborationMode)
  })

  it('turn/start omits collaborationMode entirely when not requested', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    const input = { items: [{ type: 'text', text: 'hi' }] } as unknown as AgentInput
    const iterator = client.send('thread-B', input)[Symbol.asyncIterator]()
    void iterator.next()
    await waitUntil(() => server!.receivedFromClient.some((m) => m.method === 'turn/start'))

    const turnStart = server.receivedFromClient.find((m) => m.method === 'turn/start')
    expect('collaborationMode' in turnStart!.params).toBe(false)
  })
})
