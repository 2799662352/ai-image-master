// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mpsClientCtor = vi.fn(function (_opts: any) { return { ProcessImage: vi.fn(), ProcessMedia: vi.fn() } })
// NOTE: package sets __esModule: true and exports only `mps` (no default).
// Mock must mirror that shape — providing a `default` would mask import-shape regressions.
vi.mock('tencentcloud-sdk-nodejs-mps', () => ({
  __esModule: true,
  mps: { v20190612: { Client: mpsClientCtor } },
}))

const getMediaAuthMock = vi.fn()
vi.mock('../mediaAuth', () => ({
  getMediaAuth: (...args: any[]) => getMediaAuthMock(...args),
}))

vi.mock('../credentials', () => ({
  onCredentialsInvalidated: vi.fn(),
}))

function permanentAuth() {
  return { mode: 'permanent', secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }
}

function stsAuth(expiredTime: number) {
  return {
    mode: 'sts',
    secretId: 'tmp-id',
    secretKey: 'tmp-key',
    sessionToken: 'tok-1',
    expiredTime,
    bucket: 'media-bucket',
    region: 'ap-guangzhou',
  }
}

describe('tencent/mpsClient', () => {
  beforeEach(() => {
    vi.resetModules()
    mpsClientCtor.mockClear()
    getMediaAuthMock.mockReset()
    getMediaAuthMock.mockResolvedValue(permanentAuth())
  })

  it('lazy-creates the MPS client once (permanent mode)', async () => {
    const { getMpsClient } = await import('../mpsClient')
    await getMpsClient()
    await getMpsClient()
    expect(mpsClientCtor).toHaveBeenCalledTimes(1)
  })

  it('drops the cached client on credential invalidation', async () => {
    const invalidatedCallbacks: Array<() => void> = []
    vi.doMock('../credentials', () => ({
      onCredentialsInvalidated: (cb: () => void) => invalidatedCallbacks.push(cb),
    }))

    const { getMpsClient } = await import('../mpsClient')
    await getMpsClient()
    invalidatedCallbacks.forEach((cb) => cb())
    await getMpsClient()

    expect(mpsClientCtor).toHaveBeenCalledTimes(2)
  })

  it('configures the client with TC3-HMAC-SHA256 + POST + 30s timeout (no token in permanent mode)', async () => {
    const { getMpsClient } = await import('../mpsClient')
    await getMpsClient()
    expect(mpsClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { secretId: 'id', secretKey: 'k' },
        region: 'ap-shanghai',
        profile: expect.objectContaining({
          signMethod: 'TC3-HMAC-SHA256',
          httpProfile: { reqMethod: 'POST', reqTimeout: 30 },
        }),
      }),
    )
  })

  it('STS mode attaches the session token to the credential', async () => {
    const farExpiry = Math.floor(Date.now() / 1000) + 1800
    getMediaAuthMock.mockResolvedValue(stsAuth(farExpiry))

    const { getMpsClient } = await import('../mpsClient')
    await getMpsClient()

    expect(mpsClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { secretId: 'tmp-id', secretKey: 'tmp-key', token: 'tok-1' },
        region: 'ap-guangzhou',
      }),
    )
  })

  it('STS mode rebuilds the client when the token is near expiry; fresh token keeps the cache', async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 60 // < 300s skew → stale
    getMediaAuthMock.mockResolvedValue(stsAuth(nearExpiry))

    const { getMpsClient } = await import('../mpsClient')
    await getMpsClient()
    await getMpsClient() // stale → rebuild
    expect(mpsClientCtor).toHaveBeenCalledTimes(2)

    const farExpiry = Math.floor(Date.now() / 1000) + 1800
    getMediaAuthMock.mockResolvedValue(stsAuth(farExpiry))
    await getMpsClient() // rebuild once with fresh token…
    await getMpsClient() // …then cache hit
    expect(mpsClientCtor).toHaveBeenCalledTimes(3)
  })
})
