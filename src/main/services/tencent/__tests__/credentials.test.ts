// src/main/services/tencent/__tests__/credentials.test.ts
// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-store + electron BEFORE importing credentials
const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
const mockStoreDelete = vi.fn()
vi.mock('electron-store', () => ({
  default: function MockStore() {
    return {
      get: mockStoreGet,
      set: mockStoreSet,
      delete: mockStoreDelete,
    }
  },
}))

const mockSafeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from('enc:' + s)),
  decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, '')),
}
const mockApp = {
  getPath: vi.fn(() => '/mock/userData'),
  isPackaged: false,
  whenReady: vi.fn(() => Promise.resolve()),
}
vi.mock('electron', () => ({
  app: mockApp,
  safeStorage: mockSafeStorage,
}))

const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockExistsSync = vi.fn()
const mockUnlinkSync = vi.fn()
vi.mock('fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
    unlinkSync: mockUnlinkSync,
  },
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
}))

describe('tencent/credentials', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockStoreGet.mockReturnValue('')
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
    delete process.env.COS_SECRET_ID
    delete process.env.COS_SECRET_KEY
    delete process.env.COS_BUCKET
    delete process.env.COS_BUCKET_NAME
    delete process.env.COS_REGION
  })

  it('resolves credentials in store > env > builtin order', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    process.env.COS_SECRET_KEY = 'env-key'
    mockExistsSync.mockReturnValue(false)
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin') ? false : false)

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()
    expect(c.secretId).toBe('env-id')
    expect(c.secretKey).toBe('env-key')
  })

  it('safeStorage takes precedence over env (per field)', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin'))
    mockReadFileSync.mockReturnValue(Buffer.from('enc:{"secretId":"safe-id","secretKey":"safe-key","bucket":"b","region":"ap-shanghai"}'))

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()
    expect(c.secretId).toBe('safe-id')
  })

  it('falls back per-field: store has secretId, env supplies bucket', async () => {
    process.env.COS_BUCKET = 'env-bucket'
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin'))
    mockReadFileSync.mockReturnValue(Buffer.from('enc:{"secretId":"safe-id","secretKey":"safe-key","bucket":"","region":""}'))

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()
    expect(c.secretId).toBe('safe-id')
    expect(c.bucket).toBe('env-bucket')
  })

  it('migrates from electron-store on first read when .bin does not exist', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.bin')) // electron-store data exists, .bin does not
    mockStoreGet.mockImplementation((k: string) => ({
      secretId: 'legacy-id',
      secretKey: 'legacy-key',
      bucket: 'legacy-bucket',
      region: 'ap-guangzhou',
    } as any)[k] || '')

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()

    expect(c.secretId).toBe('legacy-id')
    expect(mockSafeStorage.encryptString).toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/tencent-credentials\.bin$/),
      expect.any(Buffer),
    )
    expect(mockStoreDelete).toHaveBeenCalledWith('secretId')
    expect(mockStoreDelete).toHaveBeenCalledWith('secretKey')
  })

  it('falls back to in-memory when safeStorage unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    const { setCredentials, getCredentials } = await import('../credentials')

    setCredentials({ secretId: 'mem-id', secretKey: 'mem-key', bucket: 'b', region: 'ap-shanghai' })
    const c = getCredentials()
    expect(c.secretId).toBe('mem-id')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('setCredentials triggers all registered invalidation callbacks', async () => {
    const { setCredentials, onCredentialsInvalidated } = await import('../credentials')
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    onCredentialsInvalidated(cb1)
    onCredentialsInvalidated(cb2)

    setCredentials({ secretId: 'new-id' })
    expect(cb1).toHaveBeenCalled()
    expect(cb2).toHaveBeenCalled()
  })

  it('getCredentialState masks secretId and reports source', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin'))
    mockReadFileSync.mockReturnValue(Buffer.from('enc:{"secretId":"AKIDxxxxxxxxxxxxxxxxxx","secretKey":"k","bucket":"b","region":"ap-shanghai"}'))

    const { getCredentialState } = await import('../credentials')
    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('store')
    expect(s.secretIdMasked).toBe('AKID****')
  })

  it('无永久密钥时报告免密钥 STS 通道(hasCredentials=true, source=sts)', async () => {
    // store/env/builtin 全空 → 媒体功能仍可经云函数临时票据运行
    const { getCredentialState } = await import('../credentials')
    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('sts')
    expect(s.secretIdMasked).toBeUndefined()
  })

  it('存了格式畸形的密钥(非 AKID 开头)→ 视为未配置,报告 STS 免密钥通道', async () => {
    // 用户误把别家 API key 粘进设置页(实测导致 COS InvalidAccessKeyId)。
    // 媒体链路应忽略它并降级免密钥,而不是拿去签名。
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin'))
    mockReadFileSync.mockReturnValue(Buffer.from('enc:{"secretId":"sk-wrong-vendor-key-123456","secretKey":"k","bucket":"b","region":"ap-shanghai"}'))

    const { getCredentialState, isLikelyValidSecretId } = await import('../credentials')
    expect(isLikelyValidSecretId('sk-wrong-vendor-key-123456')).toBe(false)
    expect(isLikelyValidSecretId('AKIDxxxxxxxxxxxxxxxxxx')).toBe(true)

    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('sts')
  })

  it('reports credentialSource: "memory" when safeStorage unavailable and creds set in-session', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    const { setCredentials, getCredentialState } = await import('../credentials')

    // AKID 格式才会被认作可用永久密钥(否则 getCredentialState 报 sts)
    setCredentials({ secretId: 'AKIDmemoryfallback01', secretKey: 'mem-key', bucket: 'b', region: 'ap-shanghai' })
    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('memory')
    expect(s.secretIdMasked).toBe('AKID****')
  })

  it('migration is idempotent across repeated getCredentials calls in the same session', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.bin'))
    mockStoreGet.mockImplementation((k: string) => ({
      secretId: 'legacy-id',
      secretKey: 'legacy-key',
      bucket: 'legacy-bucket',
      region: 'ap-guangzhou',
    } as any)[k] || '')

    const { getCredentials } = await import('../credentials')
    getCredentials()
    getCredentials()
    getCredentials()

    // Migration write + delete each happen exactly once across all 3 reads.
    expect(mockSafeStorage.encryptString).toHaveBeenCalledTimes(1)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
    // 4 keys deleted exactly once (4 calls total, not 12).
    expect(mockStoreDelete).toHaveBeenCalledTimes(4)
  })
})
