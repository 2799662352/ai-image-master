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
// 断言刻意用**共享常量**而不是照抄字面量。照抄的话,这个文件只能证明「渲染层发的是
// 它自己那份」—— 而主进程认的是不是同一份,恰恰是这条链路最容易断、断了又最不响的
// 地方(见 `types/authApi.ts` 里 BILLING_MARKER_HEADER 的注释)。改成从真源取之后,
// 谁在渲染层重新声明一份本地字面量,这里就会红。
import { BILLING_MARKER_HEADER, BILLING_MARKER_VALUE } from '../../../../../types/authApi'

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
  /** 默认那个 Seedream 走标准 OpenAI 兼容端点；要验谷歌原生绕道就显式换模型。 */
  model?: string
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
    .generateImage({
      prompt: 'x',
      model: opts.model ?? 'doubao-seedream-5-0-pro-260628',
      siteKey: opts.site,
    })
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

    expect(headers[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
    // 关键：渲染层根本没有 token 可发。发了空 Bearer 会被主进程覆盖，
    // 但发了用户的旧 key 就会在主进程注入失败时静默走错账。
    expect(headers.Authorization).toBeUndefined()
  })

  it('自有 key 模式：照旧发 Authorization，不打标记', async () => {
    const headers = await captureHeadersFor({ billingSource: 'own-key', site: 'antigravity' })

    expect(headers.Authorization).toBe('Bearer user-typed-key')
    expect(headers[BILLING_MARKER_HEADER]).toBeUndefined()
  })

  // 平台余额只覆盖 Miau 网关。别的站点（apiyi / 自建）是另外的计费域，
  // 打了标记也没用，反而会因为缺 Authorization 直接 401。
  it('非 Miau 站点即使开着平台模式也不打标记', async () => {
    const headers = await captureHeadersFor({ billingSource: 'platform', site: 'apiyi' })

    expect(headers[BILLING_MARKER_HEADER]).toBeUndefined()
    expect(headers.Authorization).toBe('Bearer user-typed-key')
  })

  // 站点对了模型也可能不对。谷歌原生端点绕开加速域名直连源站(EdgeOne 不支持那条
  // 路径),而注入器只挂在加速域名那一个 host 上 —— 打了标记也换不到 Authorization,
  // 结果是必定 401,外加把内部协议头明文发给一个注入器看不见的 IP。
  it('谷歌原生模型即使在 Miau 站点也不打标记(它绕开了注入器覆盖的 host)', async () => {
    const headers = await captureHeadersFor({
      billingSource: 'platform',
      site: 'antigravity',
      model: 'gemini-3.1-flash-image',
    })

    expect(headers[BILLING_MARKER_HEADER]).toBeUndefined()
    // 回落到自填 Key。不回落的话这条请求既没 Authorization 也换不到 token,必 401。
    expect(headers.Authorization).toBe('Bearer user-typed-key')
  })
})

/**
 * 理解那一族(图像理解 / 流式分析 / understand 视频·文档·联网)。
 *
 * 这三条此前**各自手写 `Authorization: Bearer`**,完全绕开 `applyAuthHeaders` ——
 * 于是打的是 Miau 站点、扣的却永远是自填 Key 的钱,而且因为没有归属头,平台用量
 * 明细里一条都查不到。MCP 的 `understand_video` / `understand_document` /
 * `web_research` 走的正是这条路。
 */
