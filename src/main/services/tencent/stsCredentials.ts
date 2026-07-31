// src/main/services/tencent/stsCredentials.ts
//
// Fetches short-lived STS credentials from the SCF "sts-cos" function URL and
// caches them in-process. The permanent sub-account key never reaches the
// client — the endpoint hands back a 30-minute token whose power depends on
// the requested scope:
//
//   'image-history' (default) — PutObject under `image-history/*` only.
//   'media'                   — smart-erase/* + storyboard-split/* COS rw/del
//                               in the media bucket + MPS submit/poll, which
//                               lets 智能去字幕/分镜切图 run with zero user keys.
//
// See serverless/sts-cos/ for the function that issues these tokens.

export type StsScope = 'image-history' | 'media'

export interface StsCredentials {
  tmpSecretId: string
  tmpSecretKey: string
  sessionToken: string
  startTime: number
  expiredTime: number
  bucket: string
  region: string
}

// SCF Function URL. Override via COS_STS_ENDPOINT if the function is redeployed
// under a different URL.
const DEFAULT_STS_ENDPOINT = 'https://1345773498-bfu1wpfnrt.ap-guangzhou.tencentscf.com'

function getEndpoint(): string {
  return process.env.COS_STS_ENDPOINT || DEFAULT_STS_ENDPOINT
}

// Refresh when fewer than this many seconds remain before expiry, so an upload
// never starts with a token that's about to die mid-flight.
const REFRESH_SKEW_SECONDS = 300

// Hard timeout for the STS fetch so a hung endpoint can't wedge an upload.
const FETCH_TIMEOUT_MS = 10_000

/**
 * 取票据是**幂等**的(SCF 每次现签一张新的短期票),所以网络层抖动可以放心重发。
 * 这一层重试很关键:票据拿不到会被 COS SDK 转成一句 403 AccessDenied,而 403 不在
 * 中转重试的白名单里 —— 也就是说少了这层,上传那 3 次重试在"STS 抖了一下"这个
 * 最常见的失败模式下一次都用不上。批量出片时更要命:并发调用共享同一个 in-flight
 * 请求,一次失败会同时打掉当时所有排队的上传。
 */
const FETCH_ATTEMPTS = 3
const FETCH_BASE_DELAY_MS = 400
const FETCH_MAX_DELAY_MS = 4_000

/** 取票据失败。`transient` 表示"再试一次可能就好了"(网络/超时/5xx)。 */
export class StsCredentialError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'StsCredentialError'
  }
}

export function stsRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(FETCH_MAX_DELAY_MS, FETCH_BASE_DELAY_MS * 2 ** (attempt - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

const cached = new Map<StsScope, StsCredentials>()
const inflight = new Map<StsScope, Promise<StsCredentials>>()

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isFresh(c: StsCredentials | undefined): c is StsCredentials {
  if (!c) return false
  return c.expiredTime - nowSeconds() > REFRESH_SKEW_SECONDS
}

async function fetchOnce(scope: StsScope): Promise<StsCredentials> {
  const base = getEndpoint()
  // scope 同时走 query + body:函数侧任一可读,兼容 GET/POST 网关差异。
  const endpoint = `${base}${base.includes('?') ? '&' : '?'}scope=${scope}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Optional shared-secret gate matching the SCF APP_TOKEN env var. Only sent
  // when configured on the client side.
  const appToken = process.env.COS_STS_APP_TOKEN
  if (appToken) headers['X-App-Token'] = appToken

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope }),
      signal: controller.signal,
    })
  } catch (e) {
    // 网络层失败与我们自己的 10s 超时都算瞬时:取票据是幂等的,重发没有副作用。
    const reason = controller.signal.aborted
      ? `STS endpoint timed out after ${FETCH_TIMEOUT_MS / 1000}s`
      : `STS endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`
    throw new StsCredentialError(reason, true, e)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // 4xx 是配置问题(APP_TOKEN 不对、函数没发布),重试只是把确定的失败推迟。
    const transient = res.status === 408 || res.status === 429 || res.status >= 500
    throw new StsCredentialError(`STS endpoint returned HTTP ${res.status}`, transient)
  }

  const data = (await res.json()) as {
    credentials?: { tmpSecretId?: string; tmpSecretKey?: string; sessionToken?: string }
    startTime?: number
    expiredTime?: number
    bucket?: string
    region?: string
    error?: string
  }

  const creds = data?.credentials
  if (!creds?.tmpSecretId || !creds.tmpSecretKey || !creds.sessionToken) {
    // 函数回了 200 但没给票据 —— 权限/配置问题,再试三次也是同一个答案。
    throw new StsCredentialError(
      `STS endpoint response missing credentials${data?.error ? `: ${data.error}` : ''}`,
      false,
    )
  }

  return {
    tmpSecretId: creds.tmpSecretId,
    tmpSecretKey: creds.tmpSecretKey,
    sessionToken: creds.sessionToken,
    startTime: Number(data.startTime) || nowSeconds(),
    expiredTime: Number(data.expiredTime) || nowSeconds() + 1800,
    bucket: data.bucket || '',
    region: data.region || 'ap-guangzhou',
  }
}

async function fetchFromEndpoint(scope: StsScope): Promise<StsCredentials> {
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(scope)
    } catch (e) {
      lastError = e
      const transient = e instanceof StsCredentialError ? e.transient : true
      if (!transient || attempt === FETCH_ATTEMPTS) break
      const delay = stsRetryDelayMs(attempt)
      console.warn(
        `[sts] scope=${scope} 第 ${attempt}/${FETCH_ATTEMPTS} 次取票据失败,${delay}ms 后重试:` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

/**
 * Returns cached STS credentials for the scope, refreshing from the SCF
 * endpoint when the cache is empty, near expiry, or `forceRefresh` is set.
 * Concurrent callers of the same scope share a single in-flight request.
 */
export async function getStsCredentials(
  forceRefresh = false,
  scope: StsScope = 'image-history',
): Promise<StsCredentials> {
  const hit = cached.get(scope)
  if (!forceRefresh && isFresh(hit)) return hit
  let pending = inflight.get(scope)
  if (!pending) {
    pending = fetchFromEndpoint(scope)
      .then((c) => {
        cached.set(scope, c)
        return c
      })
      .finally(() => {
        inflight.delete(scope)
      })
    inflight.set(scope, pending)
  }
  return pending
}

/** Media-scope convenience wrapper (智能去字幕 / 分镜切图 免密钥通道). */
export function getMediaStsCredentials(forceRefresh = false): Promise<StsCredentials> {
  return getStsCredentials(forceRefresh, 'media')
}

export function clearStsCache(): void {
  cached.clear()
}
