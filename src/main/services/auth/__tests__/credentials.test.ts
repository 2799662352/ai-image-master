import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ── 假盘:`node:fs/promises` 换成内存 Map ────────────────────────────────────
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
  rm: vi.fn(async (p: string) => void files.delete(p)),
}

vi.mock('node:fs/promises', () => ({ default: fsMock, ...fsMock }))

// ── 假 safeStorage:异步三件套,可注入「不可用 / 加密失败 / 卡住 / 要求重加密」 ─────
let encryptionAvailable = true
let encryptShouldThrow = false
let nextShouldReEncrypt = false
let encryptGate: Promise<void> | null = null
let decryptGate: Promise<void> | null = null
const encryptCalls: string[] = []
let decryptCalls = 0

/** 让之后的 encryptStringAsync 卡住,直到返回的 release() 被调用。 */
function holdEncrypt(): () => void {
  let release!: () => void
  encryptGate = new Promise<void>((r) => (release = r))
  return () => {
    release()
    encryptGate = null
  }
}
function holdDecrypt(): () => void {
  let release!: () => void
  decryptGate = new Promise<void>((r) => (release = r))
  return () => {
    release()
    decryptGate = null
  }
}

// 用平台中立的假目录:写死盘符会让「路径拼接跟着平台走」这件事更难看出来。
const FAKE_USER_DATA = path.join(path.sep, 'fake', 'userData')

vi.mock('electron', () => ({
  app: { getPath: () => path.join(path.sep, 'fake', 'userData') },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => encryptionAvailable,
    encryptStringAsync: async (s: string) => {
      encryptCalls.push(s)
      if (encryptGate) await encryptGate
      if (encryptShouldThrow) throw new Error('keychain access denied')
      return Buffer.concat([Buffer.from('v10'), Buffer.from(s, 'utf8')])
    },
    // 异步版返回 `{ result, shouldReEncrypt }`,不是字符串 —— 假实现必须保持这个形状,
    // 否则「实现忘了解构」这类 bug 在测试里是看不出来的。
    decryptStringAsync: async (b: Buffer) => {
      decryptCalls += 1
      if (decryptGate) await decryptGate
      if (!b.subarray(0, 3).equals(Buffer.from('v10'))) {
        throw new Error('Ciphertext does not appear to be encrypted.')
      }
      return { result: b.subarray(3).toString('utf8'), shouldReEncrypt: nextShouldReEncrypt }
    },
  },
}))

// 必须用 path.join 现算,不能写死带反斜杠的字面量:实现里是
// `path.join(app.getPath('userData'), FILENAME)`,而 path 未被 mock、分隔符随平台变 ——
// Linux 上会拼出 `C:\fake\userData/auth-credentials.bin`(正斜杠),写死的 key 便对不上。
// 症状很隐蔽:只走「实现写→实现读」往返的用例两边同 key 照样绿,唯独「预置文件再读回」
// 这类会在 CI 上红,本地 Windows 完全复现不出来。
const BIN_PATH = path.join(FAKE_USER_DATA, 'auth-credentials.bin')
const TMP_PATH = BIN_PATH + '.tmp'

const CRED = {
  token: 'jwt.tok.en',
  userId: 'u1',
  username: 'alice',
  displayName: 'Alice',
  role: 'USER',
  expiresAt: 1893456000000,
}

function cipher(obj: unknown): Buffer {
  return Buffer.concat([Buffer.from('v10'), Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))])
}

function plain(buf: Buffer | undefined): string {
  return buf ? buf.subarray(3).toString('utf8') : ''
}

