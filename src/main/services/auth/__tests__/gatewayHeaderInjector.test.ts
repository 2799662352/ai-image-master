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

/** 扣费上报。用 mock 而不是真模块,免得把防抖定时器牵进这个文件。 */
const noteSpend = vi.fn()
vi.mock('../platformSpend', () => ({
  notePlatformSpend: () => noteSpend(),
}))

const GATEWAY_ORIGIN_ENV = 'CATIMATION_GATEWAY_ORIGIN'

/** 把注册进去的 listener 抓出来直接调,不起真 session。 */
function fakeSession() {
  let captured: ((d: any, cb: (r: any) => void) => void) | null = null
  let capturedFilter: { urls: string[] } | null = null
  let onCompleted: ((d: any) => void) | null = null
  let onErrorOccurred: ((d: any) => void) | null = null
  return {
    webRequest: {
      onBeforeSendHeaders(filter: any, listener: any) {
        capturedFilter = filter
        captured = listener
      },
      onCompleted(_filter: any, listener: any) {
        onCompleted = listener
      },
      onErrorOccurred(_filter: any, listener: any) {
        onErrorOccurred = listener
      },
    },
    /** `id` 默认给一个固定值,只在需要区分并发请求的用例里才显式传。 */
    invoke(headers: Record<string, string>, id = 1) {
      return new Promise<any>((resolve) => captured!({ id, requestHeaders: headers }, resolve))
    },
    complete(id = 1) {
      onCompleted!({ id })
    },
    fail(id = 1) {
      onErrorOccurred!({ id })
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
    noteSpend.mockClear()
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

    /**
     * 拿不到 `app` 时同样按打包处理 —— **兜底方向必须与另外两处一致**。
     *
     * 全仓有三处「开发期可覆盖端点」的闸:本函数、`resolveMiauBaseUrl`(调用方写
     * `app?.isPackaged ?? true`)、`authBaseUrl()`(闸默认关)。后两处都是「证不出
     * 是开发构建就按生产办」,而这里原本写 `=== true`,是三处里唯一在 `app` 缺失时
     * **倒向放行**的。
     *
     * 真实主进程里 `app.isPackaged` 一定是布尔值,所以那不是活跃缺陷;但这个模块
     * 一旦被搬进 electron 之外的上下文(脚本、worker),放行的那一版会静默地把凭据
     * 发到环境变量指定的地址 —— 而这正是本组第一条注释里描述的那个外泄原语。
     *
     * 🧬 变异点:把判据改回 `app?.isPackaged === true`,这条必红。
     */
    it('拿不到 app 时按打包处理,不认覆盖', async () => {
      delete (electronApp as { isPackaged?: boolean }).isPackaged
      process.env[GATEWAY_ORIGIN_ENV] = 'https://evil.example.com'
      const s = fakeSession()
      const m = await import('../gatewayHeaderInjector')
      m.installGatewayHeaderInjector(s as any)

      expect(s.filter!.urls).toEqual([`${m.DEFAULT_GATEWAY_ORIGIN}/*`])
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

  /**
   * 扣费上报。没有它,出图扣完钱余额还停在旧值,用户要把设置页关掉重开才看得到 ——
   * 这正是 2026-08-31 报上来的症状。
   */
  describe('消费上报', () => {
    async function install() {
      const s = fakeSession()
      const m = await import('../gatewayHeaderInjector')
      m.installGatewayHeaderInjector(s as any)
      return s
    }

    it('注入了凭据的请求完成后报一次消费', async () => {
      tokenRef.value = 'sk-real'
      const s = await install()

      await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE })
      // 请求还在途时不该报 —— 上游是在转发这次请求的事务里落账的,
      // 提前报会让渲染层读到扣费前的余额,刷了等于没刷。
      expect(noteSpend).not.toHaveBeenCalled()

      s.complete()
      expect(noteSpend).toHaveBeenCalledTimes(1)
    })

    // 上游可能已经扣了钱才在传输层断掉,所以失败也要报。
    it('注入了凭据的请求出错后同样报一次', async () => {
      tokenRef.value = 'sk-real'
      const s = await install()

      await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE })
      s.fail()

      expect(noteSpend).toHaveBeenCalledTimes(1)
    })

    /**
     * 🧬 变异点:把注入器里 `billedRequestIds.add` 的判据从「取到 token」放宽成
     * 「打了标记」,这条必红。
     *
     * 没取到 token 的请求会裸奔去撞 401,一分钱不扣。报上去只是让余额白查一次,
     * 而且**每一次**失败的出图都会白查 —— 恰恰是用户没选计费池、疯狂点重试的时候。
     */
    it('没取到凭据的请求不报 —— 它撞 401,一分钱没花', async () => {
      tokenRef.value = null
      const s = await install()

      await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE })
      s.complete()

      expect(noteSpend).not.toHaveBeenCalled()
    })

    it('没打标记的请求不报 —— 那是用户自己的 Key', async () => {
      tokenRef.value = 'sk-real'
      const s = await install()

      await s.invoke({ authorization: 'Bearer sk-user-own' })
      s.complete()

      expect(noteSpend).not.toHaveBeenCalled()
    })

    /**
     * 🧬 变异点:把 `settle` 里的 `billedRequestIds.delete(id)` 换成 `has(id)`,
     * 这条必红 —— Electron 对同一个请求可能既发 onCompleted 又发别的终态事件,
     * 不摘掉 id 就会重复计数,而且那个 Set 会一直涨。
     */
    it('同一个请求的终态事件只报一次', async () => {
      tokenRef.value = 'sk-real'
      const s = await install()

      await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE })
      s.complete()
      s.complete()
      s.fail()

      expect(noteSpend).toHaveBeenCalledTimes(1)
    })

    it('并发请求各报各的,不会互相顶掉', async () => {
      tokenRef.value = 'sk-real'
      const s = await install()

      await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE }, 11)
      await s.invoke({ [MARKER_LC]: BILLING_MARKER_VALUE }, 22)
      s.complete(22)
      s.complete(11)

      expect(noteSpend).toHaveBeenCalledTimes(2)
    })

    it('没发过的请求 id 落地时不报 —— 那是别的功能打到同一个 host', async () => {
      tokenRef.value = 'sk-real'
      const s = await install()

      s.complete(999)

      expect(noteSpend).not.toHaveBeenCalled()
    })
  })
})
