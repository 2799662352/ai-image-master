import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

// Drives the Codex app-server v2 `thread/compact/start` RPC against a fake
// WebSocketServer (same harness style as CodexProtocolClient.goals.test.ts) so
// we pin the exact wire method string + params. Manual compaction returns `{}`
// immediately; real progress streams as a `contextCompaction` item over the
// normal event channel (covered elsewhere).
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
    setResponder(fn: (msg: any) => any) {
      respondTo = fn
    },
    sent(method: string) {
      return messages.find((m: any) => m.method === method) as any
    },
    close() {
      wss.close()
    },
  }
}

describe('CodexProtocolClient compact method', () => {
  const PORT = 17409
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

  it('compactThread sends thread/compact/start with threadId', async () => {
    server.setResponder(() => ({}))
    await client.compactThread('thr_1')
    const sent = server.sent('thread/compact/start')
    expect(sent).toBeTruthy()
    expect(sent.params.threadId).toBe('thr_1')
  })
})
