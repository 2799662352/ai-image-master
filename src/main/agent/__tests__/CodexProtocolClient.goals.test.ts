import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentStreamEvent } from '../../../types/agent'

// Drives the Codex app-server v2 `thread/goal/*` RPCs + notification stream
// against a fake WebSocketServer (same harness style as
// CodexProtocolClient.mcp.test.ts / .plugins.test.ts) so we pin the exact wire
// method strings + params and the notification→callback routing without spawning
// the real Rust binary. Method strings verified live against the bundled 0.142.2
// binary via scripts/probe-thread-goal.ts.
function createTestServer(port: number) {
  const wss = new WebSocketServer({ port })
  const messages: unknown[] = []
  let respondTo: ((msg: any) => any) | null = null
  const sockets: import('ws').WebSocket[] = []

  wss.on('connection', (ws) => {
    sockets.push(ws)
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
    /** Push an out-of-band notification (no id) to all connected clients. */
    notify(method: string, params: Record<string, unknown>) {
      for (const ws of sockets) ws.send(JSON.stringify({ method, params }))
    },
    close() { wss.close() },
  }
}

describe('CodexProtocolClient goal methods', () => {
  const PORT = 17408
  let server: ReturnType<typeof createTestServer>
  let client: CodexProtocolClient
  let goalEvents: AgentStreamEvent[]

  beforeEach(async () => {
    server = createTestServer(PORT)
    goalEvents = []
    client = new CodexProtocolClient({
      url: `ws://127.0.0.1:${PORT}`,
      clientInfo: { name: 'test', version: '0.0.1' },
      connectTimeoutMs: 3000,
      connectIntervalMs: 50,
      onGoalNotification: (event) => goalEvents.push(event),
    })
    await client.start()
  })

  afterEach(async () => {
    await client.stop()
    server.close()
  })

  // ─── RPCs ─────────────────────────────────────────────────────────────────

  it('setThreadGoal sends thread/goal/set with objective and returns goal', async () => {
    server.setResponder(() => ({
      goal: {
        threadId: 'thr_1',
        objective: 'ship the feature',
        status: 'active',
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    }))
    const res = await client.setThreadGoal({ threadId: 'thr_1', objective: 'ship the feature' })
    const sent = server.sent('thread/goal/set')
    expect(sent.params.threadId).toBe('thr_1')
    expect(sent.params.objective).toBe('ship the feature')
    expect(res.goal.objective).toBe('ship the feature')
    expect(res.goal.status).toBe('active')
  })

  it('setThreadGoal forwards status (pause/resume via status change)', async () => {
    server.setResponder(() => ({ goal: { threadId: 'thr_1', objective: 'x', status: 'paused', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 } }))
    const res = await client.setThreadGoal({ threadId: 'thr_1', status: 'paused' })
    expect(server.sent('thread/goal/set').params.status).toBe('paused')
    expect(res.goal.status).toBe('paused')
  })

  it('getThreadGoal sends thread/goal/get and parses null when unset', async () => {
    server.setResponder(() => ({ goal: null }))
    const res = await client.getThreadGoal('thr_1')
    expect(server.sent('thread/goal/get').params.threadId).toBe('thr_1')
    expect(res.goal).toBeNull()
  })

  it('clearThreadGoal sends thread/goal/clear and returns cleared', async () => {
    server.setResponder(() => ({ cleared: true }))
    const res = await client.clearThreadGoal('thr_1')
    expect(server.sent('thread/goal/clear').params.threadId).toBe('thr_1')
    expect(res.cleared).toBe(true)
  })

  // ─── Notifications ──────────────────────────────────────────────────────────

  it('routes thread/goal/updated to onGoalNotification', async () => {
    const goal = {
      threadId: 'thr_1',
      objective: 'ship',
      status: 'active',
      tokensUsed: 10,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 3,
    }
    server.notify('thread/goal/updated', { threadId: 'thr_1', goal })
    await new Promise((r) => setTimeout(r, 100))
    const evt = goalEvents.find((e) => e.type === 'goal_updated')
    expect(evt).toBeTruthy()
    expect(evt).toMatchObject({ type: 'goal_updated', threadId: 'thr_1', goal: { objective: 'ship' } })
  })

  it('routes thread/goal/cleared to onGoalNotification', async () => {
    server.notify('thread/goal/cleared', { threadId: 'thr_1' })
    await new Promise((r) => setTimeout(r, 100))
    const evt = goalEvents.find((e) => e.type === 'goal_cleared')
    expect(evt).toMatchObject({ type: 'goal_cleared', threadId: 'thr_1' })
  })
})
