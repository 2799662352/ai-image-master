import { describe, expect, it, vi, beforeEach } from 'vitest'

const store = new Map<string, Buffer>()
let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\fake\\userData' },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(s, 'utf8')]),
    decryptString: (b: Buffer) => {
      if (!b.subarray(0, 3).equals(Buffer.from('v10'))) {
        throw new Error('Ciphertext does not appear to be encrypted.')
      }
      return b.subarray(3).toString('utf8')
    },
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: (p: string) => store.has(p),
    readFileSync: (p: string) => {
      const v = store.get(p)
      if (!v) throw new Error('ENOENT')
      return v
    },
    writeFileSync: (p: string, b: Buffer) => void store.set(p, b),
    unlinkSync: (p: string) => void store.delete(p),
  },
}))

const BIN_PATH = 'C:\\fake\\userData\\auth-credentials.bin'

const CRED = {
  token: 'jwt.tok.en',
  userId: 'u1',
  username: 'alice',
  displayName: 'Alice',
  role: 'USER',
  expiresAt: 1893456000000,
}

describe('auth credentials', () => {
  beforeEach(async () => {
    store.clear()
    encryptionAvailable = true
    vi.resetModules()
  })

  it('round-trips through safeStorage', async () => {
    const m = await import('../credentials')
    expect(m.getCredential()).toBeNull()
    m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('safeStorage')
  })

  it('falls back to memory when encryption is unavailable', async () => {
    encryptionAvailable = false
    const m = await import('../credentials')
    m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('memory')
    expect(store.size).toBe(0)
  })

  it('treats a corrupted blob as no credential instead of throwing', async () => {
    const m = await import('../credentials')
    m.setCredential(CRED)
    const key = [...store.keys()][0]
    store.set(key, Buffer.from('garbage-without-prefix'))
    vi.resetModules()
    const m2 = await import('../credentials')
    expect(m2.getCredential()).toBeNull()
  })

  it('clear() removes the credential and the file', async () => {
    const m = await import('../credentials')
    m.setCredential(CRED)
    m.clearCredential()
    expect(m.getCredential()).toBeNull()
    expect(store.size).toBe(0)
  })

  it('notifies subscribers on set and clear, and stops after unsubscribe', async () => {
    const m = await import('../credentials')
    const cb = vi.fn()
    const off = m.onCredentialChanged(cb)
    m.setCredential(CRED)
    m.clearCredential()
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    m.setCredential(CRED)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it("reports 'none' when no credential has ever been set", async () => {
    const m = await import('../credentials')
    expect(m.credentialSource()).toBe('none')
  })

  it('caches the disk read after the first getCredential() call', async () => {
    const m = await import('../credentials')
    m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    // Corrupt the on-disk blob directly (bypassing setCredential/cache). If
    // getCredential() re-read from disk instead of serving the cached value,
    // this would now surface as null.
    const key = [...store.keys()][0]
    store.set(key, Buffer.from('garbage-without-prefix'))
    expect(m.getCredential()).toEqual(CRED)
  })

  it('does not touch disk at import time', async () => {
    store.set(BIN_PATH, Buffer.from('v10' + JSON.stringify(CRED)))
    // existsSync 走 Map.has,readFileSync 走 Map.get —— 两个都要盯,
    // 否则「导入时只调了 existsSync」会从指缝漏过去。
    const has = vi.spyOn(store, 'has')
    const get = vi.spyOn(store, 'get')
    const m = await import('../credentials')
    expect(has).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    // 首次读取才落到磁盘。
    expect(m.getCredential()).toEqual(CRED)
    expect(has).toHaveBeenCalled()
    has.mockRestore()
    get.mockRestore()
  })

  it('reads a credential written by a previous session', async () => {
    store.set(BIN_PATH, Buffer.concat([Buffer.from('v10'), Buffer.from(JSON.stringify(CRED))]))
    const m = await import('../credentials')
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('safeStorage')
  })

  it('treats malformed JSON inside a valid envelope as no credential', async () => {
    store.set(BIN_PATH, Buffer.concat([Buffer.from('v10'), Buffer.from('{not json')]))
    const m = await import('../credentials')
    expect(m.getCredential()).toBeNull()
  })

  // 篡改成合法 JSON 但字段残缺时,类型断言救不了 —— 不校验的话下游会发出
  // `Bearer undefined`,而正确行为是「当作没有凭证」。
  it('rejects a decrypted payload missing required fields', async () => {
    store.set(BIN_PATH, Buffer.concat([Buffer.from('v10'), Buffer.from('{"userId":"u1"}')]))
    const m = await import('../credentials')
    expect(m.getCredential()).toBeNull()
    expect(m.credentialSource()).toBe('none')
  })

  it('rejects a payload whose token is empty or whose expiresAt is not a number', async () => {
    const m0 = await import('../credentials')
    void m0
    for (const bad of [{ ...CRED, token: '' }, { ...CRED, expiresAt: 'soon' }]) {
      store.clear()
      vi.resetModules()
      store.set(BIN_PATH, Buffer.concat([Buffer.from('v10'), Buffer.from(JSON.stringify(bad))]))
      const m = await import('../credentials')
      expect(m.getCredential()).toBeNull()
    }
  })

  it('clear() also drops the in-memory fallback', async () => {
    encryptionAvailable = false
    const m = await import('../credentials')
    m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    m.clearCredential()
    expect(m.getCredential()).toBeNull()
    expect(m.credentialSource()).toBe('none')
  })

  // 直接把缓存对象交出去的话,调用方改一下就永久污染本会话的缓存。
  it('returns a copy, so a caller cannot mutate the cached credential', async () => {
    const m = await import('../credentials')
    m.setCredential(CRED)
    const first = m.getCredential()
    expect(first).not.toBeNull()
    first!.token = 'tampered'
    expect(m.getCredential()?.token).toBe('jwt.tok.en')
  })

  it('snapshots on write, so mutating the argument afterwards does not leak in', async () => {
    const m = await import('../credentials')
    const mutable = { ...CRED }
    m.setCredential(mutable)
    mutable.token = 'tampered-after-write'
    expect(m.getCredential()?.token).toBe('jwt.tok.en')
  })
})
