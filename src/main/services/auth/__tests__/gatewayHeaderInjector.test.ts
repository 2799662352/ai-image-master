import { describe, expect, it, vi, beforeEach } from 'vitest'

const tokenRef = { value: null as string | null }
vi.mock('../gatewayToken', () => ({ getActivePoolToken: () => tokenRef.value }))

/** 把注册进去的 listener 抓出来直接调,不起真 session。 */
function fakeSession() {
  let captured: ((d: any, cb: (r: any) => void) => void) | null = null
  let capturedFilter: { urls: string[] } | null = null
  return {
    webRequest: {
      onBeforeSendHeaders(filter: any, listener: any) {
        capturedFilter = filter
        captured = listener
      },
    },
    invoke(headers: Record<string, string>) {
      return new Promise<any>((resolve) => captured!({ requestHeaders: headers }, resolve))
    },
    get filter() {
      return capturedFilter
    },
  }
}

describe('gatewayHeaderInjector', () => {
  beforeEach(() => {
    vi.resetModules()
    tokenRef.value = null
  })

  it('带标记头且有 token 时，换成 Authorization 并删掉标记', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({ 'X-Catimation-Billing': 'platform' })

    expect(r.requestHeaders.Authorization).toBe('Bearer sk-live')
    // 标记必须删掉：它是内部协议，泄漏到上游没有意义，且会出现在网关日志里。
    expect(r.requestHeaders['X-Catimation-Billing']).toBeUndefined()
  })

  // HTTP 头名本来就大小写不敏感,而渲染层出图走的是 `fetch()` —— Fetch 规范要求
  // `Headers` 把头名归一化成小写。按字面量精确查表的话标记永远不命中,请求带着标记
  // 裸奔出去拿一个 401,表现成「接好了却一次都不生效」,还极容易被误判成后端问题。
  it('标记头用小写送进来也认得出,同样删掉、同样注入', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({ 'x-catimation-billing': 'platform' })

    expect(r.requestHeaders.Authorization).toBe('Bearer sk-live')
    expect(r.requestHeaders['x-catimation-billing']).toBeUndefined()
  })

  // 打了标记就是声明「本次走平台余额」。取不到 token 时若把渲染层原有的 Authorization
  // 留着,这一次会**静默地用用户自己的 key 出图成功** —— 用户以为在花平台余额,
  // 实际在花自己的。必须让它裸奔去撞 401,渲染层按既有错误路径提示「请先选择计费池」。
  it('带标记但取不到 token 时,已有的 Authorization 必须删掉', async () => {
    tokenRef.value = null
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({
      'X-Catimation-Billing': 'platform',
      Authorization: 'Bearer user-own-key',
    })

    expect(r.requestHeaders.Authorization).toBeUndefined()
  })

  // 上面两条修法凑一起会长出一个新坑:渲染层 fetch 送来的是小写 `authorization`,
  // 而我们写回去的是 `Authorization` —— 只设不删的话两个头会**一起**出网,
  // 网关看到重复的 Authorization,行为未定义。所以要按大小写不敏感先删再设。
  it('渲染层送小写 authorization 时,出网只剩一个 Authorization', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({
      'x-catimation-billing': 'platform',
      authorization: 'Bearer user-own-key',
    })

    const authKeys = Object.keys(r.requestHeaders).filter(
      (k: string) => k.toLowerCase() === 'authorization',
    )
    expect(authKeys).toEqual(['Authorization'])
    expect(r.requestHeaders.Authorization).toBe('Bearer sk-live')
  })

  // 没有标记 = 用户在用自己填的 key。无条件注入会把它覆盖掉。
  it('没有标记头时一个字节都不改', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({ Authorization: 'Bearer user-own-key' })

    expect(r.requestHeaders.Authorization).toBe('Bearer user-own-key')
  })

  // 过滤器必须钉死 host。漏掉它就是把凭据贴到应用发出的**每一个**请求上，
  // 包括第三方图床、更新检查、遥测 —— 那是灾难性的泄漏。
  it('只对 Miau 网关 host 生效', async () => {
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    expect(s.filter!.urls).toEqual(['https://miauapi.13797248455.xyz/*'])
  })
})
