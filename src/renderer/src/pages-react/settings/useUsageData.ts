// 使用明细抽屉的数据层。
//
// 从 `UsageDrawer` 里拆出来单独成文件,是为了让两件与 UI 无关、又最容易悄悄坏掉的事
// 能被独立钉住:**竞态弃用守卫**与**轮询生命周期**。两者坏掉时界面都不报错 ——
// 一个显示上一次查询的数据,一个在关掉抽屉后继续打后端。混在组件里只能靠渲染断言间接测,
// 一旦布局改动就跟着碎。
//
// 主进程刻意回 `QuotaRpc` 信封而不是裸抛(裸抛经 IPC 会被包成 "Error invoking remote
// method '…'",后端 code 全丢)。所以这一层的主路径是**解信封**,不是 try/catch ——
// try/catch 只用来兜「桥本身没挂上」这种非预期情况。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  QuotaRpc,
  UsageLogPage,
  UsageLogRow,
  UsageModelSummary,
  UsageQuery,
} from '../../../../types/authApi'
import type { Pool } from '../../stores/useQuotaStore'

/**
 * 500000 quota = ¥1。
 *
 * 真源是后端 `new-api/common/constants.go:41` 的 `QuotaPerUnit`,主进程也有一份
 * (`services/auth/session.ts:221` 的 `QUOTA_PER_YUAN`)。
 *
 * ⚠️ **漂移风险是真实的**:后端那是 `var` 不是 `const`,运行时可改,而且**没有任何 API
 * 下发它**。渲染层不能 import 主进程模块,所以这里只能再硬编码一份 —— 改了后端要记得
 * 同时改这两处。第二期若给用量接口加上「已换算成元」的字段,这个常量就该删掉。
 */
export const QUOTA_PER_YUAN = 500_000

/**
 * 每页 50 条。
 *
 * 这是**请求**用的值;算总页数必须用**响应回来的** `pageSize`(见 `totalPages`)——
 * 后端默认 20、硬上限 100,两边不一定相等。
 */
export const USAGE_PAGE_SIZE = 50

/** 与网页端一致的 10 秒。明细是用户盯着看的实时数据,不做缓存。 */
export const USAGE_POLL_MS = 10_000

/** 退款的 log type。完整枚举见后端 `log.go:53-61`。 */
export const LOG_TYPE_REFUND = 6

export type UsageRange = 'today' | '7d' | '30d' | 'all'

export const USAGE_RANGES: { value: UsageRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7天' },
  { value: '30d', label: '30天' },
  { value: 'all', label: '全部' },
]

/**
 * 金额格式化。
 *
 * 与网页端 `sora-ui/src/components/UsageDrawer.tsx:11-14` 逐条对齐(÷500000、4 位小数、
 * `0 < v < 0.01` 折成 `<0.01`)—— 同一笔钱在两个客户端显示成不同数字,比两处都难看糟得多。
 *
 * **不处理符号。** 退款行的 `+` 前缀由调用方拼(见 `UsageDrawer` 的 `amountText`):
 * 把负号和 `+` 直接连起来会得到 `+¥-0.0400`,一个自相矛盾的字符串。
 */
export function formatQuotaCny(quota: number): string {
  const v = quota / QUOTA_PER_YUAN
  // `v > 0` 不能省:真的是 0 要显示 `0.0000`,折成 `<0.01` 会把「没花钱」说成「花了一点」。
  if (v > 0 && v < 0.01) return '<0.01'
  return v.toFixed(4)
}

/** `MM-DD HH:mm`。`createdAt` 是 Unix **秒**,不乘 1000 会把所有记录显示成 1970 年。 */
export function formatUsageTime(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 快捷时间范围 → 查询窗口。
 *
 * 返回的是 **Unix 秒**:后端 `startTime`/`endTime` 收秒,送毫秒过去不会报错,只会查出
 * 空集合(1.7e12 秒是公元 55000 年)。
 *
 * 「全部」两个字段**一个都不带** —— 后端是 `>0 才生效`,带个 0 过去与不带等价但更容易
 * 让人以为是「从纪元开始」这种显式语义。
 */
export function rangeToWindow(
  range: UsageRange,
  nowMs: number = Date.now(),
): { startTime?: number; endTime?: number } {
  if (range === 'all') return {}

  const endTime = Math.floor(nowMs / 1000)
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)
  if (range === '7d') start.setDate(start.getDate() - 7)
  if (range === '30d') start.setDate(start.getDate() - 30)

  return { startTime: Math.floor(start.getTime() / 1000), endTime }
}

type UsageApi = {
  getUsageLogs: (query: UsageQuery) => Promise<QuotaRpc<UsageLogPage>>
  getUsageSummary: (query: UsageQuery) => Promise<QuotaRpc<UsageModelSummary[]>>
}

function getApi(): UsageApi | undefined {
  return (window as Window & { electronAPI?: { auth?: UsageApi } }).electronAPI?.auth
}

/**
 * 桥本身抛出时(preload 没挂上、通道没注册)合成一个信封。
 *
 * 这**不是**错误处理的主路径 —— 业务失败走的是主进程回的 `{ok:false,error}`。这里兜的是
 * 「连信封都没拿到」,不兜的话整个 `Promise.all` 被拒,hook 静默停在加载态。
 */
async function envelope<T>(call: () => Promise<QuotaRpc<T>>): Promise<QuotaRpc<T>> {
  try {
    return await call()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: { code: 'BRIDGE_FAILED', message: `无法与主进程通信:${message}` } }
  }
}

