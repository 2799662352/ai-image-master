import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BILLING_MARKER_HEADER } from '../../../../../types/authApi'
import {
  CUSTOM_GATEWAY_URL_STORAGE_KEY,
  DEFAULT_CUSTOM_GATEWAY_URL,
  LEGACY_LOCAL_PORT_STORAGE_KEY,
} from '../../../../../shared/customGatewayUrl'

/**
 * 设置页「自定义网关」(site key 仍是 `local`)。
 *
 * 以前只有一个端口框,地址固定 `http://127.0.0.1:<端口>`;现在整个根地址都可填,
 * 本机、局域网、公网部署的 new-api 都行。这里钉住几件容易悄悄坏掉的事:
 *  - 地址在**所有**重建站点表的路径上都不丢(增删改自定义站点会重建);
 *  - 不合法的输入不落盘、不动正在用的网关;
 *  - 老用户升级后原来填的端口还在;
 *  - 自定义 URL 不会被当成 Miau 而挂上平台计费标记(那是计费安全边界)。
 */

async function makeService() {
  const { ApiService } = await import('../ApiService')
  return new ApiService()
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('自定义网关 —— 站点条目', () => {
  it('site key 仍是 local(已存的 api_key_local / current_site 靠它),名字改成「自定义网关」', async () => {
    const site = (await makeService()).getAllSites()['local']

    expect(site).toBeDefined()
    expect(site.name).toBe('自定义网关')
    expect(site.baseURL).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
    expect(site.authType).toBe('bearer')
    expect(site.isBuiltIn).toBe(true)
  })

  it('没填过任何东西 → 缺省本机 3000', async () => {
    expect((await makeService()).getLocalUrl()).toBe('http://127.0.0.1:3000')
  })
})

describe('自定义网关 —— setLocalUrl', () => {
  it('公网地址:归一化后立即生效,站点表里的 baseURL 跟着变', async () => {
    const svc = await makeService()

    const r = svc.setLocalUrl('api.example.com/v1/')

    expect(r).toEqual({ ok: true, url: 'https://api.example.com', insecurePublicHttp: false })
    expect(svc.getLocalUrl()).toBe('https://api.example.com')
    expect(svc.getAllSites()['local'].baseURL).toBe('https://api.example.com')
  })

  it('当前站点就是 local 时,getCurrentSite 立刻读到新地址', async () => {
    const svc = await makeService()
    svc.setSite('local')

    svc.setLocalUrl('http://192.168.1.5:3000')

    expect(svc.getCurrentSite()?.baseURL).toBe('http://192.168.1.5:3000')
  })

  it('落盘,新实例(= 重启应用)读得回来', async () => {
    const first = await makeService()
    first.setLocalUrl('https://api.example.com')

    expect(localStorage.getItem(CUSTOM_GATEWAY_URL_STORAGE_KEY)).toBe('https://api.example.com')
    expect((await makeService()).getLocalUrl()).toBe('https://api.example.com')
  })

  it('公网明文 http 照存,并在返回值里标记(界面据此提醒)', async () => {
    const r = (await makeService()).setLocalUrl('http://175.178.198.17:3000')

    expect(r).toEqual({ ok: true, url: 'http://175.178.198.17:3000', insecurePublicHttp: true })
  })

  it('不合法:不落盘、不动正在用的地址,返回失败原因', async () => {
    const svc = await makeService()
    svc.setLocalUrl('https://good.example.com')

    for (const [raw, reason] of [
      ['http://', 'invalid'],
      ['ftp://x.com', 'scheme'],
      ['https://u:p@x.com', 'credentials'],
      ['a b', 'invalid'],
      ['70000', 'invalid'],
    ] as const) {
      expect(svc.setLocalUrl(raw), raw).toEqual({ ok: false, reason })
      expect(svc.getLocalUrl(), raw).toBe('https://good.example.com')
      expect(svc.getAllSites()['local'].baseURL, raw).toBe('https://good.example.com')
      expect(localStorage.getItem(CUSTOM_GATEWAY_URL_STORAGE_KEY), raw).toBe('https://good.example.com')
    }
  })

  it('留空 = 恢复缺省,并清掉存的值', async () => {
    const svc = await makeService()
    svc.setLocalUrl('https://api.example.com')

    const r = svc.setLocalUrl('   ')

    expect(r).toEqual({ ok: true, url: DEFAULT_CUSTOM_GATEWAY_URL, insecurePublicHttp: false })
    expect(svc.getLocalUrl()).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
    expect(localStorage.getItem(CUSTOM_GATEWAY_URL_STORAGE_KEY)).toBeNull()
    expect((await makeService()).getLocalUrl()).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
  })

  it('改地址不碰旧版端口键(回滚到旧版时它还在)', async () => {
    localStorage.setItem(LEGACY_LOCAL_PORT_STORAGE_KEY, '4000')
    const svc = await makeService()

    svc.setLocalUrl('https://api.example.com')

    expect(localStorage.getItem(LEGACY_LOCAL_PORT_STORAGE_KEY)).toBe('4000')
  })

  it('多个实例互不串:一个实例改地址,不会改到模块级的内置站点常量', async () => {
    const a = await makeService()
    a.setLocalUrl('https://api.example.com')

    localStorage.clear()
    const b = await makeService()

    expect(b.getLocalUrl()).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
    expect(b.getAllSites()['local'].baseURL).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
  })
})

describe('自定义网关 —— 老用户升级', () => {
  it('旧版只存过端口 → 升级后仍指向 http://127.0.0.1:<那个端口>', async () => {
    localStorage.setItem(LEGACY_LOCAL_PORT_STORAGE_KEY, '8080')

    const svc = await makeService()

    expect(svc.getLocalUrl()).toBe('http://127.0.0.1:8080')
    expect(svc.getAllSites()['local'].baseURL).toBe('http://127.0.0.1:8080')
  })

  it('旧端口键在、用户把地址框清空 → 回到缺省,且重启后不会又变回旧端口', async () => {
    localStorage.setItem(LEGACY_LOCAL_PORT_STORAGE_KEY, '8080')
    const svc = await makeService()

    svc.setLocalUrl('')

    expect(svc.getLocalUrl()).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
    expect((await makeService()).getLocalUrl()).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
  })
})

describe('自定义网关 —— 站点表重建时地址不丢', () => {
  it('增删改自定义站点(都会重建站点表)之后,自定义网关地址仍是用户填的', async () => {
    const svc = await makeService()
    svc.setLocalUrl('https://api.example.com')

    expect(svc.addCustomSite('mine', { name: 'Mine', baseURL: 'https://mine.example.com' })).toBe(true)
    expect(svc.getAllSites()['local'].baseURL).toBe('https://api.example.com')

    expect(svc.updateCustomSite('mine', { description: 'x' })).toBe(true)
    expect(svc.getAllSites()['local'].baseURL).toBe('https://api.example.com')

    expect(svc.removeCustomSite('mine')).toBe(true)
    expect(svc.getAllSites()['local'].baseURL).toBe('https://api.example.com')
  })

  it('用户自定义站点不能占用 local 这个 key(内置站点不可覆盖)', async () => {
    const svc = await makeService()
    svc.setLocalUrl('https://api.example.com')

    expect(svc.addCustomSite('local', { name: 'x', baseURL: 'https://evil.example.com' })).toBe(false)
    expect(svc.getAllSites()['local'].baseURL).toBe('https://api.example.com')
  })
})

describe('自定义网关 —— 请求地址', () => {
  function urlFor(service: unknown, modelKey: string, siteKey: string): string {
    const s = service as {
      models: Record<string, unknown>
      apiSites: Record<string, unknown>
      buildRequestUrl(model: unknown, site: unknown): string
    }
    return s.buildRequestUrl(s.models[modelKey], s.apiSites[siteKey])
  }

  it('出图接口打到用户填的 host(协议也跟着站点走)', async () => {
    const svc = await makeService()
    svc.setLocalUrl('http://192.168.1.5:3000')

    const url = new URL(urlFor(svc, 'doubao-seedream-5-0-pro-260628', 'local'))

    expect(url.origin).toBe('http://192.168.1.5:3000')
    expect(url.pathname).toBe('/v1/images/generations')
  })

  it('反代子路径:接口路径接在它后面,不被吞掉', async () => {
    const svc = await makeService()
    svc.setLocalUrl('https://x.example.com/newapi')

    const url = new URL(urlFor(svc, 'doubao-seedream-5-0-pro-260628', 'local'))

    expect(url.origin).toBe('https://x.example.com')
    expect(url.pathname).toBe('/newapi/v1/images/generations')
  })

  it('没有子路径的站点(内置站点全是这样)行为不变', async () => {
    const svc = await makeService()

    const url = new URL(urlFor(svc, 'doubao-seedream-5-0-pro-260628', 'antigravity'))

    expect(url.origin).toBe('https://miauapi.13797248455.xyz')
    expect(url.pathname).toBe('/v1/images/generations')
  })
})

describe('自定义网关 —— 不会被当成 Miau(平台计费边界)', () => {
  async function captureRequest(billingSource: 'platform' | 'own-key') {
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seenUrl = url
        seenHeaders = (init?.headers ?? {}) as Record<string, string>
        return new Response(JSON.stringify({ data: [{ url: 'https://example.test/out.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    localStorage.setItem('api_key_local', 'user-typed-key')
    const { useQuotaStore } = await import('../../../stores/useQuotaStore')
    useQuotaStore.setState({ billingSource })

    const svc = await makeService()
    svc.setLocalUrl('https://gw.example.com')
    await svc
      .generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628', siteKey: 'local' })
      .catch(() => {})
    return { seenUrl, seenHeaders }
  }

  it('平台余额模式下,发往自定义网关的请求既不打平台标记、也照常带用户自己的 Key', async () => {
    const { seenUrl, seenHeaders } = await captureRequest('platform')

    expect(seenUrl).toContain('https://gw.example.com/v1/images/generations')
    expect(seenHeaders[BILLING_MARKER_HEADER]).toBeUndefined()
    expect(seenHeaders.Authorization).toBe('Bearer user-typed-key')
  })

  it('自有 Key 模式同理', async () => {
    const { seenUrl, seenHeaders } = await captureRequest('own-key')

    expect(seenUrl).toContain('https://gw.example.com/v1/images/generations')
    expect(seenHeaders[BILLING_MARKER_HEADER]).toBeUndefined()
    expect(seenHeaders.Authorization).toBe('Bearer user-typed-key')
  })
})
