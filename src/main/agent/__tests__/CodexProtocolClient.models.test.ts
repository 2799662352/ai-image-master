import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentInput } from '../types'

interface FakeCodexServer {
  url: string
  received: Array<Record<string, unknown>>
  close: () => Promise<void>
}

async function startFakeCodexServer(): Promise<FakeCodexServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const port = (wss.address() as AddressInfo).port
  const received: Array<Record<string, unknown>> = []
  let activeSocket: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>
      received.push(message)
      if (message.id === undefined) return

      if (message.method === 'initialize') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      } else if (message.method === 'model/list') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            data: [{
              id: 'gpt-5.6-sol',
              model: 'gpt-5.6-sol',
              displayName: 'GPT-5.6-Sol',
              description: 'Latest frontier agentic coding model.',
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'low',
              inputModalities: ['text', 'image'],
              supportsPersonality: true,
              isDefault: true,
              upgrade: null,
            }],
            nextCursor: null,
          },
        }))
      } else if (message.method === 'turn/start') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { turn: { id: 'turn-1', status: 'inProgress' } },
        }))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    async close() {
      try {
        activeSocket?.close()
      } catch {
        // Best-effort test cleanup.
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('CodexProtocolClient model catalog and selection', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('calls model/list with official pagination and visibility params', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'test', version: '0' },
    })
    await client.start()

    const response = await client.listModels({ includeHidden: false, limit: 20 })

    expect(response.data[0].model).toBe('gpt-5.6-sol')
    expect(server.received.find((message) => message.method === 'model/list')).toMatchObject({
      params: { includeHidden: false, limit: 20 },
    })
  })

  it('sends the canonical model and native reasoning effort on every turn', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'test', version: '0' },
    })
    await client.start()

    const input = {
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      items: [{ type: 'text', text: 'hello' }],
    } as unknown as AgentInput
    const iterator = client.send('thread-existing', input)[Symbol.asyncIterator]()
    void iterator.next()
    await waitUntil(() => server!.received.some((message) => message.method === 'turn/start'))

    expect(server.received.find((message) => message.method === 'turn/start')).toMatchObject({
      params: {
        threadId: 'thread-existing',
        model: 'gpt-5.5',
        effort: 'xhigh',
      },
    })
  })
})
