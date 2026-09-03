// 使用明细的数据层。
//
// 之所以把它从 `UsageDrawer` 里拆出来单测,是因为这一层最容易写错、又最不可能从
// 截图上看出来的两件事都与 UI 无关:
// - **竞态弃用守卫**:切了时间范围,慢的那个旧响应后到、把新范围的数据盖掉 ——
//   界面看起来一切正常,只是数字是上一个范围的。
// - **轮询生命周期**:关抽屉没停表,后台每 10 秒继续打一次后端,用户毫无察觉。
//
// mock 一律按 `src/types/authApi.ts` 的**类型**造,不按「实现里是怎么读的」造。
// 上游任务在这上面栽过一次(计划 §1.3:查单响应实际多包一层 `data.order`,测试用了
// 扁平 mock,于是测试与同样漏剥一层的实现一起全绿)。

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  QuotaRpc,
  UsageLogPage,
  UsageLogRow,
  UsageModelSummary,
} from '../../../../../types/authApi'
import type { Pool } from '../../../stores/useQuotaStore'
import {
  QUOTA_PER_YUAN,
  USAGE_PAGE_SIZE,
  USAGE_POLL_MS,
  formatQuotaCny,
  rangeToWindow,
  useUsageData,
} from '../useUsageData'

const POOL: Pool = { projectId: 342, producerProjectId: null }

/** 一条正常消费。字段齐全,照 `UsageLogRow` 的类型逐个填。 */
const ROW_CONSUME: UsageLogRow = {
  id: 9001,
  createdAt: 1_700_000_000,
  type: 2,
  modelName: 'gemini-3.1-flash-image-preview',
  quota: 25_000,
  promptTokens: 1200,
  completionTokens: 340,
  feature: 'image_gen',
  tokenName: 'desktop',
  projectId: 342,
  producerProjectId: null,
  content: '图片 generate',
}

/**
 * 一条退款。
 *
 * `quota` 为负、`modelName` 是空串(明细里 `modelName` 的类型是 `string` 不是
 * `string | null` —— 与汇总的 `modelName: string | null` 刻意不同,别互相照抄)。
 */
const ROW_REFUND: UsageLogRow = {
  id: 9002,
  createdAt: 1_700_000_600,
  type: 6,
  modelName: '',
  quota: -20_000,
  promptTokens: 0,
  completionTokens: 0,
  feature: null,
  tokenName: null,
  projectId: 342,
  producerProjectId: null,
  content: '视频任务失败退款 task_a1b2',
}

const SUMMARY: UsageModelSummary[] = [
  { modelName: 'gemini-3.1-flash-image-preview', totalQuota: 25_000, totalRequests: 3, totalTokens: 1540 },
  // 后端 GROUP BY 出来的那一组可以是 NULL。
  { modelName: null, totalQuota: 5_000, totalRequests: 1, totalTokens: 120 },
]

function logPage(
  rows: UsageLogRow[],
  over: Partial<Omit<UsageLogPage, 'rows'>> = {},
): UsageLogPage {
  return { rows, total: rows.length, page: 0, pageSize: USAGE_PAGE_SIZE, ...over }
}

function ok<T>(data: T): QuotaRpc<T> {
  return { ok: true, data }
}

