// 触发节奏:防抖 / 最长等待 / 单飞 / 封印 / 离开页面时 flush。定时器注入,不用真等。
import { describe, expect, it, vi } from 'vitest'
import type { BackupPassResult } from '../cloudBackup'
import { createBackupScheduler, type SchedulerTimers } from '../cloudBackupScheduler'

function fakeTimers() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: SchedulerTimers = {
    now: () => now,
    set: (fn, ms) => {
      seq += 1
      pending.set(seq, { at: now + ms, fn })
      return seq
    },
    clear: (h) => {
      pending.delete(h as number)
    },
  }
  return {
    timers,
    pendingCount: () => pending.size,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
  }
}

const ok = (over: Partial<BackupPassResult> = {}): BackupPassResult => ({
  uploaded: 1, unchanged: 0, empty: 0, localOnly: 0, failures: [], stopped: null, ...over,
})

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function setup(over: Partial<Parameters<typeof createBackupScheduler>[0]> = {}) {
  const t = fakeTimers()
  const run = vi.fn(async () => ok())
  const onResult = vi.fn()
  const onPending = vi.fn()
  const s = createBackupScheduler({
    run,
    isEnabled: () => true,
    onResult,
    onPending,
    debounceMs: 1000,
    maxWaitMs: 5000,
    timers: t.timers,
    ...over,
  })
  return { t, run, onResult, onPending, s }
}

describe('createBackupScheduler', () => {
  it('防抖:连续改动只在最后一次安静 debounce 之后跑一轮', async () => {
    const { t, run, s } = setup()
    s.notify()
    t.advance(600)
    s.notify()
    t.advance(600)
    expect(run).not.toHaveBeenCalled()
    t.advance(500)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('最长等待:改动一直在来(生成进度回流)也不会被无限顶后', async () => {
    const { t, run, s } = setup()
    // 每 800ms 一次改动,永远等不到 1000ms 的安静;5000ms 上限一到就必须跑
    for (let i = 0; i < 6; i += 1) {
      s.notify()
      t.advance(800)
    }
    t.advance(300)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('单飞:跑的时候又来改动 → 不并发,跑完补一轮', async () => {
    let release: () => void = () => {}
    const run = vi.fn(
      () => new Promise<BackupPassResult>((resolve) => { release = () => resolve(ok()) }),
    )
    const { t, s } = setup({ run })
    s.notify()
    t.advance(1000)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)

    s.notify()
    t.advance(1000)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)

    release()
    await settle()
    t.advance(1000)
    await settle()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('关掉自动备份 / 当前不能备份(没登录)→ notify 不起定时器;手动立即备份仍可用', async () => {
    let enabled = false
    let can = true
    const { t, run, s } = setup({ isEnabled: () => enabled, canRun: () => can })
    s.notify()
    expect(t.pendingCount()).toBe(0)
    enabled = true
    can = false
    s.notify()
    expect(t.pendingCount()).toBe(0)
    enabled = false
    can = true
    await s.runNow()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('服务端没开 → 本会话不再自动排;手动立即备份解除封印再试', async () => {
    const run = vi.fn(async () => ok({ uploaded: 0, stopped: 'NOT_CONFIGURED' }))
    const { t, s } = setup({ run })
    s.notify()
    t.advance(1000)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)

    s.notify()
    expect(t.pendingCount()).toBe(0)

    run.mockResolvedValueOnce(ok())
    await s.runNow()
    expect(run).toHaveBeenCalledTimes(2)
    s.notify()
    expect(t.pendingCount()).toBe(1)
  })

  it('未登录(NOT_AUTHENTICATED)不封印:登录后下一次改动照常排', async () => {
    const run = vi.fn(async () => ok({ uploaded: 0, stopped: 'NOT_AUTHENTICATED' }))
    const { t, s } = setup({ run })
    s.notify()
    t.advance(1000)
    await settle()
    s.notify()
    expect(t.pendingCount()).toBe(1)
  })

  it('离开页面:有待传改动就立刻起一轮;没有就什么都不做;dispose 后不再排', async () => {
    const a = setup()
    a.s.flush()
    expect(a.run).not.toHaveBeenCalled()

    const b = setup()
    b.s.notify()
    b.s.flush()
    await settle()
    expect(b.run).toHaveBeenCalledTimes(1)
    b.s.dispose()
    b.s.notify()
    expect(b.t.pendingCount()).toBe(0)
  })

  it('run 抛异常 → onError,调度器还活着,下次改动照常排', async () => {
    const onError = vi.fn()
    const run = vi.fn(async () => {
      throw new Error('boom')
    })
    const { t, s } = setup({ run, onError })
    s.notify()
    t.advance(1000)
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)
    s.notify()
    expect(t.pendingCount()).toBe(1)
  })

  it('reset:解除封印并丢弃待传(账号切换)', async () => {
    const run = vi.fn(async () => ok({ uploaded: 0, stopped: 'NOT_CONFIGURED' }))
    const { t, s } = setup({ run })
    s.notify()
    t.advance(1000)
    await settle()
    s.reset()
    s.notify()
    expect(t.pendingCount()).toBe(1)
    s.reset()
    expect(t.pendingCount()).toBe(0)
  })
})
