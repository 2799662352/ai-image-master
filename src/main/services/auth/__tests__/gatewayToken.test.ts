import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const cred = { current: null as unknown }
vi.mock('../credentials', () => ({
  getCredential: () => cred.current,
}))
vi.mock('../session', () => ({ authBaseUrl: () => 'https://example.test' }))

// 落盘开关。默认值就是 brief 原始 mock 里那两个字面量(不可用 / 'unknown'),
// 由下面的 beforeEach 每条用例还原;只有落盘那几条会临时改。
// 写成可变对象而不是字面量,是因为 `basic_text` 那条必须让可用性检查返回 true
// —— 它正是「有加密能力但那个加密没用」这个陷阱本身,写死 false 就永远走不到
// 被测分支。
//
// 同步和异步两个可用性刻意分成两个开关:真机上它们可以给出不同结论(异步加密器
// 是惰性初始化的),而落盘走的是异步链路,判据用错哪个测得出来。
const storage = { available: false, asyncAvailable: false, backend: 'unknown' }

// `encryptionIsReal()` 现在按平台分支,所以每条碰到落盘的用例都得把平台钉死 ——
// 否则同一份代码在 Windows 开发机和 Linux CI 上跑出两种结果。
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true, enumerable: true })
}
function restorePlatform(): void {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
}
// 可控闸门。用来把「登出正好落在加密/解密进行中」这个瞬间变成确定性的:时序 bug
// 本地必然通过,必须在假实现里**故意卡住**才能做红绿验证。
// `reached` 让用例知道代码真的进到了那一步 —— 这一点是必需的,不是保险:登出如果早
// 于进入加密,外层 getGatewayToken 那道守卫会先拦下,persist() 根本不被调用,用例就
// 退化成在测已覆盖的路径,杀不掉本轮的变异。
interface Gate {
  /** 用例 await 它,确认代码真的卡在了这一步。 */
  reached: Promise<void>
  /** 用例调它放行。 */
  open: () => void
  wait: Promise<void>
  arrive: () => void
}
function makeGate(): Gate {
  let open!: () => void
  let arrive!: () => void
  const wait = new Promise<void>((r) => {
    open = r
  })
  const reached = new Promise<void>((r) => {
    arrive = r
  })
  return { reached, open, wait, arrive }
}
// 写成可变对象、由 beforeEach 还原成 null,与上面 storage 同一个套路 —— 比
// mockImplementationOnce 稳:beforeEach 用的是 mockClear,它不清未被消费的 once
// 实现,那种残留会漏到下一条用例。
const gates: { encrypt: Gate | null; decrypt: Gate | null } = { encrypt: null, decrypt: null }
// 先通知「到了」,再真正阻塞。
async function passGate(gate: Gate | null): Promise<void> {
  if (!gate) return
  gate.arrive()
  await gate.wait
}

