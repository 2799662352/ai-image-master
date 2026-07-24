// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function stsResponse(scope: string) {
  return {
    ok: true,
    json: async () => ({
      credentials: {
        tmpSecretId: `tmp-${scope}`,
        tmpSecretKey: 'tmp-key',
        sessionToken: `tok-${scope}`,
      },
      startTime: 1,
      expiredTime: Math.floor(Date.now() / 1000) + 1800,
      bucket: scope === 'media' ? 'map-tiles-bucket-1345773498' : 'image-master-1345773498',
      region: 'ap-guangzhou',
      scope,
    }),
  }
}

describe('tencent/stsCredentials scope 支持', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation((url: string) => {
      const scope = /scope=media/.test(String(url)) ? 'media' : 'image-history'
      return Promise.resolve(stsResponse(scope))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认 scope=image-history(旧调用方零改动)', async () => {
    const { getStsCredentials } = await import('../stsCredentials')
    const c = await getStsCredentials()
    expect(c.tmpSecretId).toBe('tmp-image-history')
    expect(String(fetchMock.mock.calls[0][0])).toContain('scope=image-history')
  })

  it('media scope 走 ?scope=media 并返回媒体桶', async () => {
    const { getMediaStsCredentials } = await import('../stsCredentials')
    const c = await getMediaStsCredentials()
    expect(c.tmpSecretId).toBe('tmp-media')
    expect(c.bucket).toBe('map-tiles-bucket-1345773498')
    expect(String(fetchMock.mock.calls[0][0])).toContain('scope=media')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.scope).toBe('media')
  })

  it('两个 scope 各自缓存,互不串票', async () => {
    const { getStsCredentials, getMediaStsCredentials } = await import('../stsCredentials')
    const a1 = await getStsCredentials()
    const b1 = await getMediaStsCredentials()
    const a2 = await getStsCredentials()
    const b2 = await getMediaStsCredentials()

    expect(fetchMock).toHaveBeenCalledTimes(2) // 每个 scope 只取一次
    expect(a1.sessionToken).toBe('tok-image-history')
    expect(b1.sessionToken).toBe('tok-media')
    expect(a2).toBe(a1)
    expect(b2).toBe(b1)
  })

  it('clearStsCache 清空全部 scope', async () => {
    const { getStsCredentials, getMediaStsCredentials, clearStsCache } = await import('../stsCredentials')
    await getStsCredentials()
    await getMediaStsCredentials()
    clearStsCache()
    await getStsCredentials()
    await getMediaStsCredentials()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
