import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const cred = { current: null as unknown }
vi.mock('../credentials', () => ({
  getCredential: () => cred.current,
}))
vi.mock('../session', () => ({ authBaseUrl: () => 'https://example.test' }))

// 落盘开关。默认值就是 brief 原始 mock 里那两个字面量(不可用 / 'unknown'),
// 由下面的 beforeEach 每条用例还原;只有落盘那两条会临时改。
// 写成可变对象而不是字面量,是因为 `basic_text` 那条必须让
// `isEncryptionAvailable()` 返回 true —— 它正是「有加密能力但那个加密没用」
// 这个陷阱本身,写死 false 就永远走不到被测分支。
const storage = { available: false, backend: 'unknown' }
const encryptStringAsync = vi.fn(async (s: string) => Buffer.from(s, 'utf8'))
// 异步版返回的是 `{ shouldReEncrypt, result }`,不是字符串 —— 照着真 API 的形状 mock,
// 否则「实现直接把它丢给 JSON.parse」这个真实存在的坑测不出来。
const decryptStringAsync = vi.fn(async (b: Buffer) => ({
  shouldReEncrypt: false,
  result: b.toString('utf8'),
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => storage.backend,
    encryptStringAsync,
    decryptStringAsync,
  },
  app: { getPath: () => '/tmp' },
}))

// 实现用的是 `import { promises as fs } from 'node:fs'`,所以只需要 promises 这一层。
const fsMock = {
  writeFile: vi.fn(async () => {}),
  // 返回类型必须显式写 `Promise<Buffer>`。只写函数体的话 TS 从「只会 throw」推出
  // `Promise<never>`,后面 `mockResolvedValueOnce(Buffer)` 就成了「不能把 Buffer
  // 赋给 never」。tsconfig 排除了 `**/*.test.ts`,所以 `tsc --noEmit` 看不到这个错。
  readFile: vi.fn(async (): Promise<Buffer> => {
    throw new Error('ENOENT')
  }),
  rm: vi.fn(async () => {}),
}
vi.mock('node:fs', () => ({ promises: fsMock, default: { promises: fsMock } }))

function ok(token: string) {
  return { ok: true, status: 200, json: async () => ({ success: true, data: { token_key: token } }) }
}

function fail(status: number, code: string, message = '后端说不行') {
  return { ok: false, status, json: async () => ({ success: false, error: { code, message } }) }
}

const POOL = { projectId: 342, producerProjectId: null }

beforeEach(() => {
  vi.resetModules()
  fetchMock.mockReset()
  cred.current = { token: 'jwt.tok', userId: 'u1' }
  storage.available = false
  storage.backend = 'unknown'
  // 用 mockClear 而不是 mockReset:后者会把上面那几个 implementation 一起抹掉,
  // 于是 readFile 不再抛 ENOENT、writeFile 返回 undefined 而不是 Promise。
  encryptStringAsync.mockClear()
  decryptStringAsync.mockClear()
  fsMock.writeFile.mockClear()
  fsMock.readFile.mockClear()
  fsMock.rm.mockClear()
})

