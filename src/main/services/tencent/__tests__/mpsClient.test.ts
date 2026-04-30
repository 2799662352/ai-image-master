// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mpsClientCtor = vi.fn(function (_opts: any) { return { ProcessImage: vi.fn(), ProcessMedia: vi.fn() } })
vi.mock('tencentcloud-sdk-nodejs-mps', () => ({
  default: { mps: { v20190612: { Client: mpsClientCtor } } },
  mps: { v20190612: { Client: mpsClientCtor } },
}))

vi.mock('../credentials', () => ({
  getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
  onCredentialsInvalidated: vi.fn(),
}))

describe('tencent/mpsClient', () => {
  beforeEach(() => {
    vi.resetModules()
    mpsClientCtor.mockClear()
  })

  it('lazy-creates the MPS client once', async () => {
    const { getMpsClient } = await import('../mpsClient')
    getMpsClient()
    getMpsClient()
    expect(mpsClientCtor).toHaveBeenCalledTimes(1)
  })

  it('drops the cached client on credential invalidation', async () => {
    const invalidatedCallbacks: Array<() => void> = []
    vi.doMock('../credentials', () => ({
      getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
      onCredentialsInvalidated: (cb: () => void) => invalidatedCallbacks.push(cb),
    }))

    const { getMpsClient } = await import('../mpsClient')
    getMpsClient()
    invalidatedCallbacks.forEach((cb) => cb())
    getMpsClient()

    expect(mpsClientCtor).toHaveBeenCalledTimes(2)
  })

  it('configures the client with TC3-HMAC-SHA256 + POST + 30s timeout', async () => {
    const { getMpsClient } = await import('../mpsClient')
    getMpsClient()
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
})
