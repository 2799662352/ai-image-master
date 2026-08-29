import { describe, expect, it, vi, beforeEach } from 'vitest'
// 送进来的标记刻意用**共享常量**而不是照抄字面量。照抄的话,这个文件只能证明「注入器
// 认得它自己那份」—— 而渲染层发的是不是同一份,恰恰是这条链路最容易断、断了又最不响
// 的地方(见 `types/authApi.ts` 里 BILLING_MARKER_HEADER 的注释)。改成从真源取之后,
// 谁在主进程重新声明一份本地字面量,这里就会红。
import { BILLING_MARKER_HEADER, BILLING_MARKER_VALUE } from '../../../../types/authApi'

/** 渲染层走 `fetch()`,Fetch 规范要求 `Headers` 把头名归一化成小写。 */
const MARKER_LC = BILLING_MARKER_HEADER.toLowerCase()

const tokenRef = { value: null as string | null }
const attributionRef = { value: {} as Record<string, string> }
vi.mock('../gatewayToken', () => ({
  getActivePoolToken: () => tokenRef.value,
  // 真实实现把 Authorization 与归属绑在一起回。这里照同样的形状,
  // 否则这个 mock 会替注入器把「只写了 Authorization」这种实现撑绿。
  gatewayPlatformHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
    ...attributionRef.value,
  }),
}))

/**
 * `isPackaged` 可变,因为本文件最要紧的一条断言就是「打包后必须忽略覆盖」。
 * 写死成常量的话那条断言就成了摆设。
 */
const electronApp = { isPackaged: false }
vi.mock('electron', () => ({ app: electronApp }))

