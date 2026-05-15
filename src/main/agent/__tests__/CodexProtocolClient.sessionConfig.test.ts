import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentInput } from '../types'

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
      if (msg.method === 'initialize' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      } else if (msg.method === 'thread/start' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { thread: { id: 'fake-thread', preview: '', cwd: 'D:/repo' } },
        }))
      } else if (msg.method === 'turn/start' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { turn: { id: 'fake-turn', status: 'running' } },
        }))
        setImmediate(() => {
          activeSocket?.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: 'fake-thread', turn: { id: 'fake-turn', status: 'completed' } },
          }))
        })
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

const input: AgentInput = {
  threadId: undefined,
  content: 'hi',
  attachments: [],
  model: 'gpt-5.5',
  cwd: 'D:/repo',
  items: [{ type: 'text', text: 'hi' }],
}

describe('CodexProtocolClient session config', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('passes safe session config through thread/start params', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'catimation-test', version: '0.0.0' },
      sessionConfig: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        webSearch: 'cached',
        writableRoots: ['D:/repo'],
      },
    })
    await client.start()

    for await (const _event of client.send(undefined, input)) {
      // Drain the turn so all JSON-RPC requests are written to the fake server.
    }

    const threadStart = server.receivedFromClient.find((msg) => msg.method === 'thread/start')
    expect(threadStart?.params).toEqual({
      cwd: 'D:/repo',
      model: 'gpt-5.5',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      config: {
        web_search: 'cached',
        sandbox_workspace_write: {
          writable_roots: ['D:/repo'],
        },
      },
    })
    expect(JSON.stringify(threadStart?.params)).not.toContain('danger-full-access')
    expect(JSON.stringify(threadStart?.params)).not.toContain('"never"')
  })
})