const encryptStringAsync = vi.fn(async (s: string) => {
  await passGate(gates.encrypt)
  return Buffer.from(s, 'utf8')
})
// 异步版返回的是 `{ shouldReEncrypt, result }`,不是字符串 —— 照着真 API 的形状 mock,
// 否则「实现直接把它丢给 JSON.parse」这个真实存在的坑测不出来。
const decryptStringAsync = vi.fn(async (b: Buffer) => {
  await passGate(gates.decrypt)
  return {
    shouldReEncrypt: false,
    result: b.toString('utf8'),
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    isAsyncEncryptionAvailable: async () => storage.asyncAvailable,
    getSelectedStorageBackend: () => {
      // Electron 43.2.0 + win32 实测:这个方法在非 Linux 上**根本不存在**
      // (`typeof safeStorage.getSelectedStorageBackend === 'undefined'`),调用抛
      // TypeError,而不是像旧注释写的那样返回 'unknown'。照实模拟 —— 否则
      // 「非 Linux 上永远落不了盘」这个真实存在的 bug 一条用例都测不出来。
      if (process.platform !== 'linux') {
        throw new TypeError('safeStorage.getSelectedStorageBackend is not a function')
      }
      return storage.backend
    },
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
  // 形参写出来是为了能断言 rm 的入参(路径 + force),不写的话 `mock.calls[0]`
  // 的类型是空元组,取下标是类型错。
  rm: vi.fn(async (_target: string, _options?: { force?: boolean }) => {}),
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
  restorePlatform()
  storage.available = false
  storage.asyncAvailable = false
  storage.backend = 'unknown'
  gates.encrypt = null
  gates.decrypt = null
  // 用 mockClear 而不是 mockReset:后者会把上面那几个 implementation 一起抹掉,
  // 于是 readFile 不再抛 ENOENT、writeFile 返回 undefined 而不是 Promise。
  encryptStringAsync.mockClear()
  decryptStringAsync.mockClear()
  fsMock.writeFile.mockClear()
  fsMock.readFile.mockClear()
  fsMock.rm.mockClear()
})

afterEach(restorePlatform)

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

  // 登出与在途请求的竞态。`inflight.clear()` 只删 Map 条目,**取消不了已经建好
  // 的 promise 链**:那条链稍后 resolve 时若照常写缓存 + 落盘,就会在 `fs.rm`
  // 跑完之后把加密文件重新写回磁盘。用户点了登出,盘上却还躺着一枚永不过期、
  // 无法单独吊销的 token。触发窗口是「切池 / 登录成功后取 token」那一小段。
  it('登出后,在途请求 resolve 时既不回填缓存也不重新落盘', async () => {
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
    storage.backend = 'gnome_libsecret'
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    fetchMock.mockImplementation(async () => {
      await gate
      return ok('sk-inflight')
    })
    const m = await import('../gatewayToken')

    const pending = m.getGatewayToken(POOL)
    await m.clearGatewayTokens()
    // clear 自己会删盘。下面要断言的是「clear **之后**再没写过盘」,所以从这里
    // 重新计数。
    fsMock.writeFile.mockClear()

    release()
    // token 照常还给调用方 —— 修法是不写状态,不是让在途请求失败。
    await expect(pending).resolves.toBe('sk-inflight')

    // ① 缓存没被重新填回来。activePool 必须在 clear **之后**再设:直接沿用
    // clear 前设的那个,「activePool 被清了」会替「缓存空了」把这条撑绿。
    m.setActivePool(POOL)
    expect(m.getActivePoolToken()).toBeNull()
    // ② 加密文件没被重新写回磁盘。
    expect(fsMock.writeFile).not.toHaveBeenCalled()
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
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
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
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
    storage.backend = 'gnome_libsecret'
    fetchMock.mockResolvedValue(ok('sk-linux'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken(POOL)

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
    // 明文必须先经 encryptStringAsync 再落盘,不能 writeFile(JSON) 直接写。
    expect(encryptStringAsync).toHaveBeenCalledTimes(1)
    expect(String(encryptStringAsync.mock.calls[0][0])).toContain('sk-linux')
  })

  // 判据必须是「**等于** basic_text」而不是「不在白名单里」。后端枚举一直在长
  // (kwallet → kwallet5 → kwallet6 一路加过来),白名单写死在今天,Electron 明天
  // 加个 kwallet7 就会静默停止落盘。只否掉已知坏的那一个,不认识的按好的用。
  // 没有这条,把实现换成白名单版本一样全绿。
  it('后端不是 basic_text 就照常落盘,哪怕这个值不认识', async () => {
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
    storage.backend = 'unknown'
    fetchMock.mockResolvedValue(ok('sk-unknown-backend'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken(POOL)

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
  })

  // Electron 43.2.0 + win32 实测:getSelectedStorageBackend 根本不存在,调用抛
  // TypeError(上面的 electron mock 照实模拟了)。实现里不显式短路非 Linux 的话,
  // 它会掉进 encryptionIsReal 的 catch —— 落盘在我们的主力平台上永久失效,每次
  // 重启白白多一次网络往返,而且一个错都不报,没人会发现。
  it('非 Linux 上不看 backend,照常落盘', async () => {
    setPlatform('win32')
    storage.available = true
    storage.asyncAvailable = true
    // 摆一个 Linux 语义的坏值在这:它压根不该被读到。
    storage.backend = 'basic_text'
    fetchMock.mockResolvedValue(ok('sk-win'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken(POOL)

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
  })

  // 异步加密器是惰性初始化的(electron.d.ts:11881),和同步的
  // isEncryptionAvailable() 可以给出不同结论。用同步版把关的话,这里会放行到
  // encryptStringAsync,而它 reject 之后被 persist 调用处的 `.catch(() => {})`
  // 整个吞掉 —— 「以为落了盘,其实一直没有」,零信号。
  it('同步说可用但异步说不可用时,不落盘', async () => {
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = false
    storage.backend = 'gnome_libsecret'
    fetchMock.mockResolvedValue(ok('sk-async-unavailable'))
    const m = await import('../gatewayToken')

    await expect(m.getGatewayToken(POOL)).resolves.toBe('sk-async-unavailable')
    expect(encryptStringAsync).not.toHaveBeenCalled()
    expect(fsMock.writeFile).not.toHaveBeenCalled()
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
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
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
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
    storage.backend = 'gnome_libsecret'
    // 默认实现就抛 ENOENT(首次启动、或换了机器解不开)。
    const m = await import('../gatewayToken')

    await expect(m.loadPersisted()).resolves.toBeUndefined()
  })

  // 与「登出后在途请求」那条同一个 bug 的第二个落点。外层 getGatewayToken 的守卫只
  // 管到 cache.set,persist() 内部还隔着两个 await(可用性探测 + 加密);登出落在
  // 加密那一段时,payload 已经在登出**之前**快照好了,密文里带着 token,而 fs.rm
  // 早已跑完 —— 写下去等于把 token 亲手送回盘上。
  it('登出落在「加密完成、还没写盘」之间时,密文不得落回磁盘', async () => {
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
    storage.backend = 'gnome_libsecret'
    const gate = makeGate()
    gates.encrypt = gate
    fetchMock.mockResolvedValue(ok('sk-persist-race'))
    const m = await import('../gatewayToken')

    const pending = m.getGatewayToken(POOL)
    // 必须等到真的进了 encryptStringAsync 才登出。早一步的话外层那道守卫会先拦下,
    // persist() 压根不被调用,这条用例就退化成在测已经覆盖过的路径。
    await gate.reached
    await m.clearGatewayTokens()
    gate.open()
    // token 照常还给调用方,和另一条竞态用例一致:修法是不写状态,不是让请求失败。
    await expect(pending).resolves.toBe('sk-persist-race')

    expect(fsMock.writeFile).not.toHaveBeenCalled()
  })

  // 第三个落点:loadPersisted() 此前一道守卫都没有。登出落在读盘或解密期间时,
  // 盘上那份会被解回内存,getActivePoolToken() 随后就能把它交给 header 注入器,
  // 下一次 persist() 再把它写回盘 —— 登出被整个撤销。
  it('登出落在「读盘、解密」期间时,盘上那份不得被解回内存', async () => {
    setPlatform('linux')
    storage.available = true
    storage.asyncAvailable = true
    storage.backend = 'gnome_libsecret'
    fsMock.readFile.mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ '342:': 'sk-from-disk' }), 'utf8'),
    )
    const gate = makeGate()
    gates.decrypt = gate
    const m = await import('../gatewayToken')

    const pending = m.loadPersisted()
    await gate.reached
    await m.clearGatewayTokens()
    gate.open()
    await expect(pending).resolves.toBeUndefined()

    // activePool 在 clear **之后**才设:否则「activePool 被清了」会替「缓存空了」
    // 把这条撑绿。
    m.setActivePool(POOL)
    expect(m.getActivePoolToken()).toBeNull()
  })

  // clearGatewayTokens 里唯一与安全相关的那半边:内存清干净了、盘上那份还在,
  // 等于没登出 —— 那枚 token 永不过期,也没法单独吊销。删掉实现里的 fs.rm,
  // 其余用例一条都不会红。
  it('clearGatewayTokens() 把盘上的加密文件一并删掉', async () => {
    const m = await import('../gatewayToken')

    await m.clearGatewayTokens()

    expect(fsMock.rm).toHaveBeenCalledTimes(1)
    const [target, options] = fsMock.rm.mock.calls[0]
    expect(String(target)).toContain('gateway-tokens.enc')
    // 少了 force,文件不存在时 rm 会抛 ENOENT,再被调用处的 .catch 吞掉。
    expect(options).toEqual({ force: true })
  })
})
