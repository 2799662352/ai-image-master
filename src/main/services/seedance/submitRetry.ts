/**
 * 提交生成任务的重试策略。
 *
 * 和 downloadRetry 一样单独成文件,是为了脱开 Electron 的 net 直接测。但这里的
 * 分寸比"失败就重试"微妙得多,值得把理由写下来:
 *
 * createTask 是 POST,上游既没有幂等键,也没有"按客户端请求号反查任务"的接口。
 * 如果请求其实已经抵达上游、只是回程丢了,重试就会建出第二个任务 —— 双倍计费,
 * 而且第一个任务的 id 我们永远拿不到,它会一直跑到完成然后没人认领。
 *
 * 所以只重试**能确定上游没受理**的两类失败:
 *   1. 上游明确回了 408/425/429/5xx —— 有响应就说明这一轮来回走完了,任务没建成;
 *   2. 连接压根没建起来(DNS 解析不了、连接被拒、网络不可达、连接超时)——
 *      请求体从未离开本机。
 *
 * 刻意**不**重试"连上之后才断"的那一类(ECONNRESET / socket hang up / 空响应)
 * 和我们自己的 30 秒超时:它们无法区分"上游没收到"与"上游收了但回程丢了",
 * 宁可让用户看到一次失败自己决定,也不替他冒双倍计费的风险。
 */

import { SeedanceApiError } from './apiError'

/**
 * 连接建立阶段就失败的错误码 —— 到这一步请求体一个字节都没发出去,重发绝对安全。
 * Node/libuv 的码来自 `err.code`;Electron 的 net.fetch 走 Chromium 网络栈,错误以
 * `net::ERR_*` 的形式出现在消息里,两种都要认。
 */
const PRE_SEND_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_DNS_TIMED_OUT',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_ADDRESS_UNREACHABLE',
])

/** 总尝试次数(含首次)。 */
export const SUBMIT_ATTEMPTS = 3
const SUBMIT_BASE_DELAY_MS = 800
const SUBMIT_MAX_DELAY_MS = 6_000

/**
 * 这次提交失败,能不能安全地再发一次 —— 判据见文件头。
 */
export function isSafeToResubmit(err: unknown): boolean {
  if (err instanceof SeedanceApiError) return err.retryable

  const e = err as
    | { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } }
    | null
    | undefined
  const tokens = new Set<string>()
  for (const raw of [e?.code, e?.cause?.code]) {
    if (typeof raw === 'string') tokens.add(raw.toUpperCase())
  }
  const text = [e?.message, e?.cause?.message].filter((t): t is string => typeof t === 'string').join(' ')
  for (const match of text.toUpperCase().matchAll(/ERR_[A-Z0-9_]+/g)) tokens.add(match[0])

  for (const token of tokens) {
    if (PRE_SEND_FAILURE_CODES.has(token)) return true
  }
  return false
}

/**
 * 重试前的等待。上游给了 Retry-After 就听它的(限流场景别自作聪明),否则指数退避
 * 叠等量抖动 —— 工作台是批量场景,几十张卡几乎同时提交,上游一抖就会变成同步
 * 重试的惊群,抖动把它们打散。
 */
export function submitRetryDelayMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, SUBMIT_BASE_DELAY_MS), SUBMIT_MAX_DELAY_MS)
  }
  const ceiling = Math.min(SUBMIT_MAX_DELAY_MS, SUBMIT_BASE_DELAY_MS * 2 ** (attempt - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export interface RetrySubmitOptions {
  attempts?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * 跑一次提交,失败时按上面的判据决定是否重发。原始错误原样抛出 —— 上层
 * (runtime.translateSeedanceTaskError)靠它的类型和文案给用户解释发生了什么。
 */
export async function retrySubmit<T>(run: () => Promise<T>, options: RetrySubmitOptions = {}): Promise<T> {
  const { attempts = SUBMIT_ATTEMPTS, sleep = defaultSleep, random = Math.random } = options
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run()
    } catch (e) {
      lastError = e
      if (attempt === attempts || !isSafeToResubmit(e)) break
      const retryAfterMs = e instanceof SeedanceApiError ? e.retryAfterMs : undefined
      const delay = submitRetryDelayMs(attempt, retryAfterMs, random)
      const reason = e instanceof Error ? e.message : String(e)
      console.warn(`[seedance] 提交任务第 ${attempt}/${attempts} 次失败,${delay}ms 后重试:${reason}`)
      await sleep(delay)
    }
  }

  throw lastError
}
