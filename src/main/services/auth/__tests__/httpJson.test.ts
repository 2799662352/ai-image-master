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
