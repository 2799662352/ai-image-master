import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ImageTaskManager,
  IMAGE_TASK_RENDERER_GONE_ERROR,
  IMAGE_TASK_TIMEOUT_ERROR,
} from '../imageTaskRegistry'

describe('ImageTaskManager', () => {
  it('creates a running task with a unique id', () => {
    const reg = new ImageTaskManager()
    const a = reg.create('cat')
    const b = reg.create('dog')
    expect(a).not.toBe(b)
    expect(reg.get(a)).toMatchObject({ taskId: a, status: 'running', prompt: 'cat' })
  })

  it('applyUpdate(succeeded) flips status and stores the result', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    expect(reg.get(id)!.status).toBe('running')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true, paths: ['x.png'] } })
    expect(reg.get(id)!.status).toBe('succeeded')
    expect(reg.get(id)!.result).toEqual({ ok: true, paths: ['x.png'] })
  })

  it('applyUpdate(failed) flips status and stores the error message', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'failed', error: 'boom' })
    expect(reg.get(id)!.status).toBe('failed')
    expect(reg.get(id)!.error).toBe('boom')
  })

  it('fail() settles an un-acked task as failed', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.fail(id, 'renderer gone')
    expect(reg.get(id)!.status).toBe('failed')
    expect(reg.get(id)!.error).toBe('renderer gone')
  })

  it('applyUpdate is idempotent — a second terminal update does not overwrite the first', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true } })
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'failed', error: 'late' })
    expect(reg.get(id)!.status).toBe('succeeded')
  })

  it('failAllRunning settles every running task and leaves terminal tasks untouched', () => {
    const reg = new ImageTaskManager()
    const running1 = reg.create('cat')
    const running2 = reg.create('dog', 'batch')
    const done = reg.create('bird')
    reg.applyUpdate({ taskId: done, kind: 'single', status: 'succeeded', result: { ok: true } })

    const failed = reg.failAllRunning(IMAGE_TASK_RENDERER_GONE_ERROR)

    expect(failed).toBe(2)
    expect(reg.get(running1)).toMatchObject({ status: 'failed', error: IMAGE_TASK_RENDERER_GONE_ERROR })
    expect(reg.get(running2)).toMatchObject({ status: 'failed', error: IMAGE_TASK_RENDERER_GONE_ERROR })
    expect(reg.get(done)!.status).toBe('succeeded')
  })

  it('failAllRunning wakes long-poll waiters immediately', async () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    const wait = reg.waitForTerminal(id, 30_000)

    reg.failAllRunning(IMAGE_TASK_RENDERER_GONE_ERROR)

    const snapshot = await wait
    expect(snapshot).toMatchObject({ status: 'failed', error: IMAGE_TASK_RENDERER_GONE_ERROR })
  })

  it('failAllRunning is a no-op when nothing is running', () => {
    const reg = new ImageTaskManager()
    expect(reg.failAllRunning('gone')).toBe(0)
  })

  it('applyUpdate safely ignores unknown task ids', () => {
    const reg = new ImageTaskManager()
    expect(() => reg.applyUpdate({ taskId: 'nope', kind: 'single', status: 'succeeded' })).not.toThrow()
    expect(reg.get('nope')).toBeUndefined()
  })

  it('waitForTerminal returns undefined for an unknown id', async () => {
    const reg = new ImageTaskManager()
    await expect(reg.waitForTerminal('nope', 10)).resolves.toBeUndefined()
  })

  it('waitForTerminal returns the snapshot immediately when already terminal', async () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true } })
    const snap = await reg.waitForTerminal(id, 50_000)
    expect(snap!.status).toBe('succeeded')
  })

  it('waitForTerminal wakes as soon as the task settles (does not burn the full timeout)', async () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    const started = Date.now()
    const waitP = reg.waitForTerminal(id, 5_000)
    setTimeout(() => reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true } }), 5)
    const snap = await waitP
    expect(snap!.status).toBe('succeeded')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('waitForTerminal returns the running snapshot when the timeout fires first', async () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat') // never settles
    const snap = await reg.waitForTerminal(id, 10)
    expect(snap!.status).toBe('running')
  })

  describe('lost-terminal-IPC watchdog（running 超 30 分钟自动判失败）', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('running 超过 30 分钟后 waitForTerminal 立即返回 failed（不再无限轮询）', async () => {
      vi.useFakeTimers()
      const reg = new ImageTaskManager()
      const id = reg.create('cat') // 终态广播「丢失」，永不 settle
      vi.advanceTimersByTime(30 * 60_000 + 1)
      const snap = await reg.waitForTerminal(id, 25_000)
      expect(snap!.status).toBe('failed')
      expect(snap!.error).toBe(IMAGE_TASK_TIMEOUT_ERROR)
    })

    it('get() 同样触发过期判定', () => {
      vi.useFakeTimers()
      const reg = new ImageTaskManager()
      const id = reg.create('cat')
      vi.advanceTimersByTime(30 * 60_000 + 1)
      expect(reg.get(id)!.status).toBe('failed')
    })

    it('30 分钟内的 running 任务不受影响', async () => {
      vi.useFakeTimers()
      const reg = new ImageTaskManager()
      const id = reg.create('cat')
      vi.advanceTimersByTime(29 * 60_000)
      expect(reg.get(id)!.status).toBe('running')
    })

    it('迟到的真实终态到达已过期任务时被幂等忽略（不覆盖 failed）', () => {
      vi.useFakeTimers()
      const reg = new ImageTaskManager()
      const id = reg.create('cat')
      vi.advanceTimersByTime(30 * 60_000 + 1)
      expect(reg.get(id)!.status).toBe('failed')
      reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true } })
      expect(reg.get(id)!.status).toBe('failed')
    })
  })
})
