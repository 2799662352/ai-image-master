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

const cached = new Map<StsScope, StsCredentials>()
const inflight = new Map<StsScope, Promise<StsCredentials>>()

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isFresh(c: StsCredentials | undefined): c is StsCredentials {
  if (!c) return false
  return c.expiredTime - nowSeconds() > REFRESH_SKEW_SECONDS
}

async function fetchFromEndpoint(scope: StsScope): Promise<StsCredentials> {
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
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new Error(`STS endpoint returned HTTP ${res.status}`)
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
    throw new Error(`STS endpoint response missing credentials${data?.error ? `: ${data.error}` : ''}`)
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
