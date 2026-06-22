import { randomUUID } from 'node:crypto'
import type { CanvasEditRequest, EditRequestPollResult, EditRequestQueueStatus } from '../../../types/canvas'

type NewRequest = Omit<CanvasEditRequest, 'requestId' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>

const TTL_AFTER_TERMINAL_MS = 30 * 60_000
const LISTENER_ACTIVE_WINDOW_MS = 30_000

export class EditRequestRegistry {
  private requests = new Map<string, CanvasEditRequest>()
  private waiters = new Set<() => void>()
  private lastListenerSeenAt = 0

  enqueue(input: NewRequest): CanvasEditRequest {
    this.gc()
    const now = new Date().toISOString()
    const request: CanvasEditRequest = { ...input, requestId: randomUUID(), status: 'queued', attempts: 0, createdAt: now, updatedAt: now }
    this.requests.set(request.requestId, request)
    for (const wake of this.waiters) wake()
    return request
  }

  get(requestId: string): CanvasEditRequest | undefined {
    return this.requests.get(requestId)
  }

  update(requestId: string, status: CanvasEditRequest['status'], result?: Record<string, unknown>, error?: string): CanvasEditRequest | undefined {
    const request = this.requests.get(requestId)
    if (!request) return undefined
    request.status = status
    request.updatedAt = new Date().toISOString()
    if (result !== undefined) request.result = result
    if (error !== undefined) request.error = error
    if (status === 'completed') request.completedAt = request.updatedAt
    return request
  }

  /** Long-poll for the next queued request. Marks it processing when `claim`. */
  async waitForNext(timeoutMs: number, opts: { claim: boolean }): Promise<EditRequestPollResult> {
    this.lastListenerSeenAt = Date.now()
    const take = (): CanvasEditRequest | undefined => {
      const next = [...this.requests.values()].find((r) => r.status === 'queued')
      if (next && opts.claim) {
        next.status = 'processing'
        next.claimedAt = new Date().toISOString()
        next.updatedAt = next.claimedAt
      }
      return next
    }
    const immediate = take()
    if (immediate) return { request: immediate, timedOut: false, message: 'Edit request ready.' }

    await new Promise<void>((resolve) => {
      let settled = false
      const wake = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      this.waiters.add(wake)
    })

    this.lastListenerSeenAt = Date.now()
    const after = take()
    return after
      ? { request: after, timedOut: false, message: 'Edit request ready.' }
      : { request: undefined, timedOut: true, message: 'No queued edit request yet. Waiting for the user to annotate and click 按标注修图.' }
  }

  getStatus(): EditRequestQueueStatus {
    const values = [...this.requests.values()]
    return {
      listenerActive: Date.now() - this.lastListenerSeenAt < LISTENER_ACTIVE_WINDOW_MS,
      listenerLastSeenAt: this.lastListenerSeenAt ? new Date(this.lastListenerSeenAt).toISOString() : undefined,
      listenerActiveWindowMs: LISTENER_ACTIVE_WINDOW_MS,
      queuedCount: values.filter((r) => r.status === 'queued').length,
      processingCount: values.filter((r) => r.status === 'processing').length,
      latestRequest: values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
      updatedAt: new Date().toISOString(),
    }
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, r] of this.requests) {
      const terminal = r.status === 'completed' || r.status === 'failed'
      if (terminal && now - Date.parse(r.updatedAt) > TTL_AFTER_TERMINAL_MS) this.requests.delete(id)
    }
  }
}

export const editRequestRegistry = new EditRequestRegistry()
