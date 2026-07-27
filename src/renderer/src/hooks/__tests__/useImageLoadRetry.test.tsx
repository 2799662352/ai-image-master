import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useImageLoadRetry } from '../useImageLoadRetry'

/**
 * 远端图加载失败要能自愈。
 *
 * 生成结果先以模型直出的临时 URL 展示,再热切到 COS,历史页则可能拉几十张缩图 ——
 * 一次网络抖动就让 `<img>` 永久停在裂图上,而图本身好好的。
 *
 * 重试靠**重新挂载**,绝不改 URL:模型直出与 COS 都是预签名地址,加一个
 * `?t=` 缓存穿透参数会让签名失效,把"可能还能加载"直接变成必定 403。
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useImageLoadRetry', () => {
  it('加载失败后按退避重挂,不立刻判死', () => {
    const { result } = renderHook(() => useImageLoadRetry('https://cdn/a.png', {
      maxRetries: 2,
      baseDelayMs: 500,
    }))
    const firstKey = result.current.reloadKey

    act(() => { result.current.onError() })
    expect(result.current.failed).toBe(false)
    expect(result.current.reloadKey).toBe(firstKey)

    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.reloadKey).not.toBe(firstKey)
    expect(result.current.failed).toBe(false)
  })

  it('退避是递增的:第二次等得更久', () => {
    const { result } = renderHook(() => useImageLoadRetry('https://cdn/a.png', {
      maxRetries: 3,
      baseDelayMs: 500,
    }))

    act(() => { result.current.onError() })
    act(() => { vi.advanceTimersByTime(500) })
    const afterFirst = result.current.reloadKey

    act(() => { result.current.onError() })
    act(() => { vi.advanceTimersByTime(500) })
    // 第二次退避 1000ms,500ms 时还不该重挂。
    expect(result.current.reloadKey).toBe(afterFirst)

    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.reloadKey).not.toBe(afterFirst)
  })

  it('重试用尽后判死,调用方据此显示占位', () => {
    const { result } = renderHook(() => useImageLoadRetry('https://cdn/a.png', {
      maxRetries: 1,
      baseDelayMs: 100,
    }))

    act(() => { result.current.onError() })
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current.failed).toBe(false)

    act(() => { result.current.onError() })
    expect(result.current.failed).toBe(true)

    // 判死之后不再重挂,否则一张 404 会无限刷请求。
    const settled = result.current.reloadKey
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(result.current.reloadKey).toBe(settled)
  })

  it('换图时重新开始:热切到 COS 后不该继承上一张的失败', () => {
    const { result, rerender } = renderHook(
      ({ src }) => useImageLoadRetry(src, { maxRetries: 1, baseDelayMs: 100 }),
      { initialProps: { src: 'https://model/tmp.png' } },
    )

    act(() => { result.current.onError() })
    act(() => { vi.advanceTimersByTime(100) })
    act(() => { result.current.onError() })
    expect(result.current.failed).toBe(true)

    rerender({ src: 'https://cos/final.png' })
    expect(result.current.failed).toBe(false)
  })

  it('卸载时不留下待触发的定时器', () => {
    const { result, unmount } = renderHook(() => useImageLoadRetry('https://cdn/a.png'))

    act(() => { result.current.onError() })
    unmount()

    // 定时器若还活着,回调会对已卸载组件 setState(React 会告警)。
    expect(() => { vi.advanceTimersByTime(60_000) }).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
