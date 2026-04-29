// src/main/services/tencent/jobQueue.ts

import type { JobQueueOptions } from './types'

interface QueueEntry<TInput, TOutput> {
  job: TInput
  resolve: (value: TOutput) => void
  reject: (err: any) => void
}

interface ActiveEntry {
  controller: AbortController
}

export class JobQueue<TInput, TOutput> {
  private active = new Map<string, ActiveEntry>()
  private pending: QueueEntry<TInput, TOutput>[] = []

  constructor(private readonly opts: JobQueueOptions<TInput, TOutput>) {}

  enqueue(job: TInput): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      this.pending.push({ job, resolve, reject })
      this.dequeue()
    })
  }

  cancel(jobId: string): boolean {
    const active = this.active.get(jobId)
    if (active) {
      active.controller.abort()
      return true
    }
    const idx = this.pending.findIndex((e) => this.opts.getJobId(e.job) === jobId)
    if (idx >= 0) {
      const [removed] = this.pending.splice(idx, 1)
      removed.reject(Object.assign(new Error('Cancelled while queued'), { code: 'TASK_CANCELLED', stage: 'queued' }))
      return true
    }
    return false
  }

  cancelAll(): void {
    for (const [, entry] of this.active) entry.controller.abort()
    this.active.clear()
    while (this.pending.length > 0) {
      const e = this.pending.shift()!
      e.reject(Object.assign(new Error('All cancelled'), { code: 'TASK_CANCELLED', stage: 'queued' }))
    }
  }

  getActiveCount(): number { return this.active.size }
  getQueuedCount(): number { return this.pending.length }

  private dequeue(): void {
    while (this.active.size < this.opts.maxConcurrent && this.pending.length > 0) {
      const entry = this.pending.shift()!
      this.runOne(entry)
    }
  }

  private async runOne(entry: QueueEntry<TInput, TOutput>): Promise<void> {
    const jobId = this.opts.getJobId(entry.job)
    const controller = new AbortController()
    this.active.set(jobId, { controller })

    try {
      const result = await this.opts.runner(entry.job, controller.signal, this.opts.events)
      try {
        this.opts.events.onFinished?.(entry.job, result)
      } catch (e) {
        console.warn(`[JobQueue:${this.opts.name}] onFinished threw:`, e)
      }
      entry.resolve(result)
    } catch (err: any) {
      const errorPayload = {
        code: err.code || 'UNKNOWN_ERROR',
        message: err.message || String(err),
        stage: err.stage || 'unknown',
      }
      try {
        this.opts.events.onFailed?.(entry.job, errorPayload)
      } catch (e) {
        console.warn(`[JobQueue:${this.opts.name}] onFailed threw:`, e)
      }
      entry.reject(err)
    } finally {
      this.active.delete(jobId)
      this.dequeue()
    }
  }
}
