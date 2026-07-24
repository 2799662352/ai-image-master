// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getCredentialsMock = vi.fn()
vi.mock('../credentials', () => ({
  getCredentials: (...args: any[]) => getCredentialsMock(...args),
  // 与真实实现同构:AKID 前缀 + 总长 ≥20 才算合法永久密钥。
  isLikelyValidSecretId: (id: string) =>
    typeof id === 'string' && id.startsWith('AKID') && id.length >= 20,
}))

const getMediaStsCredentialsMock = vi.fn()
vi.mock('../stsCredentials', () => ({
  getMediaStsCredentials: (...args: any[]) => getMediaStsCredentialsMock(...args),
}))

describe('tencent/mediaAuth', () => {
  beforeEach(() => {
    vi.resetModules()
    getCredentialsMock.mockReset()
    getMediaStsCredentialsMock.mockReset()
  })

  it('permanent credentials win when configured (STS endpoint untouched)', async () => {
    getCredentialsMock.mockReturnValue({
      secretId: 'AKIDpermanentexample0001',
      secretKey: 'perm-key',
      bucket: 'my-bucket',
      region: 'ap-shanghai',
    })

    const { getMediaAuth, hasPermanentCredentials } = await import('../mediaAuth')
    expect(hasPermanentCredentials()).toBe(true)

    const auth = await getMediaAuth()
    expect(auth).toEqual({
      mode: 'permanent',
      secretId: 'AKIDpermanentexample0001',
      secretKey: 'perm-key',
      bucket: 'my-bucket',
      region: 'ap-shanghai',
    })
    expect(getMediaStsCredentialsMock).not.toHaveBeenCalled()
  })

  it('malformed permanent key (non-AKID, e.g. pasted wrong vendor key) is ignored → STS fallback', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getCredentialsMock.mockReturnValue({
      secretId: 'sk-not-a-tencent-key-at-all',
      secretKey: 'whatever',
      bucket: 'my-bucket',
      region: 'ap-shanghai',
    })
    getMediaStsCredentialsMock.mockResolvedValue({
      tmpSecretId: 'tmp-id',
      tmpSecretKey: 'tmp-key',
      sessionToken: 'tok',
      startTime: 1,
      expiredTime: 999,
      bucket: 'map-tiles-bucket-1345773498',
      region: 'ap-guangzhou',
    })

    const { getMediaAuth, hasPermanentCredentials } = await import('../mediaAuth')
    expect(hasPermanentCredentials()).toBe(false)

    const auth = await getMediaAuth()
    expect(auth.mode).toBe('sts')
    expect((auth as any).sessionToken).toBe('tok')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to media-scope STS when no permanent key; bucket/region come from the ticket', async () => {
    getCredentialsMock.mockReturnValue({ secretId: '', secretKey: '', bucket: '', region: 'ap-guangzhou' })
    getMediaStsCredentialsMock.mockResolvedValue({
      tmpSecretId: 'tmp-id',
      tmpSecretKey: 'tmp-key',
      sessionToken: 'tok',
      startTime: 1,
      expiredTime: 999,
      bucket: 'map-tiles-bucket-1345773498',
      region: 'ap-guangzhou',
    })

    const { getMediaAuth, hasPermanentCredentials } = await import('../mediaAuth')
    expect(hasPermanentCredentials()).toBe(false)

    const auth = await getMediaAuth()
    expect(auth).toEqual({
      mode: 'sts',
      secretId: 'tmp-id',
      secretKey: 'tmp-key',
      sessionToken: 'tok',
      expiredTime: 999,
      bucket: 'map-tiles-bucket-1345773498',
      region: 'ap-guangzhou',
    })
  })

  it('propagates STS endpoint failure as a rejection (task fails visibly, no silent fallback)', async () => {
    getCredentialsMock.mockReturnValue({ secretId: '', secretKey: '', bucket: '', region: '' })
    getMediaStsCredentialsMock.mockRejectedValue(new Error('endpoint down'))

    const { getMediaAuth } = await import('../mediaAuth')
    await expect(getMediaAuth()).rejects.toThrow('endpoint down')
  })
})
