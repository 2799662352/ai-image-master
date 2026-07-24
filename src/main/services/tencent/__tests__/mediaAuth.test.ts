// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getCredentialsMock = vi.fn()
vi.mock('../credentials', () => ({
  getCredentials: (...args: any[]) => getCredentialsMock(...args),
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
      secretId: 'perm-id',
      secretKey: 'perm-key',
      bucket: 'my-bucket',
      region: 'ap-shanghai',
    })

    const { getMediaAuth, hasPermanentCredentials } = await import('../mediaAuth')
    expect(hasPermanentCredentials()).toBe(true)

    const auth = await getMediaAuth()
    expect(auth).toEqual({
      mode: 'permanent',
      secretId: 'perm-id',
      secretKey: 'perm-key',
      bucket: 'my-bucket',
      region: 'ap-shanghai',
    })
    expect(getMediaStsCredentialsMock).not.toHaveBeenCalled()
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
