import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import WebSocket from 'ws'
import { createAgentLogStream } from './logger'
import { resolveCodexBinary } from './paths'
import { pickFreePort } from './ports'
import type { AgentStreamEvent } from '../../types/agent'
import type { AgentInput, IAgentBackend, JsonRpcMessage } from './types'

type PendingRpc = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class CodexLocalBackend implements IAgentBackend {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private rpcId = 0
  private pending = new Map<number, PendingRpc>()
  private events: AgentStreamEvent[] = []

  async start(): Promise<void> {
    const port = await pickFreePort(4222)
    const bin = resolveCodexBinary(process.resourcesPath || app.getAppPath())
    const log = createAgentLogStream('codex')
    this.proc = spawn(bin, ['app-server', 'serve', '--listen', `ws://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this.proc.stdout?.pipe(log)
    this.proc.stderr?.pipe(log)
    this.proc.once('error', (error) => {
      log.write(`[codex process error] ${error.message}\n`)
      this.rejectPending(error)
    })
    this.proc.on('exit', () => {
      this.ws?.close()
      this.ws = null
    })

    this.ws = await this.connect(`ws://127.0.0.1:${port}`)
    this.ws.on('message', (data) => this.handleMessage(String(data)))
    await this.rpc('initialize', { clientName: 'catimation' })
  }

  async stop(): Promise<void> {
    this.ws?.close()
    this.proc?.kill()
    this.ws = null
    this.proc = null
    this.rejectPending(new Error('Codex backend stopped'))
  }

  async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
    const actualThreadId = threadId ?? await this.createThread(input)
    const response = await this.rpc<{ turn: { id: string } }>('turn/start', {
      threadId: actualThreadId,
      input: input.items,
    })
    const turnId = response.turn.id

    while (true) {
      const event = await this.nextEvent(actualThreadId, turnId)
      yield event
      if (event.type === 'turn_completed' || event.type === 'error' || event.type === 'cancelled') return
    }
  }

  async cancel(threadId: string): Promise<void> {
    await this.rpc('turn/cancel', { threadId })
  }

  isHealthy(): boolean {
    return this.proc !== null && this.ws?.readyState === WebSocket.OPEN
  }

  private async createThread(input: AgentInput): Promise<string> {
    const response = await this.rpc<{ thread: { id: string } }>('thread/start', {
      model: input.model,
      cwd: input.cwd,
    })
    return response.thread.id
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.rpcId
    const payload: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }

    return new Promise<T>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error('Codex websocket is not connected'))
        return
      }

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.ws.send(JSON.stringify(payload), (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as JsonRpcMessage
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result)
      return
    }

    if (msg.method) this.events.push(this.normalizeNotification(msg))
  }

  private normalizeNotification(msg: JsonRpcMessage): AgentStreamEvent {
    const params = (msg.params ?? {}) as Record<string, any>
    if (msg.method === 'item/agentMessage/delta') {
      return { type: 'message_delta', threadId: params.threadId, turnId: params.turnId, delta: params.delta }
    }
    if (msg.method === 'item/reasoning/delta') {
      return { type: 'reasoning_delta', threadId: params.threadId, turnId: params.turnId, delta: params.delta }
    }
    if (msg.method === 'turn/completed') {
      return { type: 'turn_completed', threadId: params.threadId, turnId: params.turnId }
    }

    return {
      type: 'tool_call_start',
      threadId: params.threadId,
      turnId: params.turnId,
      tool: {
        id: params.itemId ?? crypto.randomUUID(),
        name: msg.method ?? 'unknown',
        status: 'running',
      },
    }
  }

  private nextEvent(threadId: string, turnId: string): Promise<AgentStreamEvent> {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const index = this.events.findIndex((event) => {
          return event.threadId === threadId && (!event.turnId || event.turnId === turnId)
        })
        if (index >= 0) {
          clearInterval(timer)
          resolve(this.events.splice(index, 1)[0])
        }
      }, 25)
    })
  }

  private connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
