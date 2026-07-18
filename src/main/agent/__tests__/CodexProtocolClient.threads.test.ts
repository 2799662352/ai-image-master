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
      if (msg.method === 'initialize' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      } else if (msg.method === 'thread/list' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            threads: [
              {
                id: 'codex-thread-1',
                preview: 'First Codex session',
                created_at: '2026-05-08T01:00:00Z',
                updated_at: '2026-05-08T01:10:00Z',
                cwd: 'D:/repo',
                model: 'gpt-5.5',
                ignored: 'raw upstream data',
              },
            ],
          },
        }))
      } else if (msg.method === 'thread/read' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            thread: {
              id: msg.params.threadId,
              title: 'Readable Codex session',
              createdAt: '2026-05-08T02:00:00Z',
              updatedAt: '2026-05-08T02:10:00Z',
              cwd: 'D:/repo',
              model: 'gpt-5.5',
              items: [{ type: 'message', role: 'user' }],
            },
          },
        }))
      } else if (msg.method === 'thread/fork' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            thread: {
              id: 'forked-thread',
              preview: 'Forked Codex session',
              createdAt: '2026-05-08T03:00:00Z',
              updatedAt: '2026-05-08T03:00:00Z',
              cwd: 'D:/repo',
            },
          },
        }))
      } else if (msg.method === 'thread/resume' && msg.id !== undefined) {
        // Response shape matches thread/start; resumeThread ignores it.
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            thread: {
              id: msg.params.threadId,
              preview: 'Resumed Codex session',
              createdAt: '2026-05-08T04:00:00Z',
              updatedAt: '2026-05-08T04:10:00Z',
              cwd: 'D:/repo',
            },
          },
        }))
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

describe('CodexProtocolClient thread history wrappers', () => {
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

  it('listThreads sends thread/list and normalizes summaries', async () => {
    await startClient()

    const list = await client!.listThreads()

    expect(server!.receivedFromClient.some((msg) => msg.method === 'thread/list')).toBe(true)
    expect(list).toEqual([
      {
        id: 'codex-thread-1',
        title: 'First Codex session',
        createdAt: '2026-05-08T01:00:00Z',
        updatedAt: '2026-05-08T01:10:00Z',
        cwd: 'D:/repo',
        model: 'gpt-5.5',
      },
    ])
  })

  it('readThread sends thread/read with the thread id and normalizes details', async () => {
    await startClient()

    const detail = await client!.readThread('codex-thread-1')

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/read')
    expect(request?.params).toEqual({ threadId: 'codex-thread-1' })
    expect(detail).toEqual({
      id: 'codex-thread-1',
      title: 'Readable Codex session',
      createdAt: '2026-05-08T02:00:00Z',
      updatedAt: '2026-05-08T02:10:00Z',
      cwd: 'D:/repo',
      model: 'gpt-5.5',
    })
  })

  it('forkThread sends thread/fork with the thread id and normalizes the fork summary', async () => {
    await startClient()

    const forked = await client!.forkThread('codex-thread-1')

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/fork')
    expect(request?.params).toEqual({ threadId: 'codex-thread-1' })
    expect(forked).toEqual({
      id: 'forked-thread',
      title: 'Forked Codex session',
      createdAt: '2026-05-08T03:00:00Z',
      updatedAt: '2026-05-08T03:00:00Z',
      cwd: 'D:/repo',
    })
  })

  it('resumeThread sends thread/resume with only the thread id (binary-compatible)', async () => {
    await startClient()

    await expect(client!.resumeThread('codex-thread-1')).resolves.toBeUndefined()

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/resume')
    expect(request?.params).toEqual({ threadId: 'codex-thread-1' })
  })

  it('resumeThread forwards explicit model/modelProvider overrides (cross-channel switch)', async () => {
    // codex thread/resume restores the PERSISTED model_provider from thread
    // metadata (openai/codex#19287). After a grok→gpt channel switch the old
    // provider table is no longer in the launch config, so resume dies with
    // "Model provider `<old>` not found" — unless we override explicitly.
    await startClient()

    await expect(client!.resumeThread('codex-thread-1', {
      model: 'gpt-5.6-sol',
      modelProvider: 'rightcode-standard',
    })).resolves.toBeUndefined()

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/resume')
    expect(request?.params).toEqual({
      threadId: 'codex-thread-1',
      model: 'gpt-5.6-sol',
      modelProvider: 'rightcode-standard',
    })
  })

  it('forkThread forwards explicit model/modelProvider overrides', async () => {
    await startClient()

    await client!.forkThread('codex-thread-1', {
      model: 'grok-4.5',
      modelProvider: 'rightcode-grok',
    })

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/fork')
    expect(request?.params).toEqual({
      threadId: 'codex-thread-1',
      model: 'grok-4.5',
      modelProvider: 'rightcode-grok',
    })
  })

  it('resumeThread forwards the per-thread context pin via config (Plan B)', async () => {
    await startClient()

    await client!.resumeThread('codex-thread-1', {
      model: 'grok-4.5',
      modelProvider: 'rightcode-grok',
      config: {
        model_context_window: 500_000,
        model_auto_compact_token_limit: 450_000,
      },
    })

    const request = server!.receivedFromClient.find((msg) => msg.method === 'thread/resume')
    expect(request?.params).toEqual({
      threadId: 'codex-thread-1',
      model: 'grok-4.5',
      modelProvider: 'rightcode-grok',
      config: {
        model_context_window: 500_000,
        model_auto_compact_token_limit: 450_000,
      },
    })
  })
})
