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
