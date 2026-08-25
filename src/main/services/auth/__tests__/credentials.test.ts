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
    store.set('C:\\fake\\userData\\auth-credentials.bin', Buffer.from('v10' + JSON.stringify(CRED)))
    const spy = vi.spyOn(store, 'get')
    await import('../credentials')
    expect(spy).not.toHaveBeenCalled()
  })
})
