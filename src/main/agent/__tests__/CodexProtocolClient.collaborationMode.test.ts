import { afterEach, describe, expect, it, vi } from 'vitest'
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
  sendNotification: (method: string, params: Record<string, unknown>) => void
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
      } else if (msg.method === 'thread/settings/update') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
      } else if (msg.method === 'turn/start') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    receivedFromClient: received,
    sendNotification(method, params) {
      activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    },
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

  it('updateThreadSettings sends thread/settings/update with camelCase params', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
    })
    await client.start()

    const collaborationMode = {
      mode: 'default' as const,
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    }
    const result = await client.updateThreadSettings({
      threadId: 'thread-1',
      collaborationMode,
    })

    const request = server.receivedFromClient.find((m) => m.method === 'thread/settings/update')
    expect(request?.method).toBe('thread/settings/update')
    expect(request?.params).toEqual({
      threadId: 'thread-1',
      collaborationMode,
    })
    expect(result).toEqual({})
  })

  it('dispatches thread/settings/updated through the dedicated callback without entering the turn queue', async () => {
    server = await startFakeCodexServer()
    const onThreadSettingsNotification = vi.fn()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      experimentalApi: true,
      onThreadSettingsNotification,
    })
    await client.start()

    const input = { items: [{ type: 'text', text: 'hi' }] } as unknown as AgentInput
    const iterator = client.send('codex-thread-1', input)[Symbol.asyncIterator]()
    const nextEvent = iterator.next()
    await waitUntil(() => client!.hasActiveTurns())

    server.sendNotification('thread/settings/updated', {
      threadId: 'codex-thread-1',
      threadSettings: {
        model: 'gpt-5.5',
        effort: 'high',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'gpt-5.5',
            reasoning_effort: 'high',
            developer_instructions: null,
          },
        },
      },
    })
    await waitUntil(() => onThreadSettingsNotification.mock.calls.length === 1)

    expect(onThreadSettingsNotification).toHaveBeenCalledWith({
      type: 'thread_settings_updated',
      threadId: 'codex-thread-1',
      mode: 'default',
      model: 'gpt-5.5',
      effort: 'high',
    })
    await expect(
      Promise.race([
        nextEvent.then(() => 'queue-event'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
      ]),
    ).resolves.toBe('pending')

    server.sendNotification('turn/completed', {
      threadId: 'codex-thread-1',
      turn: { id: 'turn-1' },
    })
    await expect(nextEvent).resolves.toMatchObject({
      value: { type: 'turn_completed', threadId: 'codex-thread-1', turnId: 'turn-1' },
      done: false,
    })
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
    // Fake server never emits turn/completed, so this pending next() gets
    // rejected by afterEach's client.stop() — swallow it or Vitest records an
    // unhandled rejection and fails the whole run (flaky by timing).
    iterator.next().catch(() => {})
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
    // Same unhandled-rejection guard as the test above.
    iterator.next().catch(() => {})
    await waitUntil(() => server!.receivedFromClient.some((m) => m.method === 'turn/start'))

    const turnStart = server.receivedFromClient.find((m) => m.method === 'turn/start')
    expect('collaborationMode' in turnStart!.params).toBe(false)
  })
})
