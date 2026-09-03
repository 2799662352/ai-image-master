// IdP 客户端。被测的是「契约对齐」而不是「代码跑通」——
// 后端两套错误信封、201 vs 200、可选字段兜底,每一条错了都只在真机上才暴露。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
// 仅类型 —— 编译期被擦除,不会在 `vi.mock` 之前把真模块拉进来。用它给 it.each 的
// 「换个函数、同一套断言」表格标注参数类型,免得每个函数各抄一遍同样的用例。
import type * as SessionModule from '../session'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...a: unknown[]) => fetchMock(...a) } }))

const cred = {
  current: null as null | Record<string, unknown>,
  source: 'none' as 'safeStorage' | 'memory' | 'none',
}
vi.mock('../credentials', () => ({
  getCredential: () => cred.current,
  setCredential: (c: Record<string, unknown>) => {
    cred.current = c
    cred.source = 'safeStorage'
  },
  clearCredential: () => {
    cred.current = null
    cred.source = 'none'
  },
  credentialSource: () => cred.source,
}))

// 网关 token 是平台余额那条路的第二套凭据。这里 mock 掉,免得把真模块拉进来 ——
// 它模块级就 import 了 `app` / `safeStorage`,而本文件的 electron mock 只给了 `net`。
const clearGatewayTokens = vi.fn()
vi.mock('../gatewayToken', () => ({
  clearGatewayTokens: () => clearGatewayTokens(),
}))

/** 后端配对路由的信封。注意 start 是 201。 */
const ok = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ success: true, data }) }) as unknown as Response

/**
 * payment 路由的成功信封是 `{ok:true,data}`,usage 路由是 `{success:true,data}`
 * (计划 §1.3 / §1.1)。两者都把负载放在 `data` 下,所以主进程一套解包够用 ——
 * 但得有一条用例真的喂 `ok:true` 那一套,否则「只认 success」的实现也能全绿。
 */
const okPay = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ ok: true, data }) }) as unknown as Response

/**
 * **查单**的响应信封 —— 比建单多包一层 `data.order`（`payment.ts:310-329` vs
 * `:151,219`）。同一个资源、两个形状。
 *
 * 单独给它一个助手而不是让调用点手写 `okPay({ order: … })`：这层嵌套是实测来的，
 * 一开始整套用例都误用了扁平形状、于是和同样漏剥一层的实现一起全绿。少剥这一层
 * 不会报错，字段全读成 undefined、status 经 `toRechargeStatus` 退化成 `PENDING`，
 * 表现是轮询永远等不到 `CREDITED`：钱到账了却一直显示「未完成」直到超时。
 */
const okOrder = (order: unknown) => okPay({ order })

/** 配对路由的错误信封:带 error.code。 */
const errCoded = (status: number, code: string) =>
  ({
    ok: false,
    status,
    json: async () => ({ success: false, error: { code, message: 'x' } }),
  }) as unknown as Response

/** authMiddleware 的错误信封:只有 message,没有 error.code。 */
const errBare = (status: number) =>
  ({ ok: false, status, json: async () => ({ success: false, message: '没权限' }) }) as unknown as Response

