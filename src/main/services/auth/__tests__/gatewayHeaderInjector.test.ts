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