describe('auth credentials', () => {
  beforeEach(() => {
    files.clear()
    encryptionAvailable = true
    encryptShouldThrow = false
    nextShouldReEncrypt = false
    encryptGate = null
    decryptGate = null
    encryptCalls.length = 0
    decryptCalls = 0
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function load() {
    const m = await import('../credentials')
    await m.initCredential()
    return m
  }

  // ── 保留自同步版的行为 ─────────────────────────────────────────────────────

  it('round-trips through safeStorage', async () => {
    const m = await load()
    expect(m.getCredential()).toBeNull()
    await m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('safeStorage')
    expect(files.has(BIN_PATH)).toBe(true)
    // 原子落位之后不该留下临时文件。
    expect(files.has(TMP_PATH)).toBe(false)
  })

  it('falls back to memory when encryption is unavailable', async () => {
    encryptionAvailable = false
    const m = await load()
    await m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('memory')
    expect(files.size).toBe(0)
  })

  // Electron 的 #55433:macOS 未签名时 Keychain 被拒,`isAsyncEncryptionAvailable()` 仍返回 true,
  // 随后 `encryptStringAsync()` reject。不兜住的话,登录就会因为「存不下来」而整个失败。
  it('falls back to memory instead of throwing when encryption reports available but then rejects', async () => {
    encryptShouldThrow = true
    const m = await load()
    await expect(m.setCredential(CRED)).resolves.toBeUndefined()
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('memory')
    expect(files.size).toBe(0)
  })

  it('treats a corrupted blob as no credential instead of throwing', async () => {
    const m = await load()
    await m.setCredential(CRED)
    files.set(BIN_PATH, Buffer.from('garbage-without-prefix'))
    vi.resetModules()
    const m2 = await load()
    expect(m2.getCredential()).toBeNull()
  })

  it('clear() removes the credential and the file (and any leftover temp file)', async () => {
    const m = await load()
    await m.setCredential(CRED)
    // 崩溃时可能残留的临时文件里是加密后的 token,登出后不该留在盘上。
    files.set(TMP_PATH, Buffer.from('leftover'))
    await m.clearCredential()
    expect(m.getCredential()).toBeNull()
    expect(files.size).toBe(0)
  })

  it('notifies subscribers on set and clear, and stops after unsubscribe', async () => {
    const m = await load()
    const cb = vi.fn()
    const off = m.onCredentialChanged(cb)
    await m.setCredential(CRED)
    await m.clearCredential()
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    await m.setCredential(CRED)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it("reports 'none' when no credential has ever been set", async () => {
    const m = await load()
    expect(m.credentialSource()).toBe('none')
  })

  it('serves reads from memory after the first load (does not re-read the disk)', async () => {
    const m = await load()
    await m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    // 直接把盘上的 blob 弄坏(绕过 setCredential / 缓存)。若 getCredential() 每次都重读盘,
    // 这里就会变成 null。
    files.set(BIN_PATH, Buffer.from('garbage-without-prefix'))
    expect(m.getCredential()).toEqual(CRED)
    const reads = fsMock.readFile.mock.calls.length
    m.getCredential()
    expect(fsMock.readFile.mock.calls.length).toBe(reads)
  })

  it('does not touch disk at import time, only once initCredential() runs', async () => {
    files.set(BIN_PATH, cipher(CRED))
    const m = await import('../credentials')
    expect(fsMock.readFile).not.toHaveBeenCalled()
    expect(decryptCalls).toBe(0)
    await m.initCredential()
    expect(fsMock.readFile).toHaveBeenCalledTimes(1)
    expect(m.getCredential()).toEqual(CRED)
  })

  it('reads a credential written by a previous session', async () => {
    files.set(BIN_PATH, cipher(CRED))
    const m = await load()
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('safeStorage')
  })

  it('treats malformed JSON inside a valid envelope as no credential', async () => {
    files.set(BIN_PATH, cipher('{not json'))
    const m = await load()
    expect(m.getCredential()).toBeNull()
  })

  // 篡改成合法 JSON 但字段残缺时,类型断言救不了 —— 不校验的话下游会发出
  // `Bearer undefined`,而正确行为是「当作没有凭证」。
  it('rejects a decrypted payload missing required fields', async () => {
    files.set(BIN_PATH, cipher('{"userId":"u1"}'))
    const m = await load()
    expect(m.getCredential()).toBeNull()
    expect(m.credentialSource()).toBe('none')
  })

  it('rejects a payload whose token is empty or whose expiresAt is not a number', async () => {
    for (const bad of [{ ...CRED, token: '' }, { ...CRED, expiresAt: 'soon' }]) {
      files.clear()
      vi.resetModules()
      files.set(BIN_PATH, cipher(bad))
      const m = await load()
      expect(m.getCredential()).toBeNull()
    }
  })

  it('clear() also drops the in-memory fallback', async () => {
    encryptionAvailable = false
    const m = await load()
    await m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    await m.clearCredential()
    expect(m.getCredential()).toBeNull()
    expect(m.credentialSource()).toBe('none')
  })

  // 直接把缓存对象交出去的话,调用方改一下就永久污染本会话的缓存。
  it('returns a copy, so a caller cannot mutate the cached credential', async () => {
    const m = await load()
    await m.setCredential(CRED)
    const first = m.getCredential()
    expect(first).not.toBeNull()
    first!.token = 'tampered'
    expect(m.getCredential()?.token).toBe('jwt.tok.en')
  })

  it('snapshots on write, so mutating the argument afterwards does not leak in', async () => {
    const m = await load()
    const mutable = { ...CRED }
    const pending = m.setCredential(mutable)
    mutable.token = 'tampered-after-write'
    await pending
    expect(m.getCredential()?.token).toBe('jwt.tok.en')
    expect(JSON.parse(plain(files.get(BIN_PATH))).token).toBe('jwt.tok.en')
  })

  // ── 异步化之后新增的行为 ───────────────────────────────────────────────────

  // `requireToken()` 等是同步读的。启动顺序错了(没等预热)只能返回 null —— 但这件事不能静默,
  // 也不能让它永久「看起来没登录」:打一次警告,并顺手补一次预热。
  it('getCredential() before initCredential() finishes: null + one warning, then self-heals', async () => {
    files.set(BIN_PATH, cipher(CRED))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const m = await import('../credentials')

    expect(m.getCredential()).toBeNull()
    expect(m.getCredential()).toBeNull()
    const preInitWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('before initCredential'))
    expect(preInitWarnings).toHaveLength(1)

    // 注意这里**不**显式调 initCredential():自愈靠的是 getCredential() 顺手补的那次预热。
    // 显式调的话,实现里那行补预热删掉也照样绿。
    await vi.waitFor(() => expect(m.getCredential()).toEqual(CRED))
  })

  it('initCredential() is idempotent: the disk is read and decrypted once', async () => {
    files.set(BIN_PATH, cipher(CRED))
    const m = await import('../credentials')
    await Promise.all([m.initCredential(), m.initCredential()])
    await m.initCredential()
    expect(decryptCalls).toBe(1)
  })

  // 官方做法(Electron #55318):shouldReEncrypt 为真时,把**已解出的明文**重新加密并落盘。
  it('shouldReEncrypt: still returns the credential and rewrites the file from the decrypted plaintext', async () => {
    files.set(BIN_PATH, cipher(CRED))
    nextShouldReEncrypt = true
    const m = await load()

    expect(m.getCredential()).toEqual(CRED)
    await vi.waitFor(() => expect(fsMock.rename).toHaveBeenCalledWith(TMP_PATH, BIN_PATH))
    expect(encryptCalls).toEqual([JSON.stringify(CRED)])
    expect(files.has(TMP_PATH)).toBe(false)
  })

  it('shouldReEncrypt: a failing re-encrypt neither fails the read nor damages the old file', async () => {
    const original = cipher(CRED)
    files.set(BIN_PATH, original)
    nextShouldReEncrypt = true
    encryptShouldThrow = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const m = await load()
    expect(m.getCredential()).toEqual(CRED)
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((c) => String(c[0]).includes('safeStorage write failed'))).toBe(true),
    )
    expect(files.get(BIN_PATH)).toEqual(original)
  })

  it('does not ask to re-encrypt when the flag is false', async () => {
    files.set(BIN_PATH, cipher(CRED))
    await load()
    // 重加密是异步排队的:预热一返回就断言「没有发生」,此刻它根本还没轮到,
    // 实现错了也是空的(时序假绿)。先让事件循环跑一圈,再断言「没有发生」。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(encryptCalls).toEqual([])
    expect(fsMock.rename).not.toHaveBeenCalled()
  })

  // 异步化之后最危险的一种交错:登录的加密还在进行时用户登出。
  // 写盘若不拦,**登出之后凭据又被写回盘上**,下次启动用户又登录了。
  it('logout while a login write is in flight: memory clears at once and the file never comes back', async () => {
    const m = await load()
    const release = holdEncrypt()
    const cb = vi.fn()
    m.onCredentialChanged(cb)

    const login = m.setCredential(CRED)
    await vi.waitFor(() => expect(encryptCalls).toHaveLength(1)) // 加密已经在飞
    expect(m.getCredential()).toEqual(CRED)

    const logout = m.clearCredential()
    // 登出必须同步生效,不能等磁盘:同步读者(请求头)此刻就不该再拿到 token。
    expect(m.getCredential()).toBeNull()

    release()
    await Promise.all([login, logout])

    expect(files.size).toBe(0)
    // 不只是「最终盘上没有」:登出之后,token 的密文**一次都不该碰盘**。串行队列保证了
    // 「先写后删」,所以光看最终状态,写盘前那道代际守卫删掉了也看不出来 —— 但那样就变成
    // 「写了再删」,两步之间进程退出,token 就原样留在盘上了。
    expect(fsMock.writeFile).not.toHaveBeenCalled()
    expect(m.getCredential()).toBeNull()
    expect(m.credentialSource()).toBe('none')
    // 被取代的登录写入不该再广播一次「已登录」。
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a stale in-flight write is dropped when a newer set supersedes it (last write wins, one notification)', async () => {
    const m = await load()
    const release = holdEncrypt()
    const cb = vi.fn()
    m.onCredentialChanged(cb)

    const first = m.setCredential({ ...CRED, token: 'token-A' })
    await vi.waitFor(() => expect(encryptCalls).toHaveLength(1))
    const second = m.setCredential({ ...CRED, token: 'token-B' })

    release()
    await Promise.all([first, second])

    expect(m.getCredential()?.token).toBe('token-B')
    expect(JSON.parse(plain(files.get(BIN_PATH))).token).toBe('token-B')
    // 被取代的那次连盘都没碰:只有 B 落过一次盘。
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  // 预热期间(读盘 / 解密都是 await)用户登出:不能让稍后才返回的盘上旧值把登出撤销。
  it('a logout that lands during initial load is not undone by the load finishing afterwards', async () => {
    files.set(BIN_PATH, cipher(CRED))
    const release = holdDecrypt()
    const m = await import('../credentials')

    const init = m.initCredential()
    await vi.waitFor(() => expect(decryptCalls).toBe(1))
    const logout = m.clearCredential()

    release()
    await Promise.all([init, logout])

    expect(m.getCredential()).toBeNull()
    expect(files.size).toBe(0)
  })

  // 覆盖写失败时,旧文件必须原样保留,而且要如实降级到内存、不留临时文件 ——
  // 不能「假装写成功」(那样下次重启拿到的是上一个 token)。
  it('a failed overwrite leaves the old file intact, leaves no temp file, and falls back to memory', async () => {
    const original = cipher({ ...CRED, token: 'old-token' })
    files.set(BIN_PATH, original)
    const m = await load()
    fsMock.rename.mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await m.setCredential(CRED)

    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('memory')
    expect(files.get(BIN_PATH)).toEqual(original)
    expect(files.has(TMP_PATH)).toBe(false)
  })
})
