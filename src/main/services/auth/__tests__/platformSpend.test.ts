import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPlatformSpendForTesting,
  notePlatformSpend,
  onPlatformSpend,
} from '../platformSpend'

describe('平台消费信号', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetPlatformSpendForTesting()
  })

  afterEach(() => {
    __resetPlatformSpendForTesting()
    vi.useRealTimers()
  })

  it('单次消费在静默窗口后通知一次', () => {
    const seen = vi.fn()
    onPlatformSpend(seen)

    notePlatformSpend()
    // 窗口未满前不该有动静 —— 提前通知就会读到扣费前的余额。
    vi.advanceTimersByTime(1199)
    expect(seen).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('突发多次只通知一次(批量九张图的场景)', () => {
    const seen = vi.fn()
    onPlatformSpend(seen)

    for (let i = 0; i < 9; i += 1) {
      notePlatformSpend()
      vi.advanceTimersByTime(50)
    }
    vi.advanceTimersByTime(1200)

    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('事件一直密于静默窗口时,仍会在上限处强制通知', () => {
    const seen = vi.fn()
    onPlatformSpend(seen)

    // 每 1000ms 报一次 —— 永远够不到 1200ms 的静默窗口。没有上限的话
    // 这个输入会让余额**永远**不刷新,而这正是用户连续出图的形状。
    for (let i = 0; i < 10; i += 1) {
      notePlatformSpend()
      vi.advanceTimersByTime(1000)
    }

    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('上限触发后重新起表,后续消费照常通知', () => {
    const seen = vi.fn()
    onPlatformSpend(seen)

    // 撑到上限触发一次。
    for (let i = 0; i < 6; i += 1) {
      notePlatformSpend()
      vi.advanceTimersByTime(1000)
    }
    const afterFirst = seen.mock.calls.length
    expect(afterFirst).toBeGreaterThanOrEqual(1)

    // 静默一段时间让在途定时器全部落地,再报一次新的。
    vi.advanceTimersByTime(10_000)
    const settled = seen.mock.calls.length

    notePlatformSpend()
    vi.advanceTimersByTime(1200)
    expect(seen.mock.calls.length).toBe(settled + 1)
  })

  it('多个监听者都收到', () => {
    const a = vi.fn()
    const b = vi.fn()
    onPlatformSpend(a)
    onPlatformSpend(b)

    notePlatformSpend()
    vi.advanceTimersByTime(1200)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('退订后不再收到', () => {
    const seen = vi.fn()
    const off = onPlatformSpend(seen)
    off()

    notePlatformSpend()
    vi.advanceTimersByTime(1200)

    expect(seen).not.toHaveBeenCalled()
  })

  it('一个监听者抛错不影响其余的', () => {
    const boom = vi.fn(() => {
      throw new Error('nope')
    })
    const ok = vi.fn()
    onPlatformSpend(boom)
    onPlatformSpend(ok)

    notePlatformSpend()
    expect(() => vi.advanceTimersByTime(1200)).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('监听者在回调里退订不会打断这一轮派发', () => {
    const ok = vi.fn()
    let off: (() => void) | undefined
    // 登出时会走到这个形状:收到信号 → 判断已登出 → 顺手退订。
    off = onPlatformSpend(() => {
      off?.()
    })
    onPlatformSpend(ok)

    notePlatformSpend()
    expect(() => vi.advanceTimersByTime(1200)).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('没有消费就不会凭空通知', () => {
    const seen = vi.fn()
    onPlatformSpend(seen)

    vi.advanceTimersByTime(60_000)

    expect(seen).not.toHaveBeenCalled()
  })
})