describe('理解族也走平台余额', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  /** 抓一次请求的头。`ok` 决定要不要让被测方法走成功分支。 */
  function stubFetch(): () => Record<string, string> {
    let seen: Record<string, string> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen = (init?.headers ?? {}) as Record<string, string>
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
    return () => seen
  }

  async function makeService(billingSource: 'platform' | 'own-key', withKey: boolean) {
    if (withKey) {
      localStorage.setItem('api_key_antigravity', 'user-typed-key')
      localStorage.setItem('vision_api_key_antigravity', 'user-typed-key')
    }
    localStorage.setItem('current_site', 'antigravity')
    const { useQuotaStore } = await import('../../../stores/useQuotaStore')
    useQuotaStore.setState({ billingSource })
    const { ApiService } = await import('../ApiService')
    return new ApiService()
  }

  /**
   * 🧬 变异点:把 `understandAttempt` 里的 `applyAuthHeaders` 换回手写
   * `Authorization: Bearer ${key}`,这条必红。
   */
  it('understand(视频/文档/联网):平台模式打标记,不发 Authorization', async () => {
    const headers = stubFetch()
    const svc = await makeService('platform', true)

    await svc.understand({ kind: 'web', query: 'x' }).catch(() => {})

    expect(headers()[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
    expect(headers().Authorization).toBeUndefined()
  })

  it('understand:自有 Key 模式照旧发 Authorization', async () => {
    const headers = stubFetch()
    const svc = await makeService('own-key', true)

    await svc.understand({ kind: 'web', query: 'x' }).catch(() => {})

    expect(headers().Authorization).toBe('Bearer user-typed-key')
    expect(headers()[BILLING_MARKER_HEADER]).toBeUndefined()
  })

  /**
   * 🧬 变异点:把 `understand` 里那道门改回无条件 `if (!key) return`,这条必红。
   *
   * 平台模式下**本来就不该有自填 Key** —— 凭据在主进程。原先这道门会把三个 MCP
   * 理解工具在平台模式下一律拦成「未配置 Miau API 令牌」,而用户明明已经登录、
   * 也选好了计费池。
   */
  it('understand:平台模式下没有自填 Key 也能发出去', async () => {
    const headers = stubFetch()
    const svc = await makeService('platform', false)

    const r = await svc.understand({ kind: 'web', query: 'x' })

    expect(r.success, '平台模式不该被「未配置令牌」拦下').toBe(true)
    expect(headers()[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
  })

  it('understand:自有 Key 模式下没 Key 仍然如实拦下', async () => {
    stubFetch()
    const svc = await makeService('own-key', false)

    const r = await svc.understand({ kind: 'web', query: 'x' })

    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toMatch(/未配置 Miau/)
  })

  /** 🧬 变异点:`understandImage` 换回手写 Authorization,这条必红。 */
  it('图像理解:平台模式打标记,不发 Authorization', async () => {
    const headers = stubFetch()
    const svc = await makeService('platform', true)

    await svc
      .understandImage({ images: ['data:image/png;base64,aaa'], prompt: 'x' })
      .catch(() => {})

    expect(headers()[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
    expect(headers().Authorization).toBeUndefined()
  })

  /**
   * 🧬 变异点:把 `understandImage` 那道门改回无条件 `if (!apiKey)`,这条必红。
   *
   * 平台模式没有自填 Key 是正常的。拦下来的话用户会看到「请先设置 API Key」——
   * 而他刚刚才登录、选好计费池,只会去怀疑登录没生效。
   */
  it('图像理解:平台模式下没自填 Key 也能发出去', async () => {
    const headers = stubFetch()
    const svc = await makeService('platform', false)

    const r = await svc.understandImage({ images: ['data:image/png;base64,aaa'], prompt: 'x' })

    expect(r.success, '平台模式不该被「请先设置 API Key」拦下').toBe(true)
    expect(headers()[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
  })

  it('图像理解:自有 Key 模式下没 Key 仍然如实拦下', async () => {
    stubFetch()
    const svc = await makeService('own-key', false)

    const r = await svc.understandImage({ images: ['data:image/png;base64,aaa'], prompt: 'x' })

    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toMatch(/API Key/)
  })

  /**
   * 🧬 变异点:把 `analyzeImagesStream` 那道门改回无条件 `if (!this.visionApiKey)`,
   * 这条必红。它是**抛异常**而不是回错误对象,所以用 rejects 断言。
   */
  it('流式图像分析:平台模式下没自填 Key 也不抛', async () => {
    const headers = stubFetch()
    const svc = await makeService('platform', false)

    await expect(
      svc.analyzeImagesStream([{ base64: 'aaa' }], 'x', 'qwen3.8-max', null, () => {}, () => {}, () => {}),
    ).resolves.toBeUndefined()
    expect(headers()[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
  })

  it('流式图像分析:自有 Key 模式下没 Key 仍然如实抛', async () => {
    stubFetch()
    const svc = await makeService('own-key', false)

    await expect(
      svc.analyzeImagesStream([{ base64: 'aaa' }], 'x', 'qwen3.8-max', null, () => {}, () => {}, () => {}),
    ).rejects.toThrow(/图像理解 API Key/)
  })

  /** 🧬 变异点:`analyzeImagesStream` 换回手写 Authorization,这条必红。 */
  it('流式图像分析:平台模式打标记,不发 Authorization', async () => {
    const headers = stubFetch()
    const svc = await makeService('platform', true)

    await svc
      .analyzeImagesStream(
        [{ base64: 'aaa' }],
        'x',
        'qwen3.8-max',
        null,
        () => {},
        () => {},
        () => {},
      )
      .catch(() => {})

    expect(headers()[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
    expect(headers().Authorization).toBeUndefined()
  })
})

/**
 * 「这个模型能不能用平台余额」的判据。
 *
 * 之所以要独立成纯函数并单测:这件事此前是**两处隐性耦合**——`buildRequestUrl` 决定
 * 请求实际打向哪个 host(谷歌原生模型会被换成 `directBaseURL`),而计费判定看的是
 * `site.baseURL`。两处谁也不知道谁存在,于是「站点是 Miau」为真、「请求打到 Miau」为假,
 * 标记头照打、凭据换不到 —— 静默 401。
 *
 * 判据收进 `evaluatePlatformBillingEligibility` 之后,下面那条 **真源一致性** 用例会
 * 遍历全部模型,拿它的结论和 `buildRequestUrl` 的实际产物对账。谁再单独改一边,这里就红。
 */
describe('平台余额 × 模型可用性', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  const GOOGLE_NATIVE_MODELS = [
    'gemini-3.1-flash-image',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image',
  ]

  async function load() {
    const mod = await import('../ApiService')
    const svc = new mod.ApiService()
    const internals = svc as unknown as {
      models: Record<string, unknown>
      apiSites: Record<string, unknown>
      buildRequestUrl(model: unknown, site: unknown): string
    }
    return { ...mod, svc, internals }
  }

  it('谷歌原生模型在 Miau 站点上不可用,并说明是模型绕开了网关', async () => {
    const { evaluatePlatformBillingEligibility, internals } = await load()
    const gateway = internals.apiSites['antigravity']

    for (const key of GOOGLE_NATIVE_MODELS) {
      const verdict = evaluatePlatformBillingEligibility(
        internals.models[key] as never,
        gateway as never,
        gateway as never,
      )
      expect(verdict.eligible, `${key} 不该被判为可用`).toBe(false)
      expect(verdict.blocker).toBe('model-bypasses-gateway')
    }
  })

  it('普通模型在 Miau 站点上可用', async () => {
    const { evaluatePlatformBillingEligibility, internals } = await load()
    const gateway = internals.apiSites['antigravity']

    const verdict = evaluatePlatformBillingEligibility(
      internals.models['doubao-seedream-5-0-pro-260628'] as never,
      gateway as never,
      gateway as never,
    )
    expect(verdict.eligible).toBe(true)
    expect(verdict.blocker).toBeNull()
  })

  // 判据必须挂在「站点有没有配源站直连」上,而不是硬编码那三个模型名。
  // 站点没配 directBaseURL 时谷歌模型照旧走加速域名,那就是可用的。
  it('站点没配源站直连时,谷歌原生模型照样可用(不硬编码模型名单)', async () => {
    const { evaluatePlatformBillingEligibility, internals } = await load()
    const gateway = internals.apiSites['antigravity'] as Record<string, unknown>
    const siteWithoutDirect = { ...gateway, directBaseURL: undefined }

    const verdict = evaluatePlatformBillingEligibility(
      internals.models['gemini-3.1-flash-image'] as never,
      siteWithoutDirect as never,
      gateway as never,
    )
    expect(verdict.eligible).toBe(true)
  })

  it('非网关站点给出的是站点级原因,不是模型级', async () => {
    const { evaluatePlatformBillingEligibility, internals } = await load()

    const verdict = evaluatePlatformBillingEligibility(
      internals.models['gemini-3.1-flash-image'] as never,
      internals.apiSites['apiyi'] as never,
      internals.apiSites['antigravity'] as never,
    )
    expect(verdict.eligible).toBe(false)
    // 站点就不对,再谈模型没有意义 —— UI 那边已经有一句「仅 Miau 站点生效」了,
    // 这里若报 model-bypasses-gateway 会让用户以为换个模型就好。
    expect(verdict.blocker).toBe('site-not-gateway')
  })

  it('站点缺失时不崩,给出 no-site', async () => {
    const { evaluatePlatformBillingEligibility, internals } = await load()

    const verdict = evaluatePlatformBillingEligibility(
      internals.models['gemini-3.1-flash-image'] as never,
      undefined,
      internals.apiSites['antigravity'] as never,
    )
    expect(verdict.eligible).toBe(false)
    expect(verdict.blocker).toBe('no-site')
  })

  // 🚨 防漂移。这条用例的价值不在于断言某个模型,而在于:任何人改了 buildRequestUrl
  // 的 host 选择逻辑(加一类绕道、去掉一类绕道)而没同步计费判定,这里立刻红。
  it('真源一致性:每个模型的判定都和 buildRequestUrl 的实际产物对得上', async () => {
    const { evaluatePlatformBillingEligibility, internals } = await load()
    const gateway = internals.apiSites['antigravity'] as { baseURL: string }

    const mismatched: string[] = []
    for (const [key, cfg] of Object.entries(internals.models)) {
      const actualUrl = internals.buildRequestUrl(cfg, gateway)
      const actuallyHitsGateway = new URL(actualUrl).host === new URL(gateway.baseURL).host
      const verdict = evaluatePlatformBillingEligibility(
        cfg as never,
        gateway as never,
        gateway as never,
      )
      if (verdict.eligible !== actuallyHitsGateway) mismatched.push(key)
    }

    expect(mismatched).toEqual([])
  })

  // UI 要用的入口:它手上只有一个模型 key,站点解析(requiredSiteKey → 当前站点)
  // 得由 service 按请求路径那套优先级来,不能让组件自己抄一份。
  it('getPlatformBillingEligibility 按当前站点解析,并跟随 requiredSiteKey', async () => {
    localStorage.setItem('current_site', 'antigravity')
    const { svc } = await load()

    expect(svc.getPlatformBillingEligibility('gemini-3.1-flash-image').eligible).toBe(false)
    expect(svc.getPlatformBillingEligibility('doubao-seedream-5-0-pro-260628').eligible).toBe(true)
  })

  it('当前站点不是网关时,getPlatformBillingEligibility 报站点级原因', async () => {
    localStorage.setItem('current_site', 'apiyi')
    const { svc } = await load()

    expect(svc.getPlatformBillingEligibility('gemini-3.1-flash-image').blocker).toBe(
      'site-not-gateway',
    )
    // requiredSiteKey 钉在 Miau 的模型不受当前站点影响。
    expect(svc.getPlatformBillingEligibility('doubao-seedream-5-0-pro-260628').eligible).toBe(true)
  })

  it('模型不认识时不下判断(别对着一个空 key 报警)', async () => {
    localStorage.setItem('current_site', 'antigravity')
    const { svc } = await load()

    expect(svc.getPlatformBillingEligibility('').blocker).toBe('unknown-model')
    expect(svc.getPlatformBillingEligibility('no-such-model').blocker).toBe('unknown-model')
  })
})