/** Task 5 会持有真的 verifier;这里只需要一对稳定的 challenge/state。 */
const PKCE = { codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', state: 'st4te' }

const SESSION = {
  token: 'jwt.tok.en',
  user: { id: 'u1', username: 'alice' }, // 刻意不给 displayName / role
  expiresAt: 1893456000000,
}

describe('auth session', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    cred.current = null
    cred.source = 'none'
    delete process.env.CATIMATION_AUTH_BASE_URL
    // mockReset + 重设实现,不用 mockClear:下面有一条用例把它换成永不 resolve 的闸门,
    // mockClear 不清实现,那个闸门会漏到后面每一条探测用例上、把它们全挂住。
    clearGatewayTokens.mockReset()
    clearGatewayTokens.mockResolvedValue(undefined)
    vi.useRealTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('authBaseUrl 缺省指向官网,并归一化末尾斜杠', async () => {
    const m = await import('../session')
    const { allowAuthBaseUrlOverride } = await import('../authBaseUrl')

    expect(m.authBaseUrl()).toBe('https://13797248455.xyz')

    // 🚨 **闸默认是关的**,只设环境变量不生效 —— 这一条正是打包产物的行为:
    // 生产构建无视 `CATIMATION_AUTH_BASE_URL`,免得被牵去测试服后端,而网关那侧
    // 另有硬闸仍指生产 —— 两边劈叉的表现是一句没头没脑的 401(2026-08-31 撞过)。
    process.env.CATIMATION_AUTH_BASE_URL = 'https://staging.example.com/'
    expect(m.authBaseUrl()).toBe('https://13797248455.xyz')

    // 开发构建由组合根打开闸之后才认。
    allowAuthBaseUrlOverride(true)
    try {
      expect(m.authBaseUrl()).toBe('https://staging.example.com')
    } finally {
      allowAuthBaseUrlOverride(false)
    }
  })

  // 后端缺 codeChallenge / state 会 400,所以这里用 toEqual 逐字段钉死整个请求体。
  // 原来用的是 toMatchObject + 只列三个字段,那样即使 PKCE 根本没进 body 也照样绿 ——
  // 测试全绿、真机必挂,正是这个缺口让签名漏掉了 pkce 参数。
  it('startPairing 打对端点,请求体含 PKCE 与回环参数,并接受 201', async () => {
    fetchMock.mockResolvedValue(ok({ pairingId: 'p1', authorizeUrl: 'https://x/y', expiresIn: 300 }, 201))
    const m = await import('../session')
    const r = await m.startPairing('CATIMATION', { host: '127.0.0.1', port: 51789 }, PKCE)

    expect(r).toEqual({ pairingId: 'p1', authorizeUrl: 'https://x/y', expiresIn: 300 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://13797248455.xyz/api/auth/desktop/start')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      codeChallenge: PKCE.codeChallenge,
      state: PKCE.state,
      clientName: 'CATIMATION',
      callbackHost: '127.0.0.1',
      callbackPort: 51789,
    })
  })

  it('无回环参数时不发 callbackHost / callbackPort', async () => {
    fetchMock.mockResolvedValue(ok({ pairingId: 'p1', authorizeUrl: 'https://x/y', expiresIn: 300 }, 201))
    const m = await import('../session')
    await m.startPairing('CATIMATION', null, PKCE)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      codeChallenge: PKCE.codeChallenge,
      state: PKCE.state,
      clientName: 'CATIMATION',
    })
  })

  it('startPairing 抛出带 code 的错误,供 IPC 层转成用户文案', async () => {
    fetchMock.mockResolvedValue(errCoded(400, 'INVALID_CALLBACK_HOST'))
    const m = await import('../session')
    await expect(m.startPairing('CATIMATION', null, PKCE)).rejects.toMatchObject({
      code: 'INVALID_CALLBACK_HOST',
    })
  })

  // 这三个码是用户唯一会真的撞上的:超时、重放、点了拒绝。
  it.each([
    [410, 'PAIRING_EXPIRED'],
    [409, 'PAIRING_ALREADY_CLAIMED'],
    [409, 'PAIRING_NOT_APPROVED'],
  ])('claimPairing 透传 %i %s', async (status, code) => {
    fetchMock.mockResolvedValue(errCoded(status, code))
    const m = await import('../session')
    await expect(m.claimPairing('p1', 'g', 'v')).rejects.toMatchObject({ code })
    expect(cred.current).toBeNull()
  })

  it('claim 成功后落盘,可选字段有兜底,状态变成已登录', async () => {
    fetchMock.mockResolvedValue(ok(SESSION))
    const m = await import('../session')
    await m.claimPairing('p1', 'the-grant', 'the-verifier')

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      pairingId: 'p1',
      grantCode: 'the-grant',
      codeVerifier: 'the-verifier',
    })
    // SESSION 没给 displayName / role —— 不兜底的话 Task 3 的 parseCredential
    // 下次会把这条凭证判成「无凭证」。
    expect(cred.current).toEqual({
      token: 'jwt.tok.en',
      userId: 'u1',
      username: 'alice',
      displayName: 'alice',
      role: 'USER',
      expiresAt: 1893456000000,
    })
    expect(m.getAuthState()).toEqual({
      authenticated: true,
      username: 'alice',
      displayName: 'alice',
      role: 'USER',
      credentialSource: 'safeStorage',
    })
  })

  it('getAuthState 未登录时不泄露任何身份字段', async () => {
    const m = await import('../session')
    expect(m.getAuthState()).toEqual({
      authenticated: false,
      username: null,
      displayName: null,
      role: null,
      credentialSource: 'none',
    })
  })

  it('探测带上 Bearer 头,60 秒内只发一次', async () => {
    cred.current = { token: 'jwt.tok.en', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockResolvedValue(errCoded(400, 'VALIDATION_ERROR')) // 缺 projectId,但已过鉴权
    const m = await import('../session')

    await m.probeLiveness()
    await m.probeLiveness()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://13797248455.xyz/api/user/balance')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt.tok.en')
    expect(cred.current).not.toBeNull() // 400 = 存活
  })

  it('缓存过期后会再发一次', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockResolvedValue(errCoded(400, 'VALIDATION_ERROR'))
    const m = await import('../session')

    await m.probeLiveness()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    await m.probeLiveness()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('网络故障时 fail-open,保住登录态', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const m = await import('../session')

    await expect(m.probeLiveness()).resolves.toBeUndefined()
    expect(cred.current).not.toBeNull()
  })

  // authMiddleware 的信封没有 error.code —— 只按 error.code 分支的实现会在这里漏掉封号。
  it.each([401, 403])('%i 清凭证,即使响应体里没有 error.code', async (status) => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockResolvedValue(errBare(status))
    const m = await import('../session')

    await m.probeLiveness()
    expect(cred.current).toBeNull()
    expect(m.getAuthState().authenticated).toBe(false)
  })

  // 401/403 正是**账号被后台停用 / 被踢下线**的那一刻。网关 token 永不过期、无法单独
  // 吊销 —— 这恰恰是它最不该被留下的时刻:不清的话,被停用的账号仍能接着花平台余额,
  // 直到用户自己想起来点一次登出。
  //
  // ⚠️ 这条探测路径**目前没有生产调用方**(`probeLiveness` 全仓只有定义与测试),
  // 所以它守的是「将来接上定时探测时这段仍然对」,而不是今天线上真有这层防护。
  // 断言两件事一起发生,是因为它现在走的是 `logout()` —— 不变量在那里,不在这里。
  it.each([401, 403])('%i 时走 logout(),平台凭据与网关 token 一起清', async (status) => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockResolvedValue(errBare(status))
    const m = await import('../session')

    await m.probeLiveness()

    expect(cred.current).toBeNull()
    expect(clearGatewayTokens).toHaveBeenCalled()
  })

  // 存活(400)时**不能**清 —— 顺手多清一次的代价是每 60 秒把缓存和落盘全丢掉,
  // 之后每张图都要多一次网络往返去重取 token,而且一个信号都没有。
  it('探测判定存活时不碰网关 token', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockResolvedValue(errCoded(400, 'VALIDATION_ERROR'))
    const m = await import('../session')

    await m.probeLiveness()

    expect(clearGatewayTokens).not.toHaveBeenCalled()
  })

  // `clearGatewayTokens` 是 async,里面压着一次 `fs.rm`。不 await 的话 probeLiveness
  // 提前返回,删盘还在半路 —— 进程此时退出会把它截断,token 原样留在盘上。
  // 用可控闸门把那个间隙变成确定的。
  it('探测清号时会等网关 token 真的删完才返回', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockResolvedValue(errBare(401))
    let release!: () => void
    clearGatewayTokens.mockImplementation(
      () =>
        new Promise<void>((r) => {
          release = () => r()
        }),
    )
    const m = await import('../session')

    let settled = false
    const done = m.probeLiveness().then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)

    release()
    await done
    expect(settled).toBe(true)
  })

  it('未登录时探测不发任何请求', async () => {
    const m = await import('../session')
    await m.probeLiveness()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ─────────────────────────────────────────────────────────────────────
  // 账号额度查询（第一期）。这几条盯的是「契约对齐」而不是「代码跑通」:
  // 后端字段两种拼法、金额单位换算、以及**必须与存活探测分开节流**。
  // ─────────────────────────────────────────────────────────────────────
  describe('额度查询', () => {
    const LOGGED_IN = {
      token: 'jwt.tok.en',
      userId: 'u1',
      username: 'a',
      displayName: 'a',
      role: 'USER',
      expiresAt: 1,
    }

    function login() {
      cred.current = { ...LOGGED_IN }
      cred.source = 'safeStorage'
    }

    it('fetchBalance 带上 projectId 与 Bearer 头', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ balance_quota: 130_000, balance_yuan: 0.26 }))
      const m = await import('../session')

      const r = await m.fetchBalance(342)
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://13797248455.xyz/api/user/balance?projectId=342',
      )
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt.tok.en')
      expect(r.balanceYuan).toBe(0.26)
    })

    // 后端两种拼法都出现过(shortdrama 的 platform.ts:136 实测踩到):
    // project 池回 balance_yuan,producer 池回 quota_yuan。只认一种会静默显示 0。
    //
    // ⚠️ 这里 quota 与 yuan **刻意互不换算**(999 quota ≠ ¥7)。若用一致的一对
    // (如 500000 / 1),删掉 quota_yuan 回落后代码会走换算分支得出同一个 1,
    // 断言分辨不出差别 —— 这条测试就成了空的(实测过)。
    it('balance_yuan 缺失时回落到 quota_yuan,而不是拿 quota 换算', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ balance_quota: 999, quota_yuan: 7 }))
      const m = await import('../session')
      expect((await m.fetchBalance(1)).balanceYuan).toBe(7)
    })

    // 500000 quota = ¥1(new-api/constant/org.go:40)。两个字段都没有时用 quota 自己换算,
    // 而不是显示 0 —— 显示 0 会让用户以为余额空了。
    it('两个 yuan 字段都缺时按 500000 quota = ¥1 换算', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ balance_quota: 2_500_000 }))
      const m = await import('../session')
      expect((await m.fetchBalance(1)).balanceYuan).toBe(5)
    })

    it('producer 池走 producer-balance 端点', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ balance_yuan: 3 }))
      const m = await import('../session')

      await m.fetchBalance(7, 9)
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('/api/user/producer-balance')
      expect(url).toContain('producerId=7')
      expect(url).toContain('producerProjectId=9')
    })

    // 池的键是一对 —— 只留 projectId 会把两个共用 projectId 的 producer 池悄悄合并。
    //
    // ⚠️ 第一个池刻意给 `producerProjectId: 0` 而不是省略。后端对普通 project 回的
    // 就是 0(`userOrg.ts:115` 注释:producer_project_id > 0 才是 producer 池)。
    // 若这里省略字段,那么「不做 >0 过滤」的实现也能通过 —— null ?? undefined 仍是
    // undefined,断言分辨不出来(实测过,这条曾是空的)。给 0 才能把过滤逻辑钉住:
    // 0 若被保留下来就成了一个虚假的池键成分。
    it('fetchOrganizations 保留真 producerProjectId,并把 0 视作非 producer 池', async () => {
      login()
      fetchMock.mockResolvedValue(
        ok([
          { id: 1, name: '个人计费', balanceYuan: 0.26, joined: true, producerProjectId: 0 },
          { id: 2, name: 'Seedance', balanceYuan: 12, joined: true, producerProjectId: 5 },
        ]),
      )
      const m = await import('../session')

      const orgs = await m.fetchOrganizations()
      expect(orgs).toHaveLength(2)
      expect(orgs[1].producerProjectId).toBe(5)
      expect('producerProjectId' in orgs[0]).toBe(false)
    })

    it('未登录时额度查询不发请求,直接抛', async () => {
      const m = await import('../session')
      await expect(m.fetchBalance(1)).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    // **这条是本组最要紧的。**
    // 存活探测刻意**不传** projectId,靠后端在 userOrg.ts:138-143 提前 400 短路、
    // 在触达 newApiService 之前返回,所以正常路径零外部依赖。余额查询要真传
    // projectId,会真打 New API —— 两者必须各自节流,否则余额查询会顺手把探测的
    // 60 秒窗口往后推,让封号检测的实际间隔被拉长到不可预期。
    //
    // ⚠️ 断言必须落在「窗口过期后探测**是否真的发生**」上。只断言「第二次探测被
    // 跳过」是空的:无论 fetchBalance 有没有推窗口,窗口内的第二次探测都会被跳过
    // (实测过,这条曾是空的)。
    it('额度查询不把存活探测的窗口往后推', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ balance_yuan: 1 }))
      const m = await import('../session')
      const probeUrl = 'https://13797248455.xyz/api/user/balance'
      const probeCount = () =>
        fetchMock.mock.calls.filter((c) => (c[0] as string) === probeUrl).length

      const t0 = Date.now()
      await m.probeLiveness()
      expect(probeCount()).toBe(1)

      // 时间推到窗口刚过期之后,再插一次余额查询。
      // 若 fetchBalance 共用了 lastProbeAt,它会把窗口重置到「现在」——
      // 于是紧随其后的探测被误判成「还在窗口内」而不发。
      vi.spyOn(Date, 'now').mockReturnValue(t0 + 61_000)
      await m.fetchBalance(1)
      await m.probeLiveness()

      expect(probeCount()).toBe(2)
    })

    // 反过来也要成立:余额查询自己不能被探测的节流挡住 —— 用户切组织时要立刻看到新余额。
    it('额度查询不被探测的节流挡住', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ balance_yuan: 1 }))
      const m = await import('../session')

      await m.probeLiveness()
      await m.fetchBalance(1)
      await m.fetchBalance(2)
      const balanceCalls = fetchMock.mock.calls.filter((c) =>
        (c[0] as string).includes('projectId='),
      )
      expect(balanceCalls).toHaveLength(2)
    })

    it('fetchPaymentConfig 读出个人计费落点', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ personalBilling: { enabled: true, projectId: 342 } }))
      const m = await import('../session')
      expect((await m.fetchPaymentConfig()).personalBillingProjectId).toBe(342)
    })

    // 后端未配置 PERSONAL_BILLING_PROJECT_ID 时要优雅退化,不能把 UI 卡死。
    it('个人计费未启用时 projectId 为 null', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ personalBilling: { enabled: false, projectId: 342 } }))
      const m = await import('../session')
      expect((await m.fetchPaymentConfig()).personalBillingProjectId).toBeNull()
    })

    it('额度查询把后端错误信封原样抛成 AuthError', async () => {
      login()
      fetchMock.mockResolvedValue(errCoded(403, 'FORBIDDEN_PROJECT'))
      const m = await import('../session')
      await expect(m.fetchBalance(1)).rejects.toMatchObject({ code: 'FORBIDDEN_PROJECT' })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // 用量明细与充值。盯的全是**只在真机上才暴露**的契约细节:
  //   - BFF 收 camelCase 自己改名转发,客户端提前改成 snake_case 会被整组忽略
  //   - `page` 是 0 基,第一页就是那个会被 falsy 判断吞掉的 0
  //   - 明细响应全 snake_case、未脱敏
  //   - payment 与 usage 两套成功信封
  //   - 项目上下文三选一互斥,多发一个字段就 403
  //   - `PAID` ≠ 完成,`CREDITED` 才是
  // ─────────────────────────────────────────────────────────────────────
  describe('用量明细与充值', () => {
    function login() {
      cred.current = {
        token: 'jwt.tok.en',
        userId: 'u1',
        username: 'a',
        displayName: 'a',
        role: 'USER',
        expiresAt: 1,
      }
      cred.source = 'safeStorage'
    }

    /** 一条真实形状的消费流水:Go `model.Log` 整体序列化,全 snake_case(计划 §1.1)。 */
    const CONSUME_ROW = {
      id: 90_210,
      created_at: 1_756_200_000,
      type: 2,
      model_name: 'seedance-1-0-pro',
      quota: 12_500,
      prompt_tokens: 31,
      completion_tokens: 0,
      feature: 'video',
      token_name: 'sk-desktop',
      project_id: 342,
      producer_project_id: 5,
      content: '视频 textGenerate, 生成时长seconds: 5.00',
    }

    /** 退款流水:type=6,`quota` 是**负数**。 */
    const REFUND_ROW = { ...CONSUME_ROW, id: 90_211, type: 6, quota: -2_500 }

    const CREATED = {
      outTradeNo: 'RC20260827001',
      payUrl: 'https://openapi.alipay.com/gateway.do?biz_content=%7B%7D&sign=abc',
      totalAmount: '100.00',
      pointsAmount: 50_000_000,
      status: 'PENDING',
    }

    it('fetchUsageLogs 用 camelCase 拼参数,page 按 0 基原样送出', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ logs: [], total: 0, page: 2, page_size: 20 }))
      const m = await import('../session')

      await m.fetchUsageLogs({
        projectId: 342,
        page: 2,
        pageSize: 20,
        startTime: 1_756_000_000,
        endTime: 1_756_300_000,
      })

      const url = new URL(fetchMock.mock.calls[0][0] as string)
      expect(url.pathname).toBe('/api/user/usage-logs')
      // 逐字段 toEqual 而不是逐个 get():BFF 自己把 camelCase 改名成 snake_case 再转发给 Go
      // (`userOrg.ts:356-359`)。客户端提前改成 snake_case 的话参数会被整组忽略、静默退化成
      // 默认值 —— 用户看到的是「筛选没生效」,而不是任何报错。toEqual 同时钉住「没有多余参数」。
      expect(Object.fromEntries(url.searchParams)).toEqual({
        projectId: '342',
        page: '2',
        pageSize: '20',
        startTime: '1756000000',
        endTime: '1756300000',
      })
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt.tok.en')
    })

    // `page` 是 0 基(offset = page * pageSize),所以第一页就是 0。用 `if (query.page)`
    // 之类的 falsy 判断会把第一页的参数整个吞掉 —— 恰好在最常用的那一页上出错。
    // 同理 `projectId: 0` 是「不过滤」这个合法语义,不是「没传」。
    it('page 与 projectId 为 0 时照样送出,不被 falsy 判断吞掉', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ logs: [], total: 0, page: 0, page_size: 20 }))
      const m = await import('../session')

      await m.fetchUsageLogs({ projectId: 0, page: 0 })
      const url = new URL(fetchMock.mock.calls[0][0] as string)
      expect(url.searchParams.get('page')).toBe('0')
      expect(url.searchParams.get('projectId')).toBe('0')
      // 没给时间范围就一个都不发:后端 `>0` 才生效,发 0 只是噪音。
      expect(url.searchParams.has('startTime')).toBe(false)
      expect(url.searchParams.has('endTime')).toBe(false)
    })

    // 硬上限 100(计划 §1.1)。别指望后端兜 —— 它兜不兜是另一份代码的事,
    // 而超限的后果是一次几百行的响应打进主进程再经 IPC 结构化克隆一遍。
    it.each<[number | undefined, string]>([
      [500, '100'],
      [undefined, '20'],
      [0, '20'],
    ])('pageSize=%s 时送出 %s', async (input, expected) => {
      login()
      fetchMock.mockResolvedValue(ok({ logs: [], total: 0, page: 0, page_size: 20 }))
      const m = await import('../session')

      await m.fetchUsageLogs({ projectId: 1, pageSize: input })
      expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('pageSize')).toBe(
        expected,
      )
    })

    // §2.2:用量接口**只收 `projectId`**(`userOrg.ts:350-354`),而 producer 池的键是
    // `(projectId, producerProjectId)` 两半。客户端自己造一个 producerProjectId 参数
    // 只会被后端忽略,却让人误以为过滤生效了 —— 这条钉住「接口收不了,就别发」。
    it('不发 producerProjectId —— 用量接口收不了这一半池键', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ logs: [CONSUME_ROW], total: 1, page: 0, page_size: 20 }))
      const m = await import('../session')

      await m.fetchUsageLogs({ projectId: 342 })
      const url = new URL(fetchMock.mock.calls[0][0] as string)
      expect(url.searchParams.has('producerProjectId')).toBe(false)
      expect(url.searchParams.has('producerId')).toBe(false)
    })

    it('明细响应全 snake_case,逐字段归一成 camelCase', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ logs: [CONSUME_ROW], total: 137, page: 0, page_size: 50 }))
      const m = await import('../session')

      const r = await m.fetchUsageLogs({ projectId: 342, pageSize: 50 })
      expect(r).toEqual({
        total: 137,
        page: 0,
        pageSize: 50,
        rows: [
          {
            id: 90_210,
            createdAt: 1_756_200_000,
            type: 2,
            modelName: 'seedance-1-0-pro',
            quota: 12_500,
            promptTokens: 31,
            completionTokens: 0,
            feature: 'video',
            tokenName: 'sk-desktop',
            projectId: 342,
            producerProjectId: 5,
            content: '视频 textGenerate, 生成时长seconds: 5.00',
            settleStatus: 0,
            preConsumedQuota: null,
          },
        ],
      })
    })

    // 网关对异步任务的账本模型:失败退款不是另一行,而是原消费行改成 cancelled、quota 归 0、
    // 退回的金额只在 other.pre_consumed_quota 里。这里要把它挖出来,否则渲染层看到的是
    // 一行解释不了的 ¥0「消费」。other 里还有 admin_info 之类的东西,所以不整段透传。
    it('cancelled 行挖出 other.pre_consumed_quota;其余行 preConsumedQuota 为 null', async () => {
      login()
      const cancelled = {
        ...CONSUME_ROW,
        id: 90_211,
        quota: 0,
        settle_status: 2,
        other: JSON.stringify({
          is_task: true,
          pre_consumed_quota: 12_500,
          reason: 'video async task failed: InputImageSensitiveContentDetected',
          admin_info: { use_channel: ['6'] },
        }),
      }
      const settledWithOther = {
        ...CONSUME_ROW,
        id: 90_212,
        settle_status: 0,
        other: JSON.stringify({ pre_consumed_quota: 999 }),
      }
      const malformed = { ...CONSUME_ROW, id: 90_213, settle_status: 2, other: '{not json' }
      fetchMock.mockResolvedValue(
        ok({ logs: [cancelled, settledWithOther, malformed], total: 3, page: 0, page_size: 20 }),
      )
      const m = await import('../session')

      const r = await m.fetchUsageLogs({ projectId: 342 })
      expect(r.rows[0]).toMatchObject({ settleStatus: 2, quota: 0, preConsumedQuota: 12_500 })
      // 不是 cancelled 的行,other 里就算有 pre_consumed_quota 也不取 —— 那不是退款。
      expect(r.rows[1]).toMatchObject({ settleStatus: 0, preConsumedQuota: null })
      // other 坏掉不影响整行。
      expect(r.rows[2]).toMatchObject({ settleStatus: 2, preConsumedQuota: null })
      // 不整段透传 other。
      expect(r.rows[0]).not.toHaveProperty('other')
    })

    // 未脱敏的整体序列化意味着字段可能整个缺席(旧数据、非 New API 来源的流水)。
    // 缺席时给 null 而不是 0/'' —— UI 要能区分「这条没有 token 名」和「token 名是空串」。
    it('明细缺省字段落成 null,logs 不是数组时退化成空页', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ logs: [{ id: 7 }], total: 1, page: 0, page_size: 20 }))
      const m = await import('../session')

      const r = await m.fetchUsageLogs({ projectId: 1 })
      expect(r.rows[0]).toEqual({
        id: 7,
        createdAt: 0,
        type: 0,
        modelName: '',
        quota: 0,
        promptTokens: 0,
        completionTokens: 0,
        feature: null,
        tokenName: null,
        projectId: null,
        producerProjectId: null,
        content: '',
        settleStatus: 0,
        preConsumedQuota: null,
      })

      fetchMock.mockResolvedValue(ok({ total: 0 }))
      const r2 = await m.fetchUsageLogs({ projectId: 1, pageSize: 50 })
      expect(r2.rows).toEqual([])
      // page_size 缺席时回落到**本次请求实际送出的**值,而不是 0 ——
      // UI 拿 pageSize 算总页数,0 会算出 Infinity。
      expect(r2.pageSize).toBe(50)
    })

    // §2.1:汇总 SQL 带 `WHERE type = LogTypeConsume`(`log.go:365`),明细的 where
    // **没有** type 过滤(`log.go:333-342`)。所以一条退款会出现在列表里、却不进汇总。
    //
    // 主进程**不做**净额换算:列表是分页的,算不出全量净额,算出来的「净额」只对当前页成立,
    // 比毛额更误导。这里如实透出这个不一致,由 UI 把汇总标题写成「消费合计(不含退款)」。
    // 顺带钉住:退款的 `quota` 是负数,不许 Math.abs —— 一旦取了绝对值,
    // 退款在列表里会显示成又花了一笔钱。
    it('退款行进列表但不进汇总,负 quota 原样透出', async () => {
      login()
      fetchMock.mockResolvedValue(
        ok({ logs: [CONSUME_ROW, REFUND_ROW], total: 2, page: 0, page_size: 20 }),
      )
      const m = await import('../session')

      const page = await m.fetchUsageLogs({ projectId: 342 })
      expect(page.rows.map((x) => x.type)).toEqual([2, 6])
      expect(page.rows[1].quota).toBe(-2_500)

      // 同一区间的汇总只算 type=2,所以它比列表的算术和大 2500 —— 这是后端口径,不是 bug。
      fetchMock.mockResolvedValue(
        ok([{ model_name: 'seedance-1-0-pro', total_quota: 12_500, total_requests: 1, total_tokens: 31 }]),
      )
      const summary = await m.fetchUsageSummary({ projectId: 342 })
      expect(summary[0].totalQuota).toBe(12_500)
      expect(page.rows.reduce((s, x) => s + x.quota, 0)).toBe(10_000)
    })

    it('fetchUsageSummary 只发 projectId 与时间范围,不发分页参数', async () => {
      login()
      fetchMock.mockResolvedValue(ok([]))
      const m = await import('../session')

      await m.fetchUsageSummary({ projectId: 342, startTime: 1_756_000_000, endTime: 1_756_300_000 })
      const url = new URL(fetchMock.mock.calls[0][0] as string)
      expect(url.pathname).toBe('/api/user/usage-summary')
      expect(Object.fromEntries(url.searchParams)).toEqual({
        projectId: '342',
        startTime: '1756000000',
        endTime: '1756300000',
      })
    })

    // 汇总按 `model_name` 分组,GROUP BY 出来的那一组可以是 NULL(旧流水没记模型名)。
    // 落成 `''` 的话 UI 会渲染一行没有名字的空白条目,与「模型名就是空串」分不开;
    // 落成 null 才能显示「未标注模型」。
    it('汇总的 model_name 缺省时 modelName 为 null 而不是空串', async () => {
      login()
      fetchMock.mockResolvedValue(
        ok([
          { model_name: 'gemini-3-pro', total_quota: 8_000, total_requests: 4, total_tokens: 120 },
          { total_quota: 500, total_requests: 1, total_tokens: 0 },
        ]),
      )
      const m = await import('../session')

      const r = await m.fetchUsageSummary({ projectId: 1 })
      expect(r).toEqual([
        { modelName: 'gemini-3-pro', totalQuota: 8_000, totalRequests: 4, totalTokens: 120 },
        { modelName: null, totalQuota: 500, totalRequests: 1, totalTokens: 0 },
      ])
      expect(r[1].modelName).toBeNull()
    })

    // 后端**不给顶层合计**(计划 §1.2),主进程也不替它算 —— 算了就得决定「合计里算不算
    // NULL 那组」,而那是 UI 的呈现决定。这里只保证数组原样透出、长度不被压扁。
    it('汇总不做顶层合计,原样透出分组数组', async () => {
      login()
      fetchMock.mockResolvedValue(
        ok([
          { model_name: 'a', total_quota: 1, total_requests: 1, total_tokens: 1 },
          { model_name: 'b', total_quota: 2, total_requests: 2, total_tokens: 2 },
        ]),
      )
      const m = await import('../session')
      expect(await m.fetchUsageSummary({ projectId: 1 })).toHaveLength(2)
    })

    it('用量查询把后端错误信封原样抛成 AuthError', async () => {
      login()
      fetchMock.mockResolvedValue(errBare(403))
      const m = await import('../session')
      await expect(m.fetchUsageLogs({ projectId: 1 })).rejects.toMatchObject({ code: 'HTTP_403' })
    })

    // 与额度查询同一条约定(见上一组最要紧的那条):用量查询也真打后端,
    // **不**与存活探测共用节流窗口,否则打开抽屉会顺手把封号检测的间隔往后推。
    it('用量查询不把存活探测的窗口往后推', async () => {
      login()
      fetchMock.mockResolvedValue(ok({ logs: [], total: 0, page: 0, page_size: 20 }))
      const m = await import('../session')
      const probeUrl = 'https://13797248455.xyz/api/user/balance'
      const probeCount = () =>
        fetchMock.mock.calls.filter((c) => (c[0] as string) === probeUrl).length

      const t0 = Date.now()
      await m.probeLiveness()
      expect(probeCount()).toBe(1)

      vi.spyOn(Date, 'now').mockReturnValue(t0 + 61_000)
      await m.fetchUsageLogs({ projectId: 1 })
      await m.probeLiveness()
      expect(probeCount()).toBe(2)
    })

    // 三选一互斥(`payment.ts:122-174`)。个人计费再夹带 projectId,后端就走成员校验分支,
    // 而个人落点刻意**不在** `/api/user/organizations` 的返回里 → `joined` 查不到 → 403。
    // 逐字段 toEqual 才钉得住「不许夹带」;toMatchObject 对多出来的字段是瞎的。
    it('建单:个人计费只发 personal', async () => {
      login()
      fetchMock.mockResolvedValue(okPay(CREATED))
      const m = await import('../session')

      const r = await m.createRechargeOrder(100, { kind: 'personal' })

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://13797248455.xyz/api/payment/alipay/orders')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body)).toEqual({
        amountCny: 100,
        orderType: 'balance_recharge',
        personal: true,
      })
      // payment 是 `{ok:true,data}` 那套信封 —— 只认 `success` 的解包会在这里拿到空对象。
      expect(r).toEqual({
        outTradeNo: 'RC20260827001',
        payUrl: CREATED.payUrl,
        status: 'PENDING',
        totalAmount: '100.00',
        creditError: null,
      })
    })

    it('建单:普通 project 只发 projectId', async () => {
      login()
      fetchMock.mockResolvedValue(okPay(CREATED))
      const m = await import('../session')

      await m.createRechargeOrder(30, { kind: 'project', projectId: 342 }, '桌面端充值')
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        amountCny: 30,
        orderType: 'balance_recharge',
        projectId: 342,
        subject: '桌面端充值',
      })
    })

    // producer 两半必须**成对**,缺一后端 400。也不许顺手补一个 projectId ——
    // producer 池的 `producerId` 与普通 project 的 `projectId` 是不同的落点。
    it('建单:producer 池成对发 producerId 与 producerProjectId', async () => {
      login()
      fetchMock.mockResolvedValue(okPay(CREATED))
      const m = await import('../session')

      await m.createRechargeOrder(50, { kind: 'producer', producerId: 7, producerProjectId: 5 })
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        amountCny: 50,
        orderType: 'balance_recharge',
        producerId: 7,
        producerProjectId: 5,
      })
    })

    // 上限 ¥4000(`payment.ts:28`)。物理上限来自影子账户 quota 是 int32 —— ¥4294.96,
    // 4000 是给它留了余量的业务上限。越界在主进程就拒:打到后端换一个 400 回来,
    // 用户要多等一个 RTT 才看到「金额超限」,而这条判断本地就能下。
    it.each([0, -1, 4001, Number.NaN, Number.POSITIVE_INFINITY])(
      '建单:金额 %s 在主进程就被拒,net.fetch 一次都没被调',
      async (amount) => {
        login()
        const m = await import('../session')
        await expect(m.createRechargeOrder(amount, { kind: 'personal' })).rejects.toMatchObject({
          code: 'INVALID_AMOUNT',
        })
        expect(fetchMock).not.toHaveBeenCalled()
      },
    )

    it('建单:4000 是含边界,放行', async () => {
      login()
      fetchMock.mockResolvedValue(okPay(CREATED))
      const m = await import('../session')

      await m.createRechargeOrder(4000, { kind: 'personal' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).amountCny).toBe(4000)
    })

    // 成员校验 fail-closed:目标项目必须 `joined === true`,否则 403 FORBIDDEN。
    // UI 要按 code 分支引导「先加入该项目」,所以 code 不能在这一层被吞掉。
    it('建单:后端 403 FORBIDDEN 带 code 抛出', async () => {
      login()
      fetchMock.mockResolvedValue(errCoded(403, 'FORBIDDEN'))
      const m = await import('../session')
      await expect(
        m.createRechargeOrder(10, { kind: 'project', projectId: 9 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    // 🚨 `PAID` 不是完成态。支付宝收到钱了但入账到影子账户失败时,状态是 `PAID` 且
    // `creditError` 非空 —— 此时把它当成功,用户会以为余额已经加上了。
    it('订单查询:PAID + creditError 非空时如实透出', async () => {
      login()
      fetchMock.mockResolvedValue(
        okOrder({
          outTradeNo: 'RC20260827001',
          status: 'PAID',
          totalAmount: '100.00',
          creditError: 'shadow account not found',
        }),
      )
      const m = await import('../session')

      const r = await m.fetchRechargeOrder('RC20260827001')
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://13797248455.xyz/api/payment/alipay/orders/RC20260827001',
      )
      expect(r).toEqual({
        outTradeNo: 'RC20260827001',
        status: 'PAID',
        totalAmount: '100.00',
        creditError: 'shadow account not found',
      })
    })

    it('订单查询:CREDITED 才是终态成功', async () => {
      login()
      fetchMock.mockResolvedValue(
        okOrder({ outTradeNo: 'RC1', status: 'CREDITED', totalAmount: '30.00' }),
      )
      const m = await import('../session')

      const r = await m.fetchRechargeOrder('RC1')
      expect(r.status).toBe('CREDITED')
      expect(r.creditError).toBeNull()
    })

    // 后端日后加一个新状态(比如 REFUNDED)时,退化方向必须是 `PENDING`:轮询等到超时、
    // 显示「未完成」。退化成 `CREDITED` 是灾难 —— 没到账却告诉用户到账了。
    it('订单查询:未知状态退化成 PENDING,绝不当成 CREDITED', async () => {
      login()
      fetchMock.mockResolvedValue(okOrder({ outTradeNo: 'RC1', status: 'REFUNDED' }))
      const m = await import('../session')
      expect((await m.fetchRechargeOrder('RC1')).status).toBe('PENDING')
    })

    // 金额一律按字符串透出。后端偶尔回数字,但绝不能在这里 parseFloat 再格式化 ——
    // 浮点一趟就能把 ¥100 显示成 ¥99.99999。
    it('订单查询:数字金额也按字符串透出,不做算术', async () => {
      login()
      fetchMock.mockResolvedValue(okOrder({ outTradeNo: 'RC1', status: 'PENDING', totalAmount: 30 }))
      const m = await import('../session')
      expect((await m.fetchRechargeOrder('RC1')).totalAmount).toBe('30')
    })

    // 建单与查单的形状不对称,是这条线上最容易静默踩中的坑 —— 漏剥 `data.order` 不抛错、
    // 只是把状态退化成 `PENDING`,于是轮询永不终止。这条直接钉住嵌套本身。
    it('订单查询:剥掉 data.order 那一层,漏剥会把 CREDITED 读成 PENDING', async () => {
      login()
      fetchMock.mockResolvedValue(okOrder({ outTradeNo: 'RC9', status: 'CREDITED' }))
      const m = await import('../session')

      const r = await m.fetchRechargeOrder('RC9')
      // outTradeNo 一起断言:漏剥时它会是空串,单看 status 可能被别处的兜底遮住。
      expect(r).toMatchObject({ outTradeNo: 'RC9', status: 'CREDITED' })
    })

    // 建单那半**没有**这层嵌套(`payment.ts:151,219` 直接 `data: result`)。
    // 两边共用 `toRechargeOrder`,所以「统一改成只认 data.order」会把建单弄坏。
    it('建单:data 直接就是订单,没有 order 那一层', async () => {
      login()
      fetchMock.mockResolvedValue(okPay(CREATED))
      const m = await import('../session')

      expect((await m.createRechargeOrder(10, { kind: 'personal' })).outTradeNo).toBe(
        'RC20260827001',
      )
    })

    // 四个函数共用 `requireToken()`,所以未登录必须是同一个 code。IPC 层按它引导重新登录;
    // 落成别的 code(或裸抛)UI 就只能显示一句无从下手的通用错误。
    it.each<[string, (m: typeof SessionModule) => Promise<unknown>]>([
      ['fetchUsageLogs', (m) => m.fetchUsageLogs({ projectId: 1 })],
      ['fetchUsageSummary', (m) => m.fetchUsageSummary({ projectId: 1 })],
      ['createRechargeOrder', (m) => m.createRechargeOrder(10, { kind: 'personal' })],
      ['fetchRechargeOrder', (m) => m.fetchRechargeOrder('RC1')],
    ])('%s 未登录时抛 NOT_AUTHENTICATED,一次请求都不发', async (_name, call) => {
      const m = await import('../session')
      await expect(call(m)).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it('logout 清凭证', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    const m = await import('../session')
    await m.logout()
    expect(cred.current).toBeNull()
    expect(m.getAuthState().authenticated).toBe(false)
  })

  // 🚨 「清平台凭据」与「清网关 token」是**一条**不变量,必须由 `logout()` 自己保证。
  //
  // 两者分家的时候,不变量散在调用方:IPC 的登出 handler 记得清,停用探测也记得清 ——
  // 于是下一个直接调 `logout()` 的人会无声地造出第三条泄漏路径。网关 token
  // `expired_time = -1`(永不过期)且被服务端四处共用,泄漏后**无法单独吊销**,
  // 所以「什么时候清掉它」是整个方案的核心不变量,不能靠调用方的记性。
  it('logout 自己清掉网关 token,不依赖调用方顺手清', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    const m = await import('../session')

    await m.logout()

    expect(clearGatewayTokens).toHaveBeenCalled()
  })

  // `clearGatewayTokens` 是 async,里面压着一次 `fs.rm`。`logout()` 不 await 的话它提前
  // 返回,调用方立刻广播「已登出」而删盘还在半路 —— 用户此时关掉应用,进程退出会把它
  // 截断,token 原样留在盘上。用可控闸门把那个间隙变成确定的。
  //
  // 这条同时钉死了 `logout()` 的**签名**:返回 void 的实现无法通过。
  it('logout 会等网关 token 真的删完才返回', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    let release!: () => void
    clearGatewayTokens.mockImplementation(
      () =>
        new Promise<void>((r) => {
          release = () => r()
        }),
    )
    const m = await import('../session')

    let settled = false
    const done = Promise.resolve(m.logout()).then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)

    release()
    await done
    expect(settled).toBe(true)
  })

  it('每个请求都挂 AbortSignal,不会无限期挂起', async () => {
    fetchMock.mockResolvedValue(ok({ pairingId: 'p', authorizeUrl: 'u', expiresIn: 300 }, 201))
    const m = await import('../session')
    await m.startPairing('CATIMATION', null, PKCE)
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
  })

  // 上面那条 60 秒缓存的用例是**串行** await 的,第一次早已写完 lastProbeAt 第二次才开始 ——
  // 所以把 `lastProbeAt = now` 挪到 await 之后它照样绿。只有并发调用能锁住这个顺序。
  it('并发探测也只发一次请求(lastProbeAt 在发请求前就更新)', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    fetchMock.mockResolvedValue(errCoded(400, 'VALIDATION_ERROR'))
    const m = await import('../session')

    await Promise.all([m.probeLiveness(), m.probeLiveness(), m.probeLiveness()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // 两套信封的另一半:没有 error.code 时要按状态码合成,保证 code 永远是非空字符串 ——
  // IPC 层拿到 undefined 就没法映射用户文案了。
  it('响应体没有 error.code 时,按状态码合成一个', async () => {
    fetchMock.mockResolvedValue(errBare(401))
    const m = await import('../session')
    await expect(m.startPairing('CATIMATION', null, PKCE)).rejects.toMatchObject({
      code: 'HTTP_401',
      status: 401,
    })
  })
})
