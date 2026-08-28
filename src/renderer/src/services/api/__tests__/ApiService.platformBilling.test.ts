// 平台计费模式下的请求头。
//
// 这一层要守的是一条**安全边界**:渲染层是 `nodeIntegration: true` 且无
// contextIsolation 的环境,永远拿不到网关 token。平台模式下它只打一个标记头,
// 主进程的 `onBeforeSendHeaders` 按 host 过滤后换成真 `Authorization`。
//
// 所以这里断的不只是「标记头在不在」,更关键的是那条**负向断言**:平台模式下
// `Authorization` 必须缺席。主进程收到标记后会无条件先删 Authorization 再决定要不要
// 写自己的(见 gatewayHeaderInjector 的注释),但那只在**请求真的经过注入器**时成立 ——
// 注入器的 URL 过滤器只覆盖 Miau 网关那一个 host。渲染层若把用户自填的 key 一起发出去,
// 一旦注入没生效(host 不匹配 / 池没就绪),请求就会**静默地用用户自己的钱出图成功**,
// 而用户以为在花平台余额。宁可裸奔去撞 401。
//
// 站点维度同理:平台余额只覆盖 Miau 网关。apiyi / 自建 / 用户自定义站点是另外的计费域,
// 打了标记也换不到凭据,反而因为缺 Authorization 直接 401。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * 跑一次出图,把发出去的请求头抓回来。
 *
 * 装配方式照 `ApiService.tencentImage2.test.ts` 的 siteKey autoroute 用例校准:
 * - **Key 只能经 localStorage 注入,且必须在 `new ApiService()` 之前**。构造函数
 *   当场就把 `api_key_<currentSite>` 读进实例字段了,之后再塞已经晚了;而非当前站点
 *   的 key 由 `getStoredApiKey(siteKey)` 每次现读,同样只认 localStorage。
 * - `siteKey` 参数优先级最高,能盖过模型自带的 `requiredSiteKey`(Seedream 5.0 Pro
 *   钉死在 Miau),所以第三条用例才能把同一个模型打到 apiyi 上。
 */
async function captureHeadersFor(opts: {
  billingSource: 'platform' | 'own-key'
  site: string
}): Promise<Record<string, string>> {
  let seen: Record<string, string> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ data: [{ url: 'https://example.test/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )

  // 用户自填的 key。它存在正是为了验证「平台模式下它不该被发出去」。
  localStorage.setItem(`api_key_${opts.site}`, 'user-typed-key')

  // store 的 billingSource 由 ApiService 通过 getState() 读取,所以这里直接置状态。
  // 两个 import 共享同一份模块注册表(beforeEach 里 resetModules 过),ApiService
  // 拿到的就是这个实例。
  const { useQuotaStore } = await import('../../../stores/useQuotaStore')
  useQuotaStore.setState({ billingSource: opts.billingSource })

  const { ApiService } = await import('../ApiService')
  const svc = new ApiService()
  await svc
    .generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628', siteKey: opts.site })
    .catch(() => {})
  return seen
}

describe('平台计费模式下的请求头', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('平台模式：打标记头，且不发 Authorization', async () => {
    const headers = await captureHeadersFor({ billingSource: 'platform', site: 'antigravity' })

    expect(headers['X-Catimation-Billing']).toBe('platform')
    // 关键：渲染层根本没有 token 可发。发了空 Bearer 会被主进程覆盖，
    // 但发了用户的旧 key 就会在主进程注入失败时静默走错账。
    expect(headers.Authorization).toBeUndefined()
  })

  it('自有 key 模式：照旧发 Authorization，不打标记', async () => {
    const headers = await captureHeadersFor({ billingSource: 'own-key', site: 'antigravity' })

    expect(headers.Authorization).toBe('Bearer user-typed-key')
    expect(headers['X-Catimation-Billing']).toBeUndefined()
  })

  // 平台余额只覆盖 Miau 网关。别的站点（apiyi / 自建）是另外的计费域，
  // 打了标记也没用，反而会因为缺 Authorization 直接 401。
  it('非 Miau 站点即使开着平台模式也不打标记', async () => {
    const headers = await captureHeadersFor({ billingSource: 'platform', site: 'apiyi' })

    expect(headers['X-Catimation-Billing']).toBeUndefined()
    expect(headers.Authorization).toBe('Bearer user-typed-key')
  })
})
