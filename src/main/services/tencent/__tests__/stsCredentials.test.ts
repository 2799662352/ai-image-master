// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function makeResponse(body: unknown) {
  return {
    credentials: {
      tmpSecretId: 'AKIDtmp',
      tmpSecretKey: 'tmpkey',
      sessionToken: 'token',
    },
    startTime: 1000,
    expiredTime: 1000 + 1800,
    bucket: 'image-master-1345773498',
    region: 'ap-guangzhou',
    ...(body as object),
  }
}

describe('tencent/stsCredentials', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    // Pin "now" well before the mocked expiredTime so creds read as fresh.
    vi.setSystemTime(new Date(500 * 1000))
    delete process.env.COS_STS_APP_TOKEN
    delete process.env.COS_STS_ENDPOINT
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches once and caches while fresh', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => makeResponse({}),
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    const { getStsCredentials } = await import('../stsCredentials')

    const a = await getStsCredentials()
    const b = await getStsCredentials()

    expect(a.tmpSecretId).toBe('AKIDtmp')
    expect(a.sessionToken).toBe('token')
    expect(b).toEqual(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes when within the 5-minute expiry skew', async () => {
    let n = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => makeResponse({ expiredTime: 500 + 100, credentials: { tmpSecretId: `id${n++}`, tmpSecretKey: 'k', sessionToken: 't' } }),
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    const { getStsCredentials } = await import('../stsCredentials')

    // expiredTime (600) is only 100s ahead of now (500) → under the 300s skew →
    // every call must re-fetch.
    await getStsCredentials()
    await getStsCredentials()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent callers into a single request', async () => {
    let resolveFetch!: (v: unknown) => void
    const gate = new Promise((r) => {
      resolveFetch = r
    })
    const fetchMock = vi.fn(async () => {
      await gate
      return { ok: true, status: 200, json: async () => makeResponse({}) }
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    const { getStsCredentials } = await import('../stsCredentials')

    const p1 = getStsCredentials()
    const p2 = getStsCredentials()
    resolveFetch(null)
    const [a, b] = await Promise.all([p1, p2])

    expect(a).toEqual(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws on non-200 and does not cache', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    const { getStsCredentials } = await import('../stsCredentials')

    await expect(getStsCredentials()).rejects.toThrow(/HTTP 500/)
  })

  it('throws when credentials are missing from the response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 'server credentials not configured' }),
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    const { getStsCredentials } = await import('../stsCredentials')

    await expect(getStsCredentials()).rejects.toThrow(/missing credentials/)
  })

  it('sends X-App-Token header only when COS_STS_APP_TOKEN is set', async () => {
    process.env.COS_STS_APP_TOKEN = 'secret-token'
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => makeResponse({}) })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    const { getStsCredentials } = await import('../stsCredentials')
    await getStsCredentials()

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers['X-App-Token']).toBe('secret-token')
  })
})
