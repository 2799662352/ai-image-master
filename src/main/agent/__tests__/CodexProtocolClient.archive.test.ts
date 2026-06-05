import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

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
      } else if (msg.method === 'thread/archive') {
        // Mirrors ThreadArchiveResponse = Record<string, never>
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
      } else if (msg.method === 'thread/unarchive') {
        // Mirrors ThreadUnarchiveResponse = { thread: Thread }
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            thread: {
              id: msg.params.threadId,
              preview: 'Restored Codex session',
              createdAt: '2026-06-01T00:00:00Z',
              updatedAt: '2026-06-01T00:05:00Z',
              cwd: 'D:/repo',
            },
          },
        }))
      } else if (msg.method === 'thread/list') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { threads: [] } }))
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

describe('CodexProtocolClient archive/unarchive', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  async function startClient(): Promise<void> {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'catimation-test', version: '0.0.0' },
    })
    await client.start()
  }

  it('archiveThread sends thread/archive with the thread id', async () => {
    await startClient()

    await client!.archiveThread('codex-thread-1')

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/archive')
    expect(request?.params).toEqual({ threadId: 'codex-thread-1' })
  })

  it('unarchiveThread sends thread/unarchive and normalizes the restored summary', async () => {
    await startClient()

    const restored = await client!.unarchiveThread('codex-thread-9')

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/unarchive')
    expect(request?.params).toEqual({ threadId: 'codex-thread-9' })
    expect(restored).toEqual({
      id: 'codex-thread-9',
      title: 'Restored Codex session',
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:05:00Z',
      cwd: 'D:/repo',
    })
  })

  it('listThreads forwards archived + searchTerm filters to thread/list', async () => {
    await startClient()

    await client!.listThreads({ archived: true, searchTerm: 'invoice' })

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/list')
    expect(request?.params).toEqual({ archived: true, searchTerm: 'invoice' })
  })

  it('listThreads with no args sends an empty params object (back-compat)', async () => {
    await startClient()

    await client!.listThreads()

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/list')
    expect(request?.params).toEqual({})
  })
})
