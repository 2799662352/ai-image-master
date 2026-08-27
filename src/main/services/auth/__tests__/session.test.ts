// IdP 客户端。被测的是「契约对齐」而不是「代码跑通」——
// 后端两套错误信封、201 vs 200、可选字段兜底,每一条错了都只在真机上才暴露。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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

/** 后端配对路由的信封。注意 start 是 201。 */
const ok = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ success: true, data }) }) as unknown as Response

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
    vi.useRealTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('authBaseUrl 缺省指向官网,并归一化末尾斜杠', async () => {
    const m = await import('../session')
    expect(m.authBaseUrl()).toBe('https://13797248455.xyz')
    process.env.CATIMATION_AUTH_BASE_URL = 'https://staging.example.com/'
    expect(m.authBaseUrl()).toBe('https://staging.example.com')
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

  it('logout 清凭证', async () => {
    cred.current = { token: 't', userId: 'u1', username: 'a', displayName: 'a', role: 'USER', expiresAt: 1 }
    cred.source = 'safeStorage'
    const m = await import('../session')
    m.logout()
    expect(cred.current).toBeNull()
    expect(m.getAuthState().authenticated).toBe(false)
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
