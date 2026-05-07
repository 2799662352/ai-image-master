// Encapsulates the Codex `app-server` WebSocket JSON-RPC protocol so it can be
// driven against a fake WebSocketServer in tests without spawning the real
// Rust binary. CodexLocalBackend composes this client with its spawn lifecycle.

import WebSocket from 'ws'
import { connectWithRetry } from './connectWithRetry'
import { CodexNotificationRouter } from './codexNotificationRouter'
import { mapUserInput } from './codexUserInput'
import {
  isServerNotification,
  isServerRequest,
  type ClientInfo,
  type ServerMessage,
  type ThreadStartResponse,
  type TurnStartResponse,
} from './codexProtocol'
import type { AgentStreamEvent } from '../../types/agent'
import type { AgentInput } from './types'

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_CONNECT_INTERVAL_MS = 100
const CANCEL_GRACE_MS = 2_000

type PendingRpc = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type TurnQueue = {
  threadId: string
  turnId: string
  buffer: AgentStreamEvent[]
  waiter?: (event: AgentStreamEvent) => void
  closed: boolean
}

const ORPHAN_BUFFER_LIMIT = 1024

export interface CodexProtocolClientOptions {
  url: string
  clientInfo: ClientInfo
  connectTimeoutMs?: number
  connectIntervalMs?: number
  rpcTimeoutMs?: number
  onLog?: (line: string) => void
}

/**
 * Stateless notification mapping kept around for backwards-compat with any
 * external callers (re-exported from CodexLocalBackend). New code should
 * prefer constructing a {@link CodexNotificationRouter} per session — it adds
 * `item/completed`-agentMessage fallback and delta dedup.
 *
 * @deprecated Prefer `new CodexNotificationRouter().route(method, params)`.
 */
export function mapServerNotification(method: string, params: any): AgentStreamEvent | null {
  return new CodexNotificationRouter().route(method, params ?? {})
}

export class CodexProtocolClient {
  private ws: WebSocket | null = null
  private rpcId = 0
  private pending = new Map<number, PendingRpc>()
  private queues = new Map<string, TurnQueue>()
  private turnIdByThread = new Map<string, string>()
  private readonly notificationRouter = new CodexNotificationRouter()
  // Notifications received before their per-turn queue was created. We can
  // race the server's first delta against our turn/start response handling, so
  // we hold them here and drain them when the queue is registered.
  private orphanEvents: AgentStreamEvent[] = []
  private readonly rpcTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly connectIntervalMs: number

