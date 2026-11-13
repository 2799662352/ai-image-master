// src/main/services/tencent/__tests__/credentials.test.ts
// @vitest-environment node

import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

// ── 假 safeStorage:异步三件套 ───────────────────────────────────────────────
let encryptionAvailable = true
let nextShouldReEncrypt = false
let encryptShouldThrow = false
const mockSafeStorage = {
  isAsyncEncryptionAvailable: vi.fn(async () => encryptionAvailable),
  encryptStringAsync: vi.fn(async (s: string) => {
    if (encryptShouldThrow) throw new Error('keychain access denied')
    return Buffer.from('enc:' + s)
  }),
  // 异步版返回 `{ result, shouldReEncrypt }`,不是字符串 —— 假实现必须保持这个形状。
  decryptStringAsync: vi.fn(async (b: Buffer) => ({
    result: b.toString().replace(/^enc:/, ''),
    shouldReEncrypt: nextShouldReEncrypt,
  })),
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

// ── 假盘:`node:fs/promises` 换成内存 Map(凭据文件走它)────────────────────────
const files = new Map<string, Buffer>()
function enoent(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file '${p}'`), { code: 'ENOENT' })
}
const fsMock = {
  readFile: vi.fn(async (p: string) => {
    const v = files.get(p)
    if (!v) throw enoent(p)
    return v
  }),
  writeFile: vi.fn(async (p: string, b: Buffer) => void files.set(p, Buffer.from(b))),
  rename: vi.fn(async (from: string, to: string) => {
    const v = files.get(from)
    if (!v) throw enoent(from)
    files.set(to, v)
    files.delete(from)
  }),
  unlink: vi.fn(async (p: string) => {
    if (!files.delete(p)) throw enoent(p)
  }),
}
vi.mock('node:fs/promises', () => ({ default: fsMock, ...fsMock }))

// 同步 `fs` 只剩 `loadBuiltin()` 读内置 cos-credentials.json 用,一律当作不存在。
const mockReadFileSync = vi.fn()
const mockExistsSync = vi.fn()
vi.mock('fs', () => ({
  default: { readFileSync: mockReadFileSync, existsSync: mockExistsSync },
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}))

// 必须用 path.join 现算,不能写死带斜杠的字面量:实现里是 `path.join(userData, FILENAME)`,
// 分隔符随平台变 —— 写死的 key 在 Windows 上对不上(只走「实现写→实现读」往返的用例两边同 key
// 照样绿,唯独「预置文件再读回」会红;反过来 Linux CI 上也一样)。
const BIN = path.join('/mock/userData', 'tencent-credentials.bin')

/** 凭据文件的路径取决于平台分隔符,不写死:按后缀找。 */
function binKey(): string | undefined {
  return [...files.keys()].find((k) => /tencent-credentials\.bin$/.test(k))
}
function putStored(obj: unknown): void {
  files.set(BIN, Buffer.from('enc:' + JSON.stringify(obj)))
}
function storedOnDisk(): Record<string, string> {
  const k = binKey()
  return k ? JSON.parse(files.get(k)!.toString().replace(/^enc:/, '')) : {}
}

describe('tencent/credentials', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    files.clear()
    encryptionAvailable = true
    nextShouldReEncrypt = false
    encryptShouldThrow = false
    mockExistsSync.mockReturnValue(false)
    mockStoreGet.mockReturnValue('')
    delete process.env.COS_SECRET_ID
    delete process.env.COS_SECRET_KEY
    delete process.env.COS_BUCKET
    delete process.env.COS_BUCKET_NAME
    delete process.env.COS_REGION
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function load() {
    const m = await import('../credentials')
    await m.initCredentials()
    return m
  }

  it('resolves credentials in store > env > builtin order', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    process.env.COS_SECRET_KEY = 'env-key'

    const { getCredentials } = await load()
    const c = getCredentials()
    expect(c.secretId).toBe('env-id')
    expect(c.secretKey).toBe('env-key')
  })

  it('safeStorage takes precedence over env (per field)', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    putStored({ secretId: 'safe-id', secretKey: 'safe-key', bucket: 'b', region: 'ap-shanghai' })

    const { getCredentials } = await load()
    const c = getCredentials()
    expect(c.secretId).toBe('safe-id')
  })

  it('falls back per-field: store has secretId, env supplies bucket', async () => {
    process.env.COS_BUCKET = 'env-bucket'
    putStored({ secretId: 'safe-id', secretKey: 'safe-key', bucket: '', region: '' })

    const { getCredentials } = await load()
    const c = getCredentials()
    expect(c.secretId).toBe('safe-id')
    expect(c.bucket).toBe('env-bucket')
  })

  it('migrates from electron-store on first load when the .bin does not exist', async () => {
    mockStoreGet.mockImplementation((k: string) => ({
      secretId: 'legacy-id',
      secretKey: 'legacy-key',
      bucket: 'legacy-bucket',
      region: 'ap-guangzhou',
    } as any)[k] || '')

    const { getCredentials } = await load()
    const c = getCredentials()

    expect(c.secretId).toBe('legacy-id')
    expect(mockSafeStorage.encryptStringAsync).toHaveBeenCalled()
    // 经临时文件原子落位:先写 .bin.tmp,再 rename 成 .bin。
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/tencent-credentials\.bin\.tmp$/),
      expect.any(Buffer),
    )
    expect(binKey()).toBeDefined()
    expect(storedOnDisk().secretId).toBe('legacy-id')
    expect(mockStoreDelete).toHaveBeenCalledWith('secretId')
    expect(mockStoreDelete).toHaveBeenCalledWith('secretKey')
  })

  it('falls back to in-memory when safeStorage unavailable', async () => {
    encryptionAvailable = false
    const { setCredentials, getCredentials } = await load()

    await setCredentials({ secretId: 'mem-id', secretKey: 'mem-key', bucket: 'b', region: 'ap-shanghai' })
    const c = getCredentials()
    expect(c.secretId).toBe('mem-id')
    expect(fsMock.writeFile).not.toHaveBeenCalled()
  })

  it('setCredentials triggers all registered invalidation callbacks', async () => {
    const { setCredentials, onCredentialsInvalidated } = await load()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    onCredentialsInvalidated(cb1)
    onCredentialsInvalidated(cb2)

    await setCredentials({ secretId: 'new-id' })
    expect(cb1).toHaveBeenCalled()
    expect(cb2).toHaveBeenCalled()
  })

  it('getCredentialState masks secretId and reports source', async () => {
    putStored({ secretId: 'AKIDxxxxxxxxxxxxxxxxxx', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' })

    const { getCredentialState } = await load()
    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('store')
    expect(s.secretIdMasked).toBe('AKID****')
  })

  it('无永久密钥时报告免密钥 STS 通道(hasCredentials=true, source=sts)', async () => {
    // store/env/builtin 全空 → 媒体功能仍可经云函数临时票据运行
    const { getCredentialState } = await load()
    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('sts')
    expect(s.secretIdMasked).toBeUndefined()
  })

  it('存了格式畸形的密钥(非 AKID 开头)→ 视为未配置,报告 STS 免密钥通道', async () => {
    // 用户误把别家 API key 粘进设置页(实测导致 COS InvalidAccessKeyId)。
    // 媒体链路应忽略它并降级免密钥,而不是拿去签名。
    putStored({ secretId: 'sk-wrong-vendor-key-123456', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' })

    const { getCredentialState, isLikelyValidSecretId } = await load()
    expect(isLikelyValidSecretId('sk-wrong-vendor-key-123456')).toBe(false)
    expect(isLikelyValidSecretId('AKIDxxxxxxxxxxxxxxxxxx')).toBe(true)

    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('sts')
  })

  it('reports credentialSource: "memory" when safeStorage unavailable and creds set in-session', async () => {
    encryptionAvailable = false
    const { setCredentials, getCredentialState } = await load()

    // AKID 格式才会被认作可用永久密钥(否则 getCredentialState 报 sts)
    await setCredentials({ secretId: 'AKIDmemoryfallback01', secretKey: 'mem-key', bucket: 'b', region: 'ap-shanghai' })
    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('memory')
    expect(s.secretIdMasked).toBe('AKID****')
  })

  it('migration is idempotent across repeated getCredentials calls and repeated init in the same session', async () => {
    mockStoreGet.mockImplementation((k: string) => ({
      secretId: 'legacy-id',
      secretKey: 'legacy-key',
      bucket: 'legacy-bucket',
      region: 'ap-guangzhou',
    } as any)[k] || '')

    const { getCredentials, initCredentials } = await load()
    await initCredentials()
    getCredentials()
    getCredentials()
    getCredentials()

    // Migration write + delete each happen exactly once across all reads and inits.
    expect(mockSafeStorage.encryptStringAsync).toHaveBeenCalledTimes(1)
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
    // 4 keys deleted exactly once (4 calls total, not 12).
    expect(mockStoreDelete).toHaveBeenCalledTimes(4)
  })

  // ── 异步化之后新增的行为 ───────────────────────────────────────────────────

  // 同步读者(COS / MPS 客户端)在预热前拿到的只能是 env / 内置视图。关键是**不能缓存**这个视图,
  // 否则预热完成后还会一直读到不含盘上凭据的旧结果。
  it('reading before initCredentials(): env/builtin view + one warning, and it is not cached past the load', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    putStored({ secretId: 'safe-id', secretKey: 'safe-key', bucket: 'b', region: 'ap-shanghai' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const m = await import('../credentials')

    expect(m.getCredentials().secretId).toBe('env-id')
    expect(m.getCredentials().secretId).toBe('env-id')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('before initCredentials'))).toHaveLength(1)

    await m.initCredentials()
    expect(m.getCredentials().secretId).toBe('safe-id')
  })

  it('does not touch the disk until initCredentials() runs', async () => {
    putStored({ secretId: 'safe-id', secretKey: 'safe-key', bucket: 'b', region: 'ap-shanghai' })
    await import('../credentials')
    expect(fsMock.readFile).not.toHaveBeenCalled()
    expect(mockSafeStorage.decryptStringAsync).not.toHaveBeenCalled()
  })

  // setCredentials 是「当前解析结果 + patch」整份写回。没预热就合并的话,当前结果里
  // 没有盘上已有的值,env 值会把它们覆盖掉再写回盘。
  it('setCredentials waits for the initial load, so stored fields are not overwritten by env values', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    putStored({ secretId: 'safe-id', secretKey: 'safe-key', bucket: 'b', region: 'ap-shanghai' })
    const m = await import('../credentials') // 故意不预热

    await m.setCredentials({ region: 'ap-beijing' })

    expect(storedOnDisk()).toMatchObject({ secretId: 'safe-id', secretKey: 'safe-key', bucket: 'b', region: 'ap-beijing' })
  })

  // 同步版里两次调用一个接一个;异步之后合并必须在串行队列里现算,
  // 否则两个 patch 都基于同一份旧值,后落盘的把先落盘的覆盖掉。
  it('concurrent setCredentials calls merge on top of each other instead of overwriting', async () => {
    const m = await load()

    await Promise.all([
      m.setCredentials({ secretId: 'AKIDfirstconcurrent001' }),
      m.setCredentials({ bucket: 'second-bucket' }),
    ])

    expect(storedOnDisk()).toMatchObject({ secretId: 'AKIDfirstconcurrent001', bucket: 'second-bucket' })
    expect(m.getCredentials()).toMatchObject({ secretId: 'AKIDfirstconcurrent001', bucket: 'second-bucket' })
  })

  it('shouldReEncrypt: still returns the credentials and rewrites the file from the decrypted plaintext', async () => {
    putStored({ secretId: 'AKIDxxxxxxxxxxxxxxxxxx', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' })
    nextShouldReEncrypt = true

    const m = await load()
    expect(m.getCredentials().secretId).toBe('AKIDxxxxxxxxxxxxxxxxxx')

    await vi.waitFor(() =>
      expect(fsMock.rename).toHaveBeenCalledWith(expect.stringMatching(/\.bin\.tmp$/), expect.stringMatching(/\.bin$/)),
    )
    expect(mockSafeStorage.encryptStringAsync).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite the file when shouldReEncrypt is false', async () => {
    putStored({ secretId: 'AKIDxxxxxxxxxxxxxxxxxx', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' })
    await load()
    // 重加密是异步排队的:预热一返回就断言「没有发生」会是时序假绿,先让事件循环跑一圈。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockSafeStorage.encryptStringAsync).not.toHaveBeenCalled()
    expect(fsMock.rename).not.toHaveBeenCalled()
  })

  it('shouldReEncrypt: a failing re-encrypt neither fails the load nor damages the old file', async () => {
    putStored({ secretId: 'AKIDxxxxxxxxxxxxxxxxxx', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' })
    const original = Buffer.from(files.get(BIN)!)
    nextShouldReEncrypt = true
    encryptShouldThrow = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const m = await load()
    expect(m.getCredentials().secretId).toBe('AKIDxxxxxxxxxxxxxxxxxx')
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((c) => String(c[0]).includes('safeStorage write failed'))).toBe(true),
    )
    expect(files.get(BIN)).toEqual(original)
  })

  it('a failed overwrite keeps the old file, leaves no temp file, and the new value lives in memory', async () => {
    putStored({ secretId: 'AKIDoldoldoldoldold01', secretKey: 'old', bucket: 'b', region: 'ap-shanghai' })
    const original = Buffer.from(files.get(BIN)!)
    const m = await load()
    fsMock.rename.mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await m.setCredentials({ secretId: 'AKIDnewnewnewnewnew01' })

    expect(m.getCredentials().secretId).toBe('AKIDnewnewnewnewnew01')
    expect(m.getCredentialState().credentialSource).toBe('memory')
    expect(files.get(BIN)).toEqual(original)
    expect([...files.keys()].some((k) => k.endsWith('.tmp'))).toBe(false)
  })

  it('treats an undecryptable file as no stored credentials instead of throwing', async () => {
    files.set(BIN, Buffer.from('enc:{not json'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env.COS_SECRET_ID = 'env-id'

    const m = await load()
    expect(m.getCredentials().secretId).toBe('env-id')
  })
})