function fail(code: string, message: string): QuotaRpc<never> {
  return { ok: false, error: { code, message } }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const auth = {
  getUsageLogs: vi.fn(),
  getUsageSummary: vi.fn(),
}

/**
 * 把微任务队列排干。
 *
 * 不用 `waitFor`:@testing-library 的 `waitFor` 在 vitest 的假定时器下检测不到
 * (它只认 `jest` 全局),会用被假掉的 `setInterval` 轮询自己,于是永远等不到。
 * 轮询相关的用例必须用假定时器,所以统一走这个手动 flush。
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth }, configurable: true })
  auth.getUsageLogs.mockReset().mockResolvedValue(ok(logPage([ROW_CONSUME])))
  auth.getUsageSummary.mockReset().mockResolvedValue(ok(SUMMARY))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('rangeToWindow', () => {
  // 后端 `startTime`/`endTime` 收的是 **Unix 秒**;送毫秒过去不会报错,只会查出空 ——
  // 1.7e12 秒是公元 55000 年。
  it('给的是 Unix 秒不是毫秒', () => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0)
    const w = rangeToWindow('7d', now)
    expect(w.endTime).toBe(Math.floor(now / 1000))
    expect(Number.isInteger(w.startTime)).toBe(true)
    expect(w.startTime!).toBeLessThan(w.endTime!)
  })

  it('「全部」两个参数都不传', () => {
    expect(rangeToWindow('all', Date.now())).toEqual({})
  })

  it('今天的窗口不超过一天,7 天 / 30 天各自至少覆盖那么久', () => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0)
    const today = rangeToWindow('today', now)
    expect(today.endTime! - today.startTime!).toBeLessThanOrEqual(86_400)

    expect(rangeToWindow('7d', now).endTime! - rangeToWindow('7d', now).startTime!).toBeGreaterThanOrEqual(7 * 86_400)
    expect(rangeToWindow('30d', now).endTime! - rangeToWindow('30d', now).startTime!).toBeGreaterThanOrEqual(30 * 86_400)
  })
})

describe('formatQuotaCny', () => {
  it('按 500000 换算并保留 4 位小数', () => {
    expect(QUOTA_PER_YUAN).toBe(500_000)
    expect(formatQuotaCny(25_000)).toBe('0.0500')
  })

  // 与网页端一致:小到 4 位小数都显示不出区分度时给 `<0.01`,而不是一排 `0.0020`
  // 让用户以为是同一笔。
  it('0 < v < 0.01 显示 <0.01', () => {
    expect(formatQuotaCny(1_000)).toBe('<0.01')
  })

  it('0 如实显示 0.0000,不落进 <0.01 分支', () => {
    expect(formatQuotaCny(0)).toBe('0.0000')
  })
})

describe('useUsageData', () => {
  it('抽屉没开时一个请求都不发', async () => {
    renderHook(() => useUsageData({ open: false, pool: POOL }))
    await flush()
    expect(auth.getUsageLogs).not.toHaveBeenCalled()
    expect(auth.getUsageSummary).not.toHaveBeenCalled()
  })

  // 用量接口 `projectId` 必填才有意义 —— 没选池就发等于查了个不存在的过滤条件。
  it('没选池时一个请求都不发', async () => {
    renderHook(() => useUsageData({ open: true, pool: null }))
    await flush()
    expect(auth.getUsageLogs).not.toHaveBeenCalled()
  })

  it('打开后并行拉明细与汇总,明细带分页参数、汇总不带', async () => {
    renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(1))

    const logsArg = auth.getUsageLogs.mock.calls[0][0]
    expect(logsArg).toEqual({
      projectId: 342,
      page: 0,
      pageSize: USAGE_PAGE_SIZE,
      startTime: expect.any(Number),
      endTime: expect.any(Number),
    })

    // `toEqual` 的整对象断言在这里是刻意的:汇总端点**不收** page/pageSize,
    // 多带过去不会报错,只会让人以为汇总是分页的。
    const sumArg = auth.getUsageSummary.mock.calls[0][0]
    expect(sumArg).toEqual({
      projectId: 342,
      startTime: expect.any(Number),
      endTime: expect.any(Number),
    })
  })

  it('「全部」范围时两个时间参数一个都不发', async () => {
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(1))

    act(() => result.current.setRange('all'))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(2))

    expect(auth.getUsageLogs.mock.calls[1][0]).toEqual({
      projectId: 342,
      page: 0,
      pageSize: USAGE_PAGE_SIZE,
    })
  })

  // 后端只给按模型分组的数组,没有顶层合计 —— 三个数字必须前端 reduce。
  it('汇总的三个数字由前端 reduce 出来', async () => {
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(result.current.summary.length).toBe(2))

    expect(result.current.totalQuota).toBe(30_000)
    expect(result.current.totalRequests).toBe(4)
    expect(result.current.totalTokens).toBe(1660)
  })

  /**
   * 竞态弃用守卫。
   *
   * 缺了它,一次慢响应会覆盖后发的快响应 —— 用户切了范围/翻了页,看到的却是上一次
   * 查询的结果,而且没有任何报错。这里让后发的 B 先回、先发的 A 后回,断言最终 state
   * 是 B 的。
   */
  it('先发的慢响应后到时被丢弃,state 留的是后发那次的数据', async () => {
    const a = deferred<QuotaRpc<UsageLogPage>>()
    const b = deferred<QuotaRpc<UsageLogPage>>()
    auth.getUsageLogs.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(1))

    act(() => result.current.setPage(1))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(2))

    // B（后发）先回
    b.resolve(ok(logPage([ROW_REFUND], { page: 1, total: 2 })))
    await flush()
    expect(result.current.rows.map((r) => r.id)).toEqual([ROW_REFUND.id])

    // A（先发）后回 —— 必须被丢弃
    a.resolve(ok(logPage([ROW_CONSUME], { page: 0, total: 2 })))
    await flush()
    expect(result.current.rows.map((r) => r.id)).toEqual([ROW_REFUND.id])
  })

  /**
   * 切时间范围要把 page 归零。
   *
   * 不归零的话:停在第 5 页切到「今天」,后端按 offset 250 查一个只有 3 条的集合,
   * 返回空数组 —— 用户看到「暂无记录」,而数据其实好端端躺在第 1 页。
   */
  it('切换时间范围时 page 归零', async () => {
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(1))

    act(() => result.current.setPage(4))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(2))
    expect(auth.getUsageLogs.mock.calls[1][0].page).toBe(4)

    act(() => result.current.setRange('30d'))
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(3))

    expect(auth.getUsageLogs.mock.calls[2][0].page).toBe(0)
    expect(result.current.page).toBe(0)
  })

  /**
   * 总页数的除数必须取**响应回来的** `pageSize`。
   *
   * 主进程在缺 `page_size` 时回落到本次实际送出的值(`session.ts:530`),所以它保证非 0;
   * 但它未必等于本层请求的 50 —— 后端硬上限是 100、默认是 20,用自己的常量当除数会
   * 在这两种情况下把页数算错。
   */
  it('总页数用响应里的 pageSize 而不是本地常量', async () => {
    auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CONSUME], { total: 45, pageSize: 20 })))
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(result.current.total).toBe(45))

    expect(result.current.pageSize).toBe(20)
    expect(result.current.totalPages).toBe(3)
  })

  it('打开期间每 10 秒刷新一次', async () => {
    vi.useFakeTimers()
    renderHook(() => useUsageData({ open: true, pool: POOL }))
    await flush()
    expect(auth.getUsageLogs).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
    })
    expect(auth.getUsageLogs).toHaveBeenCalledTimes(2)
  })

  // 关抽屉必须停表。漏了的话后台每 10 秒继续打一次后端,用户完全看不见。
  it('关闭后不再发请求', async () => {
    vi.useFakeTimers()
    const { rerender } = renderHook(({ open }) => useUsageData({ open, pool: POOL }), {
      initialProps: { open: true },
    })
    await flush()
    expect(auth.getUsageLogs).toHaveBeenCalledTimes(1)

    rerender({ open: false })
    await flush()
    const before = auth.getUsageLogs.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 6)
    })
    expect(auth.getUsageLogs).toHaveBeenCalledTimes(before)
  })

  /**
   * 两个请求各自的失败要各自呈现。
   *
   * 网页端把两个都 `.catch(() => null)`(`UsageDrawer.tsx:99-100`),失败后显示
   * 「暂无记录」—— 用户区分不了「真的没花钱」和「接口挂了」。
   */
  it('明细失败、汇总成功时,只有明细报错,汇总照常出数', async () => {
    auth.getUsageLogs.mockResolvedValue(fail('HTTP_403', '无权访问该项目'))
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(result.current.logsError).toBe('无权访问该项目'))

    expect(result.current.rows).toEqual([])
    expect(result.current.summaryError).toBeNull()
    expect(result.current.totalRequests).toBe(4)
  })

  it('汇总失败、明细成功时,只有汇总报错,列表照常出数', async () => {
    auth.getUsageSummary.mockResolvedValue(fail('NOT_AUTHENTICATED', '登录已过期,请重新登录'))
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(result.current.summaryError).toBe('登录已过期,请重新登录'))

    expect(result.current.logsError).toBeNull()
    expect(result.current.rows.map((r) => r.id)).toEqual([ROW_CONSUME.id])
    expect(result.current.totalQuota).toBe(0)
  })

  // 重试成功要把上一次的错误清掉,否则错误条会一直挂在那儿。
  it('重试成功后清掉上一次的错误', async () => {
    auth.getUsageLogs.mockResolvedValue(fail('HTTP_500', '服务暂时不可用'))
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(result.current.logsError).toBe('服务暂时不可用'))

    auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CONSUME])))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.logsError).toBeNull())
    expect(result.current.rows.length).toBe(1)
  })

  // 桥本身抛(preload 没挂上、通道没注册)也要落成可显示的错误,不能整个 hook 静默死掉。
  it('桥抛异常时也落成错误文案而不是白屏', async () => {
    auth.getUsageLogs.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useUsageData({ open: true, pool: POOL }))
    await waitFor(() => expect(result.current.logsError).toBeTruthy())
    expect(result.current.logsError).toContain('boom')
  })
})
