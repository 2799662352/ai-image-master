import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentInput, AgentStreamEvent } from '../types'

/**
 * Where a sub-agent's events go.
 *
 * Multi-agent V2 is on by default at 0.145 (measured: `scripts/smoke-subagents.ts
 * --no-agents` still spawns), and a child agent streams its whole turn —
 * userMessage, reasoning, agentMessage, token usage, turn/completed — under its
 * OWN thread id on this same connection. Those notifications match no
 * registered queue.
 *
 * Before this guard they fell into `orphanEvents`, a buffer whose only purpose
 * is to hold events that arrive in the millisecond window between the server
 * starting to stream and `send()` registering its per-turn queue. Nothing ever
 * claims a child's thread id, so those entries were never drained and never
 * evicted: a monotonic leak that, once it hit the 1024-entry cap, started
 * silently discarding the MAIN thread's legitimate race orphans — i.e. the
 * dropped-first-delta bug the buffer exists to prevent.
 *
 * The fix narrows buffering to the only case that can be claimed: a thread with
 * a `turn/start` in flight. Everything else is handed to `onUnroutedEvent` so a
 * consumer can attribute it (sub-agent token usage belongs on the parent's
 * bill) instead of it rotting in a buffer.
 */

interface FakeCodexServer {
  url: string
  notify: (method: string, params: Record<string, unknown>) => void
  /** Fires while `turn/start` is being handled, before the response is sent. */
  onTurnStart?: (notify: FakeCodexServer['notify']) => void
  close: () => Promise<void>
}

async function startFakeCodexServer(): Promise<FakeCodexServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  let activeSocket: WebSocket | null = null

  const notify: FakeCodexServer['notify'] = (method, params) => {
    activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  const server: FakeCodexServer = {
    url: `ws://127.0.0.1:${port}`,
    notify,
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as { id?: number, method?: string }
      if (message.id === undefined) return
      if (message.method === 'initialize') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
        return
      }
      if (message.method === 'turn/start') {
        server.onTurnStart?.(notify)
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { turn: { id: 'turn-parent', status: 'inProgress' } },
        }))
      }
    })
  })

  return server
}

function textInput(text: string): AgentInput {
  return { items: [{ type: 'text', text }] } as unknown as AgentInput
}

function orphanCount(client: CodexProtocolClient): number {
  return (client as unknown as { orphanEvents: unknown[] }).orphanEvents.length
}

/** Lets the socket deliver anything already queued. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

describe('CodexProtocolClient sub-agent event handling', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('hands a sub-agent thread\'s events to the sink instead of buffering them forever', async () => {
    server = await startFakeCodexServer()
    const unrouted: AgentStreamEvent[] = []
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'test', version: '0' },
      onUnroutedEvent: (event) => { unrouted.push(event) },
    })
    await client.start()

    const stream = client.send('parent', textInput('go'))[Symbol.asyncIterator]()
    const first = stream.next()
    await settle()

    // A child agent's turn, verbatim in shape from the wire: its own thread and
    // its own turn, on the parent's connection.
    server.notify('item/completed', {
      threadId: 'child-1',
      turnId: 'turn-child',
      item: { type: 'agentMessage', id: 'msg-child', text: 'pong' },
    })
    await settle()

    // Asserted by identity, not event type: a completed `agentMessage` maps to
    // a text delta under the cumulative-snapshot contract, and which mapping
    // applies is the router's business, not this layer's.
    expect(unrouted).toHaveLength(1)
    expect(unrouted[0]).toMatchObject({ threadId: 'child-1' })
    expect(orphanCount(client)).toBe(0)

    // The parent stream is unaffected and still ends on its own turn.
    server.notify('turn/completed', { threadId: 'parent', turn: { id: 'turn-parent' } })
    await first
    await stream.return?.()
  })

  it('still buffers the race orphan its owner is about to claim', async () => {
    // The regression this must not cause: codex can stream the first delta
    // before our `turn/start` call returns. That event has no queue yet either,
    // but unlike a sub-agent's it WILL be claimed milliseconds later.
    server = await startFakeCodexServer()
    const unrouted: AgentStreamEvent[] = []
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'test', version: '0' },
      onUnroutedEvent: (event) => { unrouted.push(event) },
    })
    await client.start()

    server.onTurnStart = (notify) => {
      notify('item/agentMessage/delta', {
        threadId: 'parent',
        turnId: 'turn-parent',
        itemId: 'msg-1',
        delta: 'hel',
      })
    }

    const events: AgentStreamEvent[] = []
    const stream = client.send('parent', textInput('go'))[Symbol.asyncIterator]()
    const firstEvent = stream.next()
    await settle()
    server.notify('turn/completed', { threadId: 'parent', turn: { id: 'turn-parent' } })

    events.push((await firstEvent).value as AgentStreamEvent)
    for (;;) {
      const next = await stream.next()
      if (next.done) break
      events.push(next.value)
    }

    expect(events.some((event) => event.type === 'item_delta')).toBe(true)
    expect(unrouted).toHaveLength(0)
  })
})