interface UsageSnapshot {
  rows: UsageLogRow[]
  total: number
  /** 服务端回的每页条数,算总页数用它。 */
  pageSize: number
  summary: UsageModelSummary[]
  logsError: string | null
  summaryError: string | null
  loading: boolean
}

const EMPTY: UsageSnapshot = {
  rows: [],
  total: 0,
  pageSize: USAGE_PAGE_SIZE,
  summary: [],
  logsError: null,
  summaryError: null,
  // 首帧就是加载态:初值给 false 会让抽屉打开的第一帧闪一下「暂无记录」。
  loading: true,
}

export interface UsageData extends UsageSnapshot {
  range: UsageRange
  setRange: (r: UsageRange) => void
  page: number
  setPage: (p: number) => void
  totalPages: number
  /** 汇总数组前端 reduce 出来的三个数。后端只给按模型分组的行,没有顶层合计。 */
  totalQuota: number
  totalRequests: number
  totalTokens: number
  refresh: () => void
}

export function useUsageData({ open, pool }: { open: boolean; pool: Pool | null }): UsageData {
  const [range, setRangeState] = useState<UsageRange>('today')
  const [page, setPage] = useState(0)
  const [snap, setSnap] = useState<UsageSnapshot>(EMPTY)

  /**
   * 单调递增的请求序号。只有最新一次请求的结果允许写 state。
   *
   * 没有它:用户切到「7天」,而「今天」那次的慢响应后到,把 7 天的数据盖成今天的 ——
   * 界面一切正常,只是数字属于另一个查询。轮询让这件事几乎必然发生(每 10 秒一次机会)。
   */
  const reqSeqRef = useRef(0)

  // **依赖取原始值而不是 pool 对象**:调用方很可能就地构造 `{projectId, producerProjectId}`,
  // 对象每次渲染都是新引用,拿它当 useCallback 依赖会让 fetch 每帧重发一次。
  const projectId = pool ? pool.projectId : null

  const fetchAll = useCallback(async () => {
    const api = getApi()
    if (!api || projectId === null) return

    const seq = ++reqSeqRef.current
    setSnap((s) => ({ ...s, loading: true }))

    const span = rangeToWindow(range)
    // 汇总端点**不收** page/pageSize —— 只有明细那次才展开分页参数。
    const base: UsageQuery = { projectId, ...span }

    const [logsRes, sumRes] = await Promise.all([
      envelope(() => api.getUsageLogs({ ...base, page, pageSize: USAGE_PAGE_SIZE })),
      envelope(() => api.getUsageSummary(base)),
    ])

    if (seq !== reqSeqRef.current) return

    /**
     * 失败的那一半**清空数据**而不是留着旧值。
     *
     * 留旧值 + 一条错误条看着更"友好",但这次失败很可能正是由切换范围/翻页触发的 ——
     * 旧值属于**另一个查询**,配着新的筛选条件显示出来比空着更误导。两个请求各自成败,
     * 所以两个 error 字段也各自独立:一个挂了不该把另一个的结果一起吞掉。
     */
    setSnap({
      loading: false,
      rows: logsRes.ok ? logsRes.data.rows : [],
      total: logsRes.ok ? logsRes.data.total : 0,
      // 主进程在后端缺 `page_size` 时回落到本次实际送出的值(`session.ts:530`),
      // 所以它保证非 0;这里的 `> 0` 只是不让一个坏值把总页数算成 Infinity。
      pageSize: logsRes.ok && logsRes.data.pageSize > 0 ? logsRes.data.pageSize : USAGE_PAGE_SIZE,
      logsError: logsRes.ok ? null : logsRes.error.message,
      summary: sumRes.ok ? sumRes.data : [],
      summaryError: sumRes.ok ? null : sumRes.error.message,
    })
  }, [projectId, range, page])

  useEffect(() => {
    if (!open) return undefined

    void fetchAll()
    const id = window.setInterval(() => void fetchAll(), USAGE_POLL_MS)

    return () => {
      // 关抽屉必须停表。漏了的话后台每 10 秒继续打一次后端,用户完全看不见。
      window.clearInterval(id)
      // 顺手把序号推进一格:在途的那次回来时已不是最新,不会再写进一个用户已经看不到的界面。
      reqSeqRef.current += 1
    }
  }, [open, fetchAll])

  const setRange = useCallback((r: UsageRange) => {
    setRangeState(r)
    // **必须归零。** 停在第 5 页切到「今天」时,后端按 offset 250 去查一个只有 3 条的
    // 集合,回空数组 —— 用户看到「暂无记录」,而数据好端端躺在第 1 页。
    setPage(0)
  }, [])

  const refresh = useCallback(() => void fetchAll(), [fetchAll])

  const totals = useMemo(() => {
    let quota = 0
    let requests = 0
    let tokens = 0
    for (const s of snap.summary) {
      quota += s.totalQuota
      requests += s.totalRequests
      tokens += s.totalTokens
    }
    return { quota, requests, tokens }
  }, [snap.summary])

  const totalPages = useMemo(() => {
    // 除数取响应里的 pageSize,不是上面那个请求用的常量 —— 两者不一定相等。
    const size = snap.pageSize > 0 ? snap.pageSize : USAGE_PAGE_SIZE
    return Math.max(1, Math.ceil(snap.total / size))
  }, [snap.total, snap.pageSize])

  return {
    ...snap,
    range,
    setRange,
    page,
    setPage,
    totalPages,
    totalQuota: totals.quota,
    totalRequests: totals.requests,
    totalTokens: totals.tokens,
    refresh,
  }
}
