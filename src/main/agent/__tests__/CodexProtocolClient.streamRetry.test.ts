import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { AgentInput, AgentStreamEvent } from '../types'

/**
 * Guards the turn-lifecycle contract for codex stream retries
 * (openai/codex#7611 / codex-rs bespoke_event_handling.rs):
 *
 *   - `error` notification with `willRetry: true` = transient stream error.
 *     codex is about to retry the SAME request and re-stream the response —
 *     the turn is still alive, so `send()` must keep draining events.
 *   - `error` with `willRetry: false`/absent = terminal. `send()` ends.
 *
 * Bug being guarded against ("对话丢失状态卡住"): send() used to treat EVERY
 * error event as terminal and tore down the per-turn queue, while the
 * renderer (store.streamRetry semantics) kept isRunning=true waiting for the
 * retry. The retry's re-streamed events then arrived with no queue, got
 * orphaned, and the UI hung forever.
 */

interface FakeCodexServer {
  url: string
  notify: (method: string, params: Record<string, unknown>) => void
  close: () => Promise<void>
}

async function startFakeCodexServer(): Promise<FakeCodexServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  let activeSocket: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.id === undefined) return
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      } else if (msg.method === 'turn/start') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    notify(method, params) {
      activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    },
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

function textInput(text: string): AgentInput {
  return { items: [{ type: 'text', text }] } as unknown as AgentInput
}

async function collectEvents(
  iterable: AsyncIterable<AgentStreamEvent>,
  timeoutMs = 3000,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  const timer = setTimeout(() => {
    throw new Error(`collectEvents timed out after ${timeoutMs}ms; got ${JSON.stringify(events)}`)
  }, timeoutMs)
  try {
    for await (const event of iterable) events.push(event)
    return events
  } finally {
    clearTimeout(timer)
  }
}

describe('CodexProtocolClient.send stream-retry lifecycle', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('keeps the turn stream alive across willRetry:true errors until turn/completed', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    const threadId = 'thread-A'
    const collected = collectEvents(client.send(threadId, textInput('hi')))

    // Transient stream error → retry re-stream → completion, all on the SAME turn.
    // Small delays let the client register the queue / process each frame.
    await new Promise((r) => setTimeout(r, 50))
    server.notify('error', {
      threadId,
      turnId: 'turn-1',
      error: { message: 'stream disconnected before completion' },
      willRetry: true,
    })
    await new Promise((r) => setTimeout(r, 50))
    server.notify('item/completed', {
      threadId,
      turnId: 'turn-1',
      item: { id: 'item-1', type: 'agentMessage', text: '重试后完整回答' },
    })
    await new Promise((r) => setTimeout(r, 50))
    server.notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } })

    const events = await collected
    const types = events.map((e) => e.type)
    expect(types).toContain('error')
    expect(types[types.length - 1]).toBe('turn_completed')
    const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentStreamEvent, { type: 'error' }>
    expect(errorEvent.willRetry).toBe(true)
  })

  it('still terminates on terminal errors (willRetry false/absent)', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({ url: server.url, clientInfo: { name: 't', version: '0' } })
    await client.start()

    const threadId = 'thread-B'
    const collected = collectEvents(client.send(threadId, textInput('hi')))

    await new Promise((r) => setTimeout(r, 50))
    server.notify('error', {
      threadId,
      turnId: 'turn-1',
      error: { message: 'fatal' },
      willRetry: false,
    })

    const events = await collected
    expect(events.map((e) => e.type)).toEqual(['error'])
  })
})

describe('CodexProtocolClient.send stream-idle watchdog', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('ends a silent turn with a terminal error after turnIdleTimeoutMs', async () => {
    // Upstream openai/codex#30526: app-server can go permanently silent
    // mid-turn (no turn/completed, no error). Without a watchdog the UI hangs
    // forever ("对话丢失状态卡住"). The watchdog must synthesize a TERMINAL
    // error so downstream consumers recover.
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      turnIdleTimeoutMs: 300,
    })
    await client.start()

    const events = await collectEvents(client.send('thread-idle', textInput('hi')))
    expect(events).toHaveLength(1)
    const only = events[0] as Extract<AgentStreamEvent, { type: 'error' }>
    expect(only.type).toBe('error')
    expect(only.willRetry).not.toBe(true)
    expect(only.error).toMatch(/idle|无响应|silent/i)
  })

  it('turnIdleTimeoutMs=0 disables the watchdog — a silent turn is left alone', async () => {
    // This is the production default. The 10-minute budget was calibrated for
    // shell commands, but our MCP tools legitimately run silent for far longer
    // (tool_timeout_sec is 2000s; generate_video polls Seedance for minutes),
    // so the watchdog was killing healthy turns mid-render. Nothing else covers
    // the off switch, and re-enabling it by accident is invisible until a user
    // loses a paid generation.
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      turnIdleTimeoutMs: 0,
    })
    await client.start()

    const threadId = 'thread-no-watchdog'
    const collected = collectEvents(client.send(threadId, textInput('hi')))

    // Stay silent well past what any enabled watchdog would tolerate here,
    // then complete normally. A surviving watchdog would have injected an error.
    await new Promise((r) => setTimeout(r, 600))
    server.notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } })

    const events = await collected
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('resets the watchdog whenever any event arrives', async () => {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      turnIdleTimeoutMs: 400,
    })
    await client.start()

    const threadId = 'thread-alive'
    const collected = collectEvents(client.send(threadId, textInput('hi')))

    // Keep the stream alive with deltas spaced under the timeout, then finish
    // after a total elapsed time well beyond a single timeout window.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 200))
      server.notify('item/agentMessage/delta', {
        threadId,
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: `chunk-${i}`,
      })
    }
    await new Promise((r) => setTimeout(r, 100))
    server.notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } })

    const events = await collected
    expect(events.map((e) => e.type)).not.toContain('error')
    expect(events[events.length - 1].type).toBe('turn_completed')
  })
})