describe('gatewayToken 缓存键', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    cred.current = { token: 'jwt.tok', userId: 'u1' }
  })

  // 两个 producer 项目可以共用同一个 projectId。只按 projectId 做键会把两个
  // 不同的钱包合并 —— 用户切到另一个 producer 池后仍在花前一个池的钱。
  it('projectId 相同但 producerProjectId 不同时，不复用缓存', async () => {
    fetchMock.mockResolvedValueOnce(ok('sk-pool-a')).mockResolvedValueOnce(ok('sk-pool-b'))
    const m = await import('../gatewayToken')

    const a = await m.getGatewayToken({ projectId: 342, producerProjectId: 11 })
    const b = await m.getGatewayToken({ projectId: 342, producerProjectId: 22 })

    expect(a).toBe('sk-pool-a')
    expect(b).toBe('sk-pool-b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同一个池第二次命中缓存，不重复请求', async () => {
    fetchMock.mockResolvedValue(ok('sk-same'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken({ projectId: 342, producerProjectId: null })
    await m.getGatewayToken({ projectId: 342, producerProjectId: null })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('gatewayToken 取用', () => {
  it('未登录时抛 NOT_LOGGED_IN,且一个请求都不发', async () => {
    cred.current = null
    const m = await import('../gatewayToken')

    await expect(m.getGatewayToken(POOL)).rejects.toMatchObject({
      name: 'GatewayTokenError',
      code: 'NOT_LOGGED_IN',
    })
    // 「不发请求」和「抛对码」是两件事。少了这条,一个先发请求再看凭据的实现
    // 也能绿 —— 而那会拿 `Bearer undefined` 去打后端。
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('带平台 JWT 作 Bearer —— 换成别的字段后端一律 401', async () => {
    fetchMock.mockResolvedValue(ok('sk-x'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken(POOL)

    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer jwt.tok' },
    })
  })

  // 渲染层要按这个码引导用户换组织,所以它必须原样透出,不能被 `HTTP_403` 盖掉。
  it('403 时原样透出后端错误码', async () => {
    fetchMock.mockResolvedValueOnce(fail(403, 'PROJECT_NOT_ALLOCATED', '你不在该组织'))
    const m = await import('../gatewayToken')

    await expect(m.getGatewayToken(POOL)).rejects.toMatchObject({
      code: 'PROJECT_NOT_ALLOCATED',
      message: '你不在该组织',
    })
  })

  it('5xx 标记为可重试', async () => {
    fetchMock.mockResolvedValueOnce(fail(503, 'UPSTREAM_DOWN'))
    const m = await import('../gatewayToken')

    await expect(m.getGatewayToken(POOL)).rejects.toMatchObject({ retryable: true })
  })

  // 与上一条成对:只有一条的话,把 retryable 写死成任一常量都能有一条陪着绿。
  it('403 标记为不可重试 —— 重试多少次都一样,得换组织', async () => {
    fetchMock.mockResolvedValueOnce(fail(403, 'PROJECT_NOT_ALLOCATED'))
    const m = await import('../gatewayToken')

    await expect(m.getGatewayToken(POOL)).rejects.toMatchObject({ retryable: false })
  })

  it('200 但 body 缺 token_key 时抛 MALFORMED_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    })
    const m = await import('../gatewayToken')

    await expect(m.getGatewayToken(POOL)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      retryable: true,
    })
  })

  it('同一个池的并发请求合流成一次网络往返', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let n = 0
    // 每次真打网络都发一个**不同的** token。只断言调用次数的话,一个「合流失败
    // 但恰好都拿到同样假数据」的实现也能绿;发不同 token 才能让三个 Promise
    // 拿到的字符串本身成为证据。
    fetchMock.mockImplementation(async () => {
      await gate
      n += 1
      return ok(`sk-${n}`)
    })

    const m = await import('../gatewayToken')
    // 三个**不同的对象**、同样的值 —— 顺带钉死「按值做键」而不是按对象身份。
    const all = Promise.all([
      m.getGatewayToken({ projectId: 342, producerProjectId: 7 }),
      m.getGatewayToken({ projectId: 342, producerProjectId: 7 }),
      m.getGatewayToken({ projectId: 342, producerProjectId: 7 }),
    ])
    // 三个都挂在 gate 上之后再放行,确保第一个请求没机会先落缓存 ——
    // 否则走的是缓存命中那条路,合流根本没被测到。
    release()

    expect(await all).toEqual(['sk-1', 'sk-1', 'sk-1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('clearGatewayTokens() 之后再取会重新请求', async () => {
    fetchMock.mockResolvedValueOnce(ok('sk-first')).mockResolvedValueOnce(ok('sk-second'))
    const m = await import('../gatewayToken')

    expect(await m.getGatewayToken(POOL)).toBe('sk-first')
    await m.clearGatewayTokens()

    expect(await m.getGatewayToken(POOL)).toBe('sk-second')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearGatewayTokens() 一并清掉 activePool,不只是清缓存', async () => {
    fetchMock.mockResolvedValue(ok('sk-tok'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken(POOL)
    m.setActivePool(POOL)
    expect(m.getActivePoolToken()).toBe('sk-tok')

    await m.clearGatewayTokens()
    // 关键:清完之后**把缓存重新填回来**再断言。直接在清空状态下断言 null 的话,
    // 「缓存空了」会替「activePool 被清了」把这条撑绿 —— 删掉实现里的
    // `activePool = null` 也不会红,这条就成了摆设。
    await m.getGatewayToken(POOL)
    expect(m.getActivePoolToken()).toBeNull()
  })

  // brief 的 8 条没覆盖 getActivePoolToken,而它恰恰是「两半键」这条纪律在
  // 热路径上的落点:header 注入器读的是它,读错就是花错池子的钱。
  it('getActivePoolToken 也按两半键读', async () => {
    fetchMock.mockResolvedValueOnce(ok('sk-pool-a')).mockResolvedValueOnce(ok('sk-pool-b'))
    const m = await import('../gatewayToken')
    const a = { projectId: 342, producerProjectId: 11 }
    const b = { projectId: 342, producerProjectId: 22 }

    await m.getGatewayToken(a)
    m.setActivePool(a)
    expect(m.getActivePoolToken()).toBe('sk-pool-a')

    // 只按 projectId 认的实现会在这里返回 sk-pool-a:用户切了池,钱还从上一个池出。
    m.setActivePool(b)
    expect(m.getActivePoolToken()).toBeNull()

    await m.getGatewayToken(b)
    expect(m.getActivePoolToken()).toBe('sk-pool-b')

    m.setActivePool(null)
    expect(m.getActivePoolToken()).toBeNull()
  })

  it('producerProjectId 为 null 时 URL 里不出现该参数', async () => {
    fetchMock.mockResolvedValue(ok('sk-x'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken({ projectId: 342, producerProjectId: null })

    const url = String(fetchMock.mock.calls[0][0])
    // 无脑 set 会拼出 `producerProjectId=null`,后端 parseInt 拿到 NaN。
    expect(url).not.toContain('producerProjectId')
    expect(url).toContain('projectId=342')
  })

  // 与上一条成对:少了这条,一个「永远不发 producerProjectId」的实现也能绿。
  it('producerProjectId 有值时才带上该参数', async () => {
    fetchMock.mockResolvedValue(ok('sk-y'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken({ projectId: 342, producerProjectId: 11 })

    expect(String(fetchMock.mock.calls[0][0])).toContain('producerProjectId=11')
  })
})

describe('gatewayToken 落盘', () => {
  it('basic_text 后端时不落盘 —— 它用硬编码明文口令,等于没加密', async () => {
    storage.available = true
    storage.backend = 'basic_text'
    fetchMock.mockResolvedValue(ok('sk-linux'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken(POOL)

    expect(fsMock.writeFile).not.toHaveBeenCalled()
    expect(encryptStringAsync).not.toHaveBeenCalled()
  })

  // 与上一条成对。没有这条的话,一个「任何情况下都不落盘」的实现(比如
  // encryptionIsReal 恒 false)也能让上一条绿 —— 那条就白写了。
  it('真加密后端时才落盘,且必须过 safeStorage', async () => {
    storage.available = true
    storage.backend = 'gnome_libsecret'
    fetchMock.mockResolvedValue(ok('sk-linux'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken(POOL)

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
    // 明文必须先经 encryptStringAsync 再落盘,不能 writeFile(JSON) 直接写。
    expect(encryptStringAsync).toHaveBeenCalledTimes(1)
    expect(String(encryptStringAsync.mock.calls[0][0])).toContain('sk-linux')
  })

  // isEncryptionAvailable() 为 false 时(brief 原始 mock 的默认态)同样不落盘,
  // 且这不是错误:只留内存,重启后重取。
  it('加密不可用时静默只留内存,不让取 token 整体失败', async () => {
    fetchMock.mockResolvedValue(ok('sk-mem'))
    const m = await import('../gatewayToken')

    await expect(m.getGatewayToken(POOL)).resolves.toBe('sk-mem')
    expect(fsMock.writeFile).not.toHaveBeenCalled()
  })

  // 钉死 decryptStringAsync 的返回形状。它返回 `{ shouldReEncrypt, result }`,
  // 把整个对象交给 JSON.parse 会被 stringify 成 "[object Object]" 而抛 SyntaxError,
  // 再被 loadPersisted 自己的 catch 吞掉 —— 表现为「落了盘但重启后永远读不回来」,
  // 一个错都不报。没有这条用例,那个 bug 改回去也不会红。
  it('loadPersisted() 把上次落盘的 token 读回缓存', async () => {
    storage.available = true
    storage.backend = 'gnome_libsecret'
    fsMock.readFile.mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ '342:': 'sk-restored' }), 'utf8'),
    )
    const m = await import('../gatewayToken')

    await m.loadPersisted()

    // 读回来了就不该再打网络 —— 这才是落盘的全部意义。
    await expect(m.getGatewayToken(POOL)).resolves.toBe('sk-restored')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('落盘文件读不出来时当作没有,不抛给调用方', async () => {
    storage.available = true
    storage.backend = 'gnome_libsecret'
    // 默认实现就抛 ENOENT(首次启动、或换了机器解不开)。
    const m = await import('../gatewayToken')

    await expect(m.loadPersisted()).resolves.toBeUndefined()
  })
})
