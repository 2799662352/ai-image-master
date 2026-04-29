// src/main/services/tencent/__tests__/jobQueue.test.ts
// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'
import { JobQueue } from '../jobQueue'

describe('JobQueue', () => {
  interface Job { id: string; runMs: number }

  it('runs up to maxConcurrent at once and queues the rest', async () => {
    const inflight: string[] = []
    const peakInflight = { value: 0 }

    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 2,
      runner: async (job) => {
        inflight.push(job.id)
        peakInflight.value = Math.max(peakInflight.value, inflight.length)
        await new Promise((r) => setTimeout(r, job.runMs))
        inflight.splice(inflight.indexOf(job.id), 1)
      },
      events: {},
      getJobId: (j) => j.id,
    })

    await Promise.all([
      queue.enqueue({ id: 'a', runMs: 30 }),
      queue.enqueue({ id: 'b', runMs: 30 }),
      queue.enqueue({ id: 'c', runMs: 30 }),
      queue.enqueue({ id: 'd', runMs: 30 }),
    ])

    expect(peakInflight.value).toBe(2)
    expect(inflight).toEqual([])
  })

  it('cancel() in queued state removes job before it starts', async () => {
    const startedJobs: string[] = []
    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (job) => {
        startedJobs.push(job.id)
        await new Promise((r) => setTimeout(r, 50))
      },
      events: {},
      getJobId: (j) => j.id,
    })

    const p1 = queue.enqueue({ id: 'a', runMs: 50 })
    const p2 = queue.enqueue({ id: 'b', runMs: 50 }) // queued behind a
    const cancelled = queue.cancel('b')

    expect(cancelled).toBe(true)
    await Promise.allSettled([p1, p2])
    expect(startedJobs).toEqual(['a'])
  })

  it('cancel() in active state aborts the runner via AbortSignal', async () => {
    let observedAborted = false
    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (_job, signal) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 100)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            observedAborted = true
            reject(new Error('aborted'))
          })
        })
      },
      events: {},
      getJobId: (j) => j.id,
    })

    const p = queue.enqueue({ id: 'a', runMs: 100 })
    await new Promise((r) => setTimeout(r, 10))
    expect(queue.cancel('a')).toBe(true)
    await expect(p).rejects.toThrow('aborted')
    expect(observedAborted).toBe(true)
  })

  it('cancelAll() empties active and pending', async () => {
    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (_job, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
          setTimeout(resolve, 200)
        })
      },
      events: {},
      getJobId: (j) => j.id,
    })

    const p1 = queue.enqueue({ id: 'a', runMs: 200 })
    const p2 = queue.enqueue({ id: 'b', runMs: 200 })
    await new Promise((r) => setTimeout(r, 10))
    queue.cancelAll()
    await expect(p1).rejects.toThrow()
    await expect(p2).rejects.toThrow()
    expect(queue.getActiveCount()).toBe(0)
    expect(queue.getQueuedCount()).toBe(0)
  })

  it('events.onProgress / onFinished / onFailed fire correctly', async () => {
    const onProgress = vi.fn()
    const onFinished = vi.fn()
    const onFailed = vi.fn()

    const queue = new JobQueue<Job, string>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (job, _signal, events) => {
        events.onProgress?.(job, { stage: 'working', progress: 50 })
        if (job.id === 'fail') throw Object.assign(new Error('boom'), { code: 'TEST_FAIL', stage: 'work' })
        return 'ok'
      },
      events: { onProgress, onFinished, onFailed },
      getJobId: (j) => j.id,
    })

    await queue.enqueue({ id: 'good', runMs: 0 })
    await expect(queue.enqueue({ id: 'fail', runMs: 0 })).rejects.toMatchObject({
      message: 'boom',
      code: 'TEST_FAIL',
      stage: 'work',
    })

    expect(onProgress).toHaveBeenCalledWith({ id: 'good', runMs: 0 }, { stage: 'working', progress: 50 })
    expect(onFinished).toHaveBeenCalledWith({ id: 'good', runMs: 0 }, 'ok')
    expect(onFailed).toHaveBeenCalledWith({ id: 'fail', runMs: 0 }, expect.objectContaining({ code: 'TEST_FAIL' }))
  })
})