  constructor(private readonly options: CodexProtocolClientOptions) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.connectIntervalMs = options.connectIntervalMs ?? DEFAULT_CONNECT_INTERVAL_MS
  }

  async start(): Promise<void> {
    this.ws = await connectWithRetry({
      attempt: () => this.openOnce(this.options.url),
      timeoutMs: this.connectTimeoutMs,
      intervalMs: this.connectIntervalMs,
    })

    this.ws.on('message', (data) => this.handleRaw(String(data)))
    this.ws.on('close', () => this.failAllQueues(new Error('codex websocket closed')))

    await this.rpc('initialize', { clientInfo: this.options.clientInfo, capabilities: null })
  }

  async stop(): Promise<void> {
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close() } catch { /* ignore */ }
    }
    this.failAllQueues(new Error('Codex protocol client stopped'))
    this.rejectPending(new Error('Codex protocol client stopped'))
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
    let actualThreadId = threadId
    if (!actualThreadId) {
      const response = await this.rpc<ThreadStartResponse>('thread/start', this.threadStartParams(input))
      actualThreadId = response.thread.id
      yield { type: 'thread_created', threadId: actualThreadId }
    }

    const turnResponse = await this.rpc<TurnStartResponse>('turn/start', {
      threadId: actualThreadId,
      input: mapUserInput(input.items),
    })
    const turnId = turnResponse.turn.id
    this.turnIdByThread.set(actualThreadId, turnId)

    const key = queueKey(actualThreadId, turnId)
    const queue: TurnQueue = { threadId: actualThreadId, turnId, buffer: [], closed: false }
    this.queues.set(key, queue)
    this.drainOrphansInto(actualThreadId, turnId, queue)

    try {
      while (true) {
        const event = await this.takeEvent(queue)
        yield event
        if (event.type === 'turn_completed' || event.type === 'error' || event.type === 'cancelled') return
      }
    } finally {
      queue.closed = true
      this.queues.delete(key)
      if (this.turnIdByThread.get(actualThreadId) === turnId) {
        this.turnIdByThread.delete(actualThreadId)
      }
    }
  }

  async cancel(threadId: string): Promise<void> {
    const turnId = this.turnIdByThread.get(threadId)
    if (!turnId) return

    try {
      await this.rpc('turn/interrupt', { threadId, turnId })
    } catch (error) {
      this.options.onLog?.(`[codex] turn/interrupt rejected: ${stringifyError(error)}`)
    }

    const key = queueKey(threadId, turnId)
    const grace = setTimeout(() => {
      const queue = this.queues.get(key)
      if (!queue || queue.closed) return
      this.pushEventToQueue(queue, { type: 'cancelled', threadId, turnId })
    }, CANCEL_GRACE_MS)
    grace.unref?.()
  }

  private openOnce(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url)
      let settled = false
      const cleanup = (): void => {
        ws.removeListener('open', onOpen)
        ws.removeListener('error', onError)
      }
      const onOpen = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(ws)
      }
      const onError = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        try { ws.close() } catch { /* ignore */ }
        reject(error)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
    })
  }

  private threadStartParams(input: AgentInput): Record<string, unknown> {
    return {
      model: input.model,
      cwd: input.cwd,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    }
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex websocket is not connected'))
    }
    const id = ++this.rpcId
    const payload = { jsonrpc: '2.0' as const, id, method, params }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex RPC ${method} timed out after ${this.rpcTimeoutMs}ms`))
      }, this.rpcTimeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.ws!.send(JSON.stringify(payload), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private handleRaw(raw: string): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw) as ServerMessage
    } catch {
      this.options.onLog?.(`[codex] failed to parse message: ${raw.slice(0, 200)}`)
      return
    }

    if ('id' in msg && (msg as any).id !== undefined && (msg as any).method === undefined) {
      const response = msg as { id: number; result?: unknown; error?: { code: number; message: string } }
      const pending = this.pending.get(response.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error.message))
      else pending.resolve(response.result)
      return
    }

    if (isServerRequest(msg)) {
      this.options.onLog?.(`[codex] server request: ${msg.method} (id=${msg.id})`)
      this.respondToServerRequest(msg.id)
      return
    }

    if (isServerNotification(msg)) {
      this.routeNotification(msg.method, (msg.params ?? {}) as Record<string, any>)
    }
  }

  private respondToServerRequest(id: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const payload = { jsonrpc: '2.0' as const, id, result: {} }
    this.ws.send(JSON.stringify(payload))
  }

  private routeNotification(method: string, params: Record<string, any>): void {
    const event = this.notificationRouter.route(method, params)
    if (!event) {
      // Don't spam the codex log with 'unhandled notification' for the dozens
      // of bookkeeping notifications we intentionally ignore (thread/started,
      // item/started, warning, etc). The router is the source of truth: if
      // it returns null, that's a deliberate drop.
      return
    }
    const threadId = event.threadId
    const turnId = event.turnId ?? (threadId ? this.turnIdByThread.get(threadId) : undefined)
    if (!threadId || !turnId) return
    const queue = this.queues.get(queueKey(threadId, turnId))
    if (queue) {
      this.pushEventToQueue(queue, event)
      return
    }
    // Server began streaming before send()'s `await this.rpc('turn/start', ...)`
    // had a chance to register the per-turn queue. Buffer until it appears.
    if (this.orphanEvents.length < ORPHAN_BUFFER_LIMIT) {
      this.orphanEvents.push({ ...event, turnId })
    }
  }

  private drainOrphansInto(threadId: string, turnId: string, queue: TurnQueue): void {
    if (this.orphanEvents.length === 0) return
    const remaining: AgentStreamEvent[] = []
    for (const event of this.orphanEvents) {
      if (event.threadId === threadId && event.turnId === turnId) {
        this.pushEventToQueue(queue, event)
      } else {
        remaining.push(event)
      }
    }
    this.orphanEvents = remaining
  }

  private pushEventToQueue(queue: TurnQueue, event: AgentStreamEvent): void {
    if (queue.closed) return
    if (queue.waiter) {
      const resolve = queue.waiter
      queue.waiter = undefined
      resolve(event)
    } else {
      queue.buffer.push(event)
    }
  }

  private takeEvent(queue: TurnQueue): Promise<AgentStreamEvent> {
    return new Promise<AgentStreamEvent>((resolve) => {
      const buffered = queue.buffer.shift()
      if (buffered) {
        resolve(buffered)
        return
      }
      queue.waiter = resolve
    })
  }

  private failAllQueues(error: Error): void {
    for (const queue of this.queues.values()) {
      if (queue.closed) continue
      const event: AgentStreamEvent = {
        type: 'error',
        threadId: queue.threadId,
        turnId: queue.turnId,
        error: error.message,
      }
      if (queue.waiter) {
        const resolve = queue.waiter
        queue.waiter = undefined
        resolve(event)
      } else {
        queue.buffer.push(event)
      }
      queue.closed = true
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function queueKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
