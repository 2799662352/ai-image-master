import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 腾讯 image2(custom-imagemodel-gt) 编辑路径：参考图为 COS/远端 URL 时，
 * 走官方文档的 JSON `images:[{image_url}]`（Array of ImageRef）而不是 multipart。
 */
describe('ApiService custom-imagemodel-gt edit → JSON images[{image_url}]', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function makeService() {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    ;(service as any).apiKey = 'test-key'
    return service
  }

  const site = { authType: 'bearer' } as any

  it('sends JSON body with ImageRef objects {image_url} (not FormData / not base64)', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-imagemodel-gt')!

    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response(JSON.stringify({ data: [{ url: 'https://x/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const urls = [
      'https://image-master.cos.example.com/image-history/a.png',
      'https://image-master.cos.example.com/image-history/b.png',
    ]
    await (service as any).makeApiRequest({
      prompt: '合并这几张图',
      model: 'custom-imagemodel-gt',
      ratio: '3:2',
      resolution: '2K',
      quality: 'high',
      referenceImages: urls,
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toBe(cfg.editURL)
    // 必须是 JSON，不是 FormData
    expect(capturedInit?.body).toBeTypeOf('string')
    const body = JSON.parse(capturedInit!.body as string)
    expect(body.model).toBe('custom-imagemodel-gt')
    expect(body.prompt).toBe('合并这几张图')
    expect(body.images).toEqual(urls.map((image_url) => ({ image_url })))
    expect(body.n).toBe(1)
    expect(body.quality).toBe('high')
    expect(body.extra_body).toMatchObject({ logo_add: 0 })
    // 绝不内联 base64
    expect(capturedInit!.body as string).not.toContain('base64')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('base64(data:) 参考图也走 JSON images[] 路径（不回落 multipart）', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-imagemodel-gt')!

    let capturedInit: RequestInit | undefined
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ data: [{ url: 'https://x/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAA'
    await (service as any).makeApiRequest({
      prompt: '合并这几张图',
      model: 'custom-imagemodel-gt',
      ratio: '3:2',
      resolution: '2K',
      quality: 'high',
      referenceImages: [dataUri],
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    // 必须是 JSON（string body），不是 FormData
    expect(capturedInit?.body).toBeTypeOf('string')
    const body = JSON.parse(capturedInit!.body as string)
    expect(body.images).toEqual([{ image_url: dataUri }])
    expect(body.extra_body).toMatchObject({ logo_add: 0 })
  })

  it('裸 base64 / 混合 http+base64 都归一化成 data URI 放进 images[{image_url}]', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-imagemodel-gt')!

    let capturedInit: RequestInit | undefined
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ data: [{ url: 'https://x/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const httpUrl = 'https://image-master.cos.example.com/a.png'
    const rawB64 = 'AAAABBBBCCCC' // 无 data: 前缀的裸 base64
    await (service as any).makeApiRequest({
      prompt: '合并',
      model: 'custom-imagemodel-gt',
      ratio: '1:1',
      resolution: '1K',
      referenceImages: [httpUrl, rawB64],
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(capturedInit?.body).toBeTypeOf('string')
    const body = JSON.parse(capturedInit!.body as string)
    expect(body.images[0]).toEqual({ image_url: httpUrl })
    // 裸 base64 被补上 data: 前缀
    expect(body.images[1].image_url).toMatch(/^data:image\/[a-z]+;base64,AAAABBBBCCCC$/)
  })
})

/**
 * 去水印（logo_add:0）必须覆盖腾讯 image2 的**所有**请求路径，
 * 不能只在 JSON edit 路径上加（之前只有 edit 路径有，文生图 / FormData edit 仍带水印）。
 */
describe('ApiService custom-imagemodel-gt 去水印 extra_body.logo_add:0（全路径）', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function makeService() {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    ;(service as any).apiKey = 'test-key'
    return service
  }

  const site = { authType: 'bearer' } as any

  it('文生图 JSON payload 带 extra_body.logo_add:0', async () => {
    const service = await makeService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('custom-imagemodel-gt', '一只猫', '1536x1024', 'high')
    expect(payload).toMatchObject({
      model: 'custom-imagemodel-gt',
      prompt: '一只猫',
      size: '1536x1024',
      quality: 'high',
      extra_body: { logo_add: 0 },
    })
  })

  it('非腾讯渠道（gpt-image-2 / vip）文生图不应注入 extra_body', async () => {
    const service = await makeService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    expect((build('gpt-image-2', 'x', '1280x1280', 'high') as any).extra_body).toBeUndefined()
    expect((build('gpt-image-2-vip', 'x', '1280x1280', 'high') as any).extra_body).toBeUndefined()
  })

  it('data: 参考图编辑（现走 JSON，不再回落 FormData）也带 extra_body.logo_add:0', async () => {
    // 注：腾讯网关 edit 端点是 JSON `images:[]` 契约、不接受 multipart，因此 base64/data:
    // 参考图统一走 JSON（见 makeApiRequest 路由）。本测试确认该 JSON 路径同样去水印。
    const service = await makeService()
    const cfg = service.getModelConfig('custom-imagemodel-gt')!

    let capturedInit: RequestInit | undefined
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ data: [{ url: 'https://x/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await (service as any).makeApiRequest({
      prompt: '合并这几张图',
      model: 'custom-imagemodel-gt',
      ratio: '3:2',
      resolution: '2K',
      quality: 'high',
      referenceImages: ['data:image/png;base64,aaaa'],
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(capturedInit?.body).toBeTypeOf('string')
    const body = JSON.parse(capturedInit!.body as string)
    expect(body.images).toEqual([{ image_url: 'data:image/png;base64,aaaa' }])
    expect(body.extra_body).toMatchObject({ logo_add: 0 })
  })
})

/**
 * siteKey 自动路由：Miau-only 渠道（腾讯/万相）即使用户当前站点不是 Miau,
 * 也能通过本次请求的 `siteKey` 强制走 Miau(antigravity)站点 host + 该站点令牌。
 * 这是 codex 页把腾讯设为首选默认而无需手动切站点的底座。
 */
describe('ApiService.generateImage siteKey autoroute (Miau-only channels)', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pins the request to the given siteKey host + that site’s API key (not the current site)', async () => {
    const { ApiService } = await import('../ApiService')
    // 当前默认站点(b-apiyi)没有 Key;只有 Miau(antigravity)站点配了 Key。
    localStorage.setItem('api_key_antigravity', 'miau-key')
    const service = new ApiService()

    let capturedUrl = ''
    let capturedAuth = ''
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedAuth = String((init?.headers as Record<string, string>)?.['Authorization'] ?? '')
      return new Response(JSON.stringify({ data: [{ url: 'https://cos.example/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await service.generateImage({
      prompt: 'a cat',
      model: 'custom-imagemodel-gt',
      siteKey: 'antigravity',
    })

    expect(fetchMock).toHaveBeenCalled()
    expect(capturedUrl).toContain('miauapi.13797248455.xyz') // Miau gateway host
    expect(capturedAuth).toBe('Bearer miau-key') // Miau site key, not current site
    expect(res.success).toBe(true)
  })

  it('returns a clear error (no fetch) when the pinned site has no API key', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService() // 没有为 antigravity 配 Key
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await service.generateImage({
      prompt: 'a cat',
      model: 'custom-imagemodel-gt',
      siteKey: 'antigravity',
    })

    expect(res.success).toBe(false)
    expect(res.error).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/**
 * TokenHub OG 新渠道(custom-model-og-v2)。
 *
 * 与 `custom-imagemodel-gt` 是**两个不同的模型、两条不同的渠道**,只是线上协议
 * 恰好相同(logo_add 关水印、images:[{image_url}] 传参考图),所以共用同一套
 * 请求路径。2026-09-01 对着网关逐条实测,这里把结论钉住。
 */
describe('ApiService custom-model-og-v2', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function makeService() {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    ;(service as any).apiKey = 'test-key'
    return service
  }

  const site = { authType: 'bearer' } as any

  function captureFetch() {
    const captured: { url: string; init?: RequestInit } = { url: '' }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      captured.url = url
      captured.init = init
      return new Response(JSON.stringify({ data: [{ url: 'https://x/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    return captured
  }

  /**
   * 字段名必须是复数 `images`。单数 `image` 上游**静默忽略** —— 返回 200,
   * 但实际按纯文生图跑了,参考图完全没起作用而且没有任何报错。
   */
  it('参考图放在复数 images:[{image_url}] 里,不是单数 image', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-model-og-v2')!
    const captured = captureFetch()

    await (service as any).makeApiRequest({
      prompt: '换成蓝色',
      model: 'custom-model-og-v2',
      ratio: '1:1',
      resolution: '1K',
      referenceImages: ['https://cos.example.com/a.png'],
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(captured.url).toBe(cfg.editURL)
    const body = JSON.parse(captured.init!.body as string)
    expect(body.images).toEqual([{ image_url: 'https://cos.example.com/a.png' }])
    expect(body).not.toHaveProperty('image')
  })

  /** 关水印的 `logo_add` 是腾讯私有参数,两条腾讯渠道都要发。 */
  it('关水印参数跟着走 —— 集合判定,不是逐个 slug 硬编码', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-model-og-v2')!
    const captured = captureFetch()

    await (service as any).makeApiRequest({
      prompt: '一只猫',
      model: 'custom-model-og-v2',
      ratio: '1:1',
      resolution: '1K',
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(JSON.parse(captured.init!.body as string).extra_body).toMatchObject({ logo_add: 0 })
  })

  /**
   * 与另一条腾讯渠道不同:这条实测 `n=2` 真的回 2 张。
   *
   * 光有能力位不够 —— 2026-09-14 之前这里只断言了 capabilities,而请求体从来没带过 n,
   * 数量轴选 2 只回 1 张。现在连请求体一起锁住。
   */
  it('支持多张输出 —— 能力位 + 文生图请求体真的带 n', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-model-og-v2')!
    expect(cfg.capabilities?.multipleImages).toBe(true)
    expect(cfg.capabilities?.nativeBatch).toBe(true)
    expect(cfg.capabilities?.maxOutputs).toBeGreaterThan(1)

    const captured = captureFetch()
    await (service as any).makeApiRequest({
      prompt: '一只猫',
      model: 'custom-model-og-v2',
      ratio: '1:1',
      resolution: '1K',
      count: 2,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })
    expect(JSON.parse(captured.init!.body as string).n).toBe(2)
  })

  /** 腾讯 image2(gt)只出单张:maxOutputs 1,数量轴给多少都不发 n。 */
  it('腾讯 image2(gt) 不发 n', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-imagemodel-gt')!
    const captured = captureFetch()
    await (service as any).makeApiRequest({
      prompt: '一只猫',
      model: 'custom-imagemodel-gt',
      ratio: '1:1',
      resolution: '1K',
      count: 3,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })
    expect(JSON.parse(captured.init!.body as string)).not.toHaveProperty('n')
  })

  /**
   * 两个腾讯模型必须**同时存在**。
   *
   * 它们是不同的模型、不同的渠道,定价也不同(网关价目表:OG v2 倍率 5,
   * gtimage 倍率 29.05)—— 新增一条不代表另一条可以下掉。会这么错是因为两者
   * 协议几乎一样,重构时很容易被当成重复项合并掉一个。
   */
  it('两条腾讯渠道并存 —— 新增不等于旧的可以下掉', async () => {
    const service = await makeService()
    const all = service.getAllModels()
    expect(Object.keys(all)).toContain('custom-imagemodel-gt')
    expect(Object.keys(all)).toContain('custom-model-og-v2')
  })

  /**
   * 🚫 `hunyuan-gpt-image-2` 是更早的一条渠道,网关侧已经不用了,**不该出现在
   * 模型列表里**。
   *
   * 它仍然出现在网关的 `/v1/models` 返回里,所以看起来像个合法可选项 —— 照着
   * 那份清单加模型的人很容易把它捡回来。2026-09-01 就这么错过一次。
   */
  it('废弃的 hunyuan-gpt-image-2 不在列表里', async () => {
    const service = await makeService()
    expect(Object.keys(service.getAllModels())).not.toContain('hunyuan-gpt-image-2')
  })
})

/**
 * 同一条 og-image 渠道上的 GPT Image 2.5 Flare / Sunburst(`custom-model-og-v2.5-f` / `-s`,
 * 2026-09-15 上架,价目表倍率 5 / 补全 1,与 og-v2 同价)。
 *
 * 线上协议照抄 og-v2(腾讯 JSON 改图、logo_add、原生 n),清晰度换成 2.5 的五档梯子。
 * 透明底与 mask 都开:网关 `tokenhubog` 适配器(new-api relay/channel/tokenhubog/image.go)
 * 在 JSON `/edits` 上收 `mask:{image_url}`(URL 或 base64)并原样透传 `background`,
 * 用户 2026-09-15 实测两者可用。所以这里钉的是**JSON 字段**形态 —— 不是官转那种
 * multipart 文件;走错形态上游会静默按整图重绘。
 */
describe.each(['custom-model-og-v2.5-f', 'custom-model-og-v2.5-s'])('ApiService %s(腾讯 2.5)', (id) => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function makeService() {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    ;(service as any).apiKey = 'test-key'
    return service
  }

  const site = { authType: 'bearer' } as any

  function captureFetch() {
    const captured: { url: string; init?: RequestInit } = { url: '' }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      captured.url = url
      captured.init = init
      return new Response(JSON.stringify({ data: [{ url: 'https://x/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    return captured
  }

  it('注册为腾讯厂商、钉 Miau 站点、2.5 五档清晰度默认 high(描述不带官转美元价)', async () => {
    const service = await makeService()
    const { MIAU_SITE_KEY } = await import('../ApiService')
    const cfg = service.getModelConfig(id)!
    expect(cfg.vendor).toBe('tencent')
    expect(cfg.requiredSiteKey).toBe(MIAU_SITE_KEY)
    expect(cfg.qualities?.map((q) => q.key)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(cfg.defaultQuality).toBe('high')
    for (const q of cfg.qualities ?? []) expect(q.description).not.toMatch(/\$/)
    // 档位对照文案保留,用户仍能看出「高 = 2 代中」
    expect(cfg.qualities?.find((q) => q.key === 'high')?.description).toContain('2代中')
    expect(cfg.capabilities).toMatchObject({
      maxOutputs: 4,
      nativeBatch: true,
      qualityControl: true,
      transparentBackgroundControl: true,
    })
  })

  it('文生图:size + xhigh/max 透传、原生 n、关水印;透明底开关外发 background=transparent', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig(id)!
    const captured = captureFetch()

    await (service as any).makeApiRequest({
      prompt: '一只猫',
      model: id,
      ratio: '16:9',
      resolution: '2K',
      quality: 'xhigh',
      transparentBackground: true,
      count: 3,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(captured.url).toBe(cfg.baseURL)
    const body = JSON.parse(captured.init!.body as string)
    expect(body).toMatchObject({
      model: id,
      size: '2048x1152',
      quality: 'xhigh',
      n: 3,
      background: 'transparent',
      output_format: 'png',
      extra_body: { logo_add: 0 },
    })
  })

  it('透明底开关没开就不发 background(与官转同一裁决:能力位 + 调用方都要)', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig(id)!
    const captured = captureFetch()
    await (service as any).makeApiRequest({
      prompt: '一只猫',
      model: id,
      ratio: '1:1',
      resolution: '1K',
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })
    expect(JSON.parse(captured.init!.body as string)).not.toHaveProperty('background')
  })

  it('改图:走腾讯 JSON images:[{image_url}],quality=max 透传,n 固定 1,不带 mask 就没有 mask 字段', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig(id)!
    const captured = captureFetch()

    await (service as any).makeApiRequest({
      prompt: '换成蓝色',
      model: id,
      ratio: '1:1',
      resolution: '1K',
      quality: 'max',
      referenceImages: ['https://cos.example.com/a.png'],
      count: 2,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(captured.url).toBe(cfg.editURL)
    expect(captured.init!.headers).toMatchObject({ 'Content-Type': 'application/json' })
    const body = JSON.parse(captured.init!.body as string)
    expect(body.images).toEqual([{ image_url: 'https://cos.example.com/a.png' }])
    expect(body).toMatchObject({ quality: 'max', n: 1, extra_body: { logo_add: 0 } })
    expect(body).not.toHaveProperty('mask')
    expect(body).not.toHaveProperty('background')
  })

  /**
   * 擦除(灯箱 mask)在腾讯线上的形态:JSON `mask: { image_url }`,与 images[] 同形,
   * 不是 multipart 文件 —— 网关 normalizeMask 只认对象或裸字符串,文件形态在 JSON 链路
   * 上无从表达。同一请求里的透明底也一起进 JSON。
   */
  it('改图带 mask:JSON mask:{image_url} 对象(URL 原样),background 同行外发,仍是 JSON 不是 multipart', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig(id)!
    const captured = captureFetch()

    await (service as any).makeApiRequest({
      prompt: '只改透明区域:抹掉水杯',
      model: id,
      ratio: '1:1',
      resolution: '1K',
      quality: 'high',
      transparentBackground: true,
      referenceImages: ['https://cos.example.com/a.png'],
      maskImage: 'https://cos.example.com/a.mask.png',
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    expect(captured.url).toBe(cfg.editURL)
    expect(captured.init!.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(captured.init!.body).toEqual(expect.any(String))
    const body = JSON.parse(captured.init!.body as string)
    expect(body.images).toEqual([{ image_url: 'https://cos.example.com/a.png' }])
    expect(body.mask).toEqual({ image_url: 'https://cos.example.com/a.mask.png' })
    expect(body).toMatchObject({ quality: 'high', n: 1, background: 'transparent', extra_body: { logo_add: 0 } })
  })

  it('mask 是 base64 时归一成 data URI 放进 mask.image_url(与参考图同规则)', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig(id)!
    const captured = captureFetch()
    const rawBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

    await (service as any).makeApiRequest({
      prompt: '抹掉这块',
      model: id,
      referenceImages: ['https://cos.example.com/a.png'],
      maskImage: rawBase64,
      count: 1,
      modelConfig: cfg,
      site,
      apiKey: 'test-key',
    })

    const body = JSON.parse(captured.init!.body as string)
    expect(body.mask).toEqual({ image_url: `data:image/png;base64,${rawBase64}` })
  })

  it('mask 没配原图仍然早失败(遮罩只作用于 image[0])', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig(id)!
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      (service as any).makeApiRequest({
        prompt: '抹掉这块',
        model: id,
        maskImage: 'https://cos.example.com/a.mask.png',
        count: 1,
        modelConfig: cfg,
        site,
        apiKey: 'test-key',
      }),
    ).rejects.toThrow(/mask 遮罩需要配合原图/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/**
 * mask 只放行 MASK_INPAINT_MODELS:同一条腾讯 JSON 协议上的 og-v2(gpt-image-2 上游)
 * 与 gt(image2)**不**收 mask —— 没实测过、灯箱擦除也只绑 2.5。传了要在发请求前失败,
 * 而不是让上游按整图重绘。
 */
describe('ApiService mask 门:腾讯 og-v2 / image2 仍早失败', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(['custom-model-og-v2', 'custom-imagemodel-gt'])('%s 带 maskImage 直接拒,不发请求', async (id) => {
    const { ApiService, MASK_INPAINT_MODELS } = await import('../ApiService')
    expect(MASK_INPAINT_MODELS.has(id)).toBe(false)
    const service = new ApiService()
    ;(service as any).apiKey = 'test-key'
    const cfg = service.getModelConfig(id)!
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      (service as any).makeApiRequest({
        prompt: '抹掉这块',
        model: id,
        referenceImages: ['https://cos.example.com/a.png'],
        maskImage: 'https://cos.example.com/a.mask.png',
        count: 1,
        modelConfig: cfg,
        site: { authType: 'bearer' } as any,
        apiKey: 'test-key',
      }),
    ).rejects.toThrow(/mask.*腾讯 2\.5/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('MASK_INPAINT_MODELS 正好是官转 / vip / 2.5 四条 + 腾讯 2.5 两条', async () => {
    const { MASK_INPAINT_MODELS } = await import('../ApiService')
    expect([...MASK_INPAINT_MODELS].sort()).toEqual(
      [
        'gpt-image-2',
        'gpt-image-2-vip',
        'gpt-image-2.5-flare',
        'gpt-image-2.5-sunburst',
        'custom-model-og-v2.5-f',
        'custom-model-og-v2.5-s',
      ].sort(),
    )
  })
})
