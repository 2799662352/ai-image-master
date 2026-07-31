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

// 取票据失败不是"上传的小插曲"——票据拿不到会被 COS SDK 转成一句 403 AccessDenied,
// 而 403 不在中转重试的白名单里。少了这层重试,上传那 3 次机会在最常见的失败模式
// 下一次都用不上;批量出片时还会因为共享 in-flight 请求而整批一起死。
describe('tencent/stsCredentials 取票据重试', () => {
  const fetchMock = vi.fn()

  function okResponse() {
    return {
      ok: true,
      json: async () => ({
        credentials: { tmpSecretId: 'tmp', tmpSecretKey: 'k', sessionToken: 'tok' },
        startTime: 1,
        expiredTime: Math.floor(Date.now() / 1000) + 1800,
        bucket: 'image-master-1345773498',
        region: 'ap-guangzhou',
      }),
    }
  }

  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function runWithTimers<T>(start: () => Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
    const settled = start().then(
      (value) => {
        outcome = { ok: true, value }
      },
      (error) => {
        outcome = { ok: false, error }
      },
    )
    for (let i = 0; i < 8 && !outcome; i++) await vi.runAllTimersAsync()
    await settled
    if (!outcome) throw new Error('runWithTimers: 调用始终没有结束')
    if (outcome.ok) return outcome.value
    throw outcome.error
  }

  it('端点 5xx 后重试,拿到票据就当没事发生', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(okResponse())
    const { getStsCredentials } = await import('../stsCredentials')

    const creds = await runWithTimers(() => getStsCredentials())

    expect(creds.sessionToken).toBe('tok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('网络层失败同样重试 —— 取票据是幂等的,重发没有副作用', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND tencentscf.com'))
      .mockResolvedValueOnce(okResponse())
    const { getStsCredentials } = await import('../stsCredentials')

    await runWithTimers(() => getStsCredentials())

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('4xx 是配置问题,不重试', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 })
    const { getStsCredentials, StsCredentialError } = await import('../stsCredentials')

    const error = await runWithTimers(() => getStsCredentials()).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StsCredentialError)
    expect((error as InstanceType<typeof StsCredentialError>).transient).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('200 但没给票据也不重试 —— 权限/配置问题,再试三次是同一个答案', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'policy denied' }) })
    const { getStsCredentials } = await import('../stsCredentials')

    await expect(runWithTimers(() => getStsCredentials())).rejects.toThrow(/policy denied/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('三次都失败才放弃,抛出的错误里带得上真实原因', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 })
    const { getStsCredentials, StsCredentialError } = await import('../stsCredentials')

    const error = await runWithTimers(() => getStsCredentials()).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StsCredentialError)
    expect((error as Error).message).toContain('502')
    expect((error as InstanceType<typeof StsCredentialError>).transient).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('失败不写缓存:下一次调用重新去取,而不是把失败也缓存住', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 })
    const { getStsCredentials } = await import('../stsCredentials')
    await runWithTimers(() => getStsCredentials()).catch(() => undefined)

    fetchMock.mockResolvedValue(okResponse())
    const creds = await runWithTimers(() => getStsCredentials())
    expect(creds.sessionToken).toBe('tok')
  })
})