const GATEWAY_ORIGIN_ENV = 'CATIMATION_GATEWAY_ORIGIN'

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
    attributionRef.value = {}
    electronApp.isPackaged = false
    delete process.env[GATEWAY_ORIGIN_ENV]
  })

  /**
   * 🧬 变异点:删掉注入器里那行 `Object.assign(headers, gatewayAttributionHeaders())`,
   * 这两条必红。
   *
   * 少了归属头,上游会把这笔消费以 `platform_user_id=''` / `project_id=0` 落库
   * (`new-api/model/log.go:400-423` 是从请求头取的),而查询按
   * `WHERE platform_user_id=? AND project_id=?` 走 —— **钱扣对了、流水一条都查不到**。
   * 2026-08-29 真机撞到过:余额准确减少,后台却显示「共 0 条」。
   */
  it('注入凭据时一并带上计费归属头', async () => {
    tokenRef.value = 'sk-real'
    attributionRef.value = {
      'X-Platform-User-Id': 'user-1',
      'X-Project-Id': '345',
    }
    const s = fakeSession()
    const { installGatewayHeaderInjector } = await import('../gatewayHeaderInjector')
    installGatewayHeaderInjector(s as never)

    const r = await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE })

    expect(r.requestHeaders['X-Platform-User-Id']).toBe('user-1')
    expect(r.requestHeaders['X-Project-Id']).toBe('345')
  })

  // 取不到 token 时请求本来就会 401。给一个注定失败的请求打上「这是某某的消费」
  // 没有意义,反而可能在上游留下一条归属明确、金额为零的噪音。
  it('没有 token 时不发归属头', async () => {
    tokenRef.value = null
    attributionRef.value = { 'X-Platform-User-Id': 'user-1', 'X-Project-Id': '345' }
    const s = fakeSession()
    const { installGatewayHeaderInjector } = await import('../gatewayHeaderInjector')
    installGatewayHeaderInjector(s as never)

    const r = await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE })

    expect(r.requestHeaders['X-Platform-User-Id']).toBeUndefined()
    expect(r.requestHeaders['X-Project-Id']).toBeUndefined()
  })

  it('带标记头且有 token 时，换成 Authorization 并删掉标记', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({ [BILLING_MARKER_HEADER]: BILLING_MARKER_VALUE })

    expect(r.requestHeaders.Authorization).toBe('Bearer sk-live')
    // 标记必须删掉：它是内部协议，泄漏到上游没有意义，且会出现在网关日志里。
    expect(r.requestHeaders[BILLING_MARKER_HEADER]).toBeUndefined()
  })

  // HTTP 头名本来就大小写不敏感,而渲染层出图走的是 `fetch()` —— Fetch 规范要求
  // `Headers` 把头名归一化成小写。按字面量精确查表的话标记永远不命中,请求带着标记
  // 裸奔出去拿一个 401,表现成「接好了却一次都不生效」,还极容易被误判成后端问题。
  it('标记头用小写送进来也认得出,同样删掉、同样注入', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE })

    expect(r.requestHeaders.Authorization).toBe('Bearer sk-live')
    expect(r.requestHeaders[MARKER_LC]).toBeUndefined()
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
      [BILLING_MARKER_HEADER]: BILLING_MARKER_VALUE,
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
      [MARKER_LC]: BILLING_MARKER_VALUE,
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

  // ── 开发构建专用的网关覆盖 ────────────────────────────────────────────────
  //
  // 存在的理由:整条链路在生产之外根本没法验证 —— 认证后端能用环境变量指到测试服,
  // 而网关地址写死,于是测试服换来的 token 会被发到生产网关、必定 401。
  // 「攻击者不能改」和「开发时也不能改」是两回事,只做前者会让这条链路不可验证,
  // 而不可验证本身也是风险。
  describe('网关地址覆盖', () => {
    it('开发构建下,环境变量能把过滤器指到别处', async () => {
      electronApp.isPackaged = false
      process.env[GATEWAY_ORIGIN_ENV] = 'http://43.161.233.87:3000'
      const s = fakeSession()
      const m = await import('../gatewayHeaderInjector')
      m.installGatewayHeaderInjector(s as any)

      expect(s.filter!.urls).toEqual(['http://43.161.233.87:3000/*'])
    })

    // 🔒 **本组最要紧的一条。** 环境变量是攻击者也能设的 —— 同一登录用户下的任何
    // 进程、快捷方式属性、外面套一层批处理都能设。打包产物若也读它,就等于把
    // 「凭据只发给我们的网关」从编译期保证降级成攻击者同样握有开关的运行期配置:
    // 改一个环境变量,真凭据就送到他自己的服务器上。
    it('打包产物必须无视覆盖,哪怕环境变量设着', async () => {
      electronApp.isPackaged = true
      process.env[GATEWAY_ORIGIN_ENV] = 'https://evil.example.com'
      const s = fakeSession()
      const m = await import('../gatewayHeaderInjector')
      m.installGatewayHeaderInjector(s as any)

      expect(s.filter!.urls).toEqual([`${m.DEFAULT_GATEWAY_ORIGIN}/*`])
      // 单独断一次:凭据绝不能出现在指向那个 origin 的请求上。
      expect(s.filter!.urls.join()).not.toContain('evil.example.com')
    })

    // 配置写错不能变成安全事故 —— 解析失败必须退回默认,绝不放宽。
    it('覆盖值不是合法 URL 时退回默认,不放宽过滤器', async () => {
      electronApp.isPackaged = false
      process.env[GATEWAY_ORIGIN_ENV] = 'not a url'
      const s = fakeSession()
      const m = await import('../gatewayHeaderInjector')
      m.installGatewayHeaderInjector(s as any)

      expect(s.filter!.urls).toEqual([`${m.DEFAULT_GATEWAY_ORIGIN}/*`])
    })

    // 带路径的输入会拼出 `<origin>/<path>/*` 这种匹配不到东西的模式,
    // 表现成「覆盖了但一次都没生效」—— 只取 origin。
    it('覆盖值带路径时只取 origin', async () => {
      electronApp.isPackaged = false
      process.env[GATEWAY_ORIGIN_ENV] = 'http://localhost:3000/v1/images'
      const s = fakeSession()
      const m = await import('../gatewayHeaderInjector')
      m.installGatewayHeaderInjector(s as any)

      expect(s.filter!.urls).toEqual(['http://localhost:3000/*'])
    })

    it('环境变量为空串时按没设处理', async () => {
      electronApp.isPackaged = false
      process.env[GATEWAY_ORIGIN_ENV] = '   '
      const s = fakeSession()
      const m = await import('../gatewayHeaderInjector')
      m.installGatewayHeaderInjector(s as any)

      expect(s.filter!.urls).toEqual([`${m.DEFAULT_GATEWAY_ORIGIN}/*`])
    })
  })
})
