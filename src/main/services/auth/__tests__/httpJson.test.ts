// 唯一出网点的**头所有权**契约。`BackendRequestOptions.headers` 的注释承诺
// 「不能覆盖 Authorization / Accept / Content-Type —— 那三个由本函数拥有」,
// 这个文件把那句话钉成可执行的。
//
// 为什么值得单独测:HTTP 头名**大小写不敏感**,而 `{...opts.headers, Accept: …}`
// 只在同大小写时才是「覆盖」。传小写 `authorization` 的话两个键会**并存**,
// `net.fetch` 构造 Headers 时把它们合并成 `Bearer A, Bearer B` → 401,
// 而从调用点看不出任何异常。

import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...a: unknown[]) => fetchMock(...a) } }))

const cred = { current: null as null | Record<string, unknown> }
vi.mock('../credentials', () => ({ getCredential: () => cred.current }))

const okJson = () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response

const lastHeaders = () =>
  (fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit])[1]
    .headers as Record<string, string>

/** 同一个头名下实际发出去了几个键(不分大小写)。>1 就是会被合并成逗号串的那种并存。 */
const countHeader = (name: string): number =>
  Object.keys(lastHeaders()).filter((k) => k.toLowerCase() === name.toLowerCase()).length

const valueOf = (name: string): string | undefined => {
  const hit = Object.entries(lastHeaders()).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return hit?.[1]
}

describe('httpJson.sendJson 的头所有权', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(okJson())
    cred.current = null
    delete process.env.CATIMATION_AUTH_BASE_URL
  })

  it.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
    '调用方传 %s 时不与本函数的 Bearer 并存',
    async (key) => {
      const { sendJson } = await import('../httpJson')
      await sendJson('/x', 'GET', { token: 'mine', headers: { [key]: 'Bearer theirs' } })

      expect(countHeader('authorization')).toBe(1)
      expect(valueOf('authorization')).toBe('Bearer mine')
    },
  )

  // 没有 token 时也一样抹掉:「本函数拥有」意味着调用方无论如何都设不上,
  // 而不是「只在本函数也要设的时候才拦」。
  it('调用方传 authorization 但本次没有 token 时,该头不发出去', async () => {
    const { sendJson } = await import('../httpJson')
    await sendJson('/x', 'GET', { headers: { authorization: 'Bearer theirs' } })
    expect(countHeader('authorization')).toBe(0)
  })

  it.each(['Accept', 'accept'])('调用方传 %s 时不与 application/json 并存', async (key) => {
    const { sendJson } = await import('../httpJson')
    await sendJson('/x', 'GET', { headers: { [key]: 'text/html' } })

    expect(countHeader('accept')).toBe(1)
    expect(valueOf('accept')).toBe('application/json')
  })

  it.each(['Content-Type', 'content-type'])(
    'JSON 体时调用方传的 %s 不与 application/json 并存',
    async (key) => {
      const { sendJson } = await import('../httpJson')
      await sendJson('/x', 'POST', { body: { a: 1 }, headers: { [key]: 'text/plain' } })

      expect(countHeader('content-type')).toBe(1)
      expect(valueOf('content-type')).toBe('application/json')
    },
  )

  /**
   * multipart 时**一个都不能有**:手写的那个丢了 boundary,后端 multer 解不出字段,
   * 回「未收到文件」400。大小写两种写法都得抹掉。
   */
  it.each(['Content-Type', 'content-type'])('multipart 时抹掉调用方传的 %s', async (key) => {
    const { sendJson } = await import('../httpJson')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(1)]), 'a.png')
    await sendJson('/x', 'POST', { form, headers: { [key]: 'multipart/form-data' } })

    expect(countHeader('content-type')).toBe(0)
  })

  // 不属于那三个的头照常透传 —— 人像库的 `X-Project-Id` / `X-Producer-Project-Id`
  // 正是靠这条活着。
  it('其余头原样透传', async () => {
    const { sendJson } = await import('../httpJson')
    await sendJson('/x', 'GET', { headers: { 'X-Project-Id': '42' } })
    expect(valueOf('x-project-id')).toBe('42')
  })
})

// ── 「登录被平台拒收」的判据 ────────────────────────────────────────────────
//
// 2026-11-21 线上:生产把登录有效期配成了 7 天。到期的用户在人像库里看到的是后端
// 原话「Token 无效或已过期」加一个怎么点都没用的「重试」—— 那句话的 code 落成了
// `HTTP_401`,而渲染层引导登录的分支认的是 `NOT_AUTHENTICATED`。
describe('httpJson.loginRejected', () => {
  const REJECTED = { code: 'NOT_AUTHENTICATED', status: 401, message: '登录已失效,请重新登录' }

  // `authMiddleware` 的三种 401(`middleware/auth.ts:66,83,103`)都是这个形状:
  // 只有 message,没有任何错误码。
  it.each(['Token 无效或已过期', '未提供认证 Token', '用户不存在'])(
    '401 且只有 message「%s」→ NOT_AUTHENTICATED,后端原话不透给用户',
    async (message) => {
      const { loginRejected } = await import('../httpJson')
      expect(loginRejected(401, { success: false, message })).toMatchObject(REJECTED)
    },
  )

  // 人像库那批 controller 自己判的「未登录」:`error` 是**字符串**,不是带 code 的对象。
  it('`error` 是字符串的 401 也算 —— 字符串不是错误码', async () => {
    const { loginRejected } = await import('../httpJson')
    expect(loginRejected(401, { success: false, error: '未登录' })).toMatchObject(REJECTED)
  })

  // 空响应体与非 JSON 错误页,`sendJson` 交回来的都是 `{}`。
  it('响应体是空对象的 401 也算', async () => {
    const { loginRejected } = await import('../httpJson')
    expect(loginRejected(401, {})).toMatchObject(REJECTED)
  })

  // 带 code 的 401 是另一回事。`userOrg.ts:71` 把 New API 的状态码原样透传 —— 那是平台
  // 自己打上游的凭据坏了,让用户重新登录一万次也没用,还会让他以为是自己账号的问题。
  it.each<[string, Record<string, unknown>]>([
    [
      '嵌套 error.code(上游透传)',
      { success: false, error: { code: 'UPSTREAM_FAILED', message: 'x', upstreamStatus: 401 } },
    ],
    ['顶层 code', { success: false, code: 'UNAUTHORIZED', error: 'x' }],
  ])('401 但带后端错误码 —— %s → 不认,留给各端点自己的映射', async (_name, body) => {
    const { loginRejected } = await import('../httpJson')
    expect(loginRejected(401, body)).toBeNull()
  })

  // 403 是封号或没有这个池的权限,后端的话已经说清了,重新登录都解决不了。
  it.each([400, 403, 404, 500])('%i 不认 —— 只有 401 是「凭据不被接受」', async (status) => {
    const { loginRejected } = await import('../httpJson')
    expect(loginRejected(status, { success: false, message: 'x' })).toBeNull()
  })
})
