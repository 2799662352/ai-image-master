// src/main/services/tencent/stsCredentials.ts
//
// Fetches short-lived STS credentials from the SCF "sts-cos" function URL and
// caches them in-process. The permanent sub-account key never reaches the
// client — the endpoint hands back a 30-minute token that can ONLY PutObject
// under `image-history/*` in the image bucket.
//
// See serverless/sts-cos/ for the function that issues these tokens.

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

let cached: StsCredentials | null = null
let inflight: Promise<StsCredentials> | null = null

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isFresh(c: StsCredentials | null): c is StsCredentials {
  if (!c) return false
  return c.expiredTime - nowSeconds() > REFRESH_SKEW_SECONDS
}

async function fetchFromEndpoint(): Promise<StsCredentials> {
  const endpoint = getEndpoint()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Optional shared-secret gate matching the SCF APP_TOKEN env var. Only sent
  // when configured on the client side.
  const appToken = process.env.COS_STS_APP_TOKEN
  if (appToken) headers['X-App-Token'] = appToken

  let res: Response
  try {
    res = await fetch(endpoint, { method: 'POST', headers, signal: controller.signal })
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
 * Returns cached STS credentials, refreshing from the SCF endpoint when the
 * cache is empty, near expiry, or `forceRefresh` is set. Concurrent callers
 * share a single in-flight request.
 */
export async function getStsCredentials(forceRefresh = false): Promise<StsCredentials> {
  if (!forceRefresh && isFresh(cached)) return cached
  if (!inflight) {
    inflight = fetchFromEndpoint()
      .then((c) => {
        cached = c
        return c
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export function clearStsCache(): void {
  cached = null
}
