import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * apiyi gpt-image-2-vip 文档 OpenAPI 严格枚举的 30 档 size。
 * 文档: https://docs.apiyi.com/api-capabilities/gpt-image-2-vip/text-to-image
 *       https://docs.apiyi.com/api-capabilities/gpt-image-2-vip/image-edit
 * 不在这个集合里的 size 字符串, API 会直接 400:
 *   "size 取值不在 30 档内或格式错误"
 */
const VIP_30_SIZES = new Set([
  // 1K Fast: 长边 1280, 21:9 短边 544
  '1280x1280', '848x1280', '1280x848', '960x1280', '1280x960',
  '1024x1280', '1280x1024', '720x1280', '1280x720', '1280x544',
  // 2K Recommended: 长边 2048, 21:9 短边 864
  '2048x2048', '1360x2048', '2048x1360', '1536x2048', '2048x1536',
  '1632x2048', '2048x1632', '1152x2048', '2048x1152', '2048x864',
  // 4K Detail: 长边 3840 (除 1:1=2880, 2:3/3:2 长边 3520), 21:9 短边 1632
  '2880x2880', '2336x3520', '3520x2336', '2480x3312', '3312x2480',
  '2560x3216', '3216x2560', '2160x3840', '3840x2160', '3840x1632',
])

const RATIOS_10 = [
  '1:1', '2:3', '3:2', '3:4', '4:3',
  '4:5', '5:4', '9:16', '16:9', '21:9',
]
const TIERS = ['1K', '2K', '4K']

describe('ApiService.gpt-image-2-vip size resolution', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('registers gpt-image-2-vip in DEFAULT_MODELS with 11 ratios (auto + 10)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')
    expect(cfg).toBeDefined()
    expect(cfg?.name).toBe('GPT Image 2 VIP')
    expect(cfg?.sizeStrategy).toBe('gpt-image-2-vip')
    expect(cfg?.ratios).toHaveLength(11)
    expect(cfg?.resolutions?.map((r) => r.key)).toEqual(['1K', '2K', '4K'])
    expect(cfg?.defaultResolution).toBe('2K')
  })

  /**
   * 关键回归测试: 所有 30 个 (ratio × tier) 组合必须落在文档 OpenAPI enum 内。
   * 之前的 resolutionMap 是从 Gemini Pro 复制过来的 (1024/2048/4096 体系),
   * 但 vip 的体系是 1280/2048/3840, 29/30 cell 都被 API 拒绝。
   */
  it.each(RATIOS_10.flatMap(ratio => TIERS.map(tier => [ratio, tier] as const)))(
    'resolves %s @ %s to a size in the docs 30-enum',
    async (ratio, tier) => {
      const { ApiService } = await import('../ApiService')
      const service = new ApiService()
      const cfg = service.getModelConfig('gpt-image-2-vip')!
      const resolve = (service as any).resolveGptImage2VipSize.bind(service)
      const size = resolve(cfg, ratio, tier)
      expect(size, `${ratio}@${tier} 没解析出 size`).toBeDefined()
      expect(
        VIP_30_SIZES.has(size),
        `${ratio}@${tier} 解析为 ${size}, 不在文档 30 档枚举内 → API 会回 400`,
      ).toBe(true)
    },
  )

  // 几个高频 cell 的精确锚定 (防止"在枚举内"但选错档位)
  it('resolves 1:1 @ 1K to 1280x1280 (vip 1K 是 1280, 不是 Gemini 的 1024)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '1:1', '1K')).toBe('1280x1280')
  })

  it('resolves 1:1 @ 4K to 2880x2880 (vip 1:1 4K 是 2880, 不是 4096)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '1:1', '4K')).toBe('2880x2880')
  })

  it('resolves 16:9 @ 2K to 2048x1152 (ASCII x, 文档原值)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '16:9', '2K')).toBe('2048x1152')
  })

  it('resolves 16:9 @ 4K to 3840x2160 (vip 4K 长边是 3840, 不是 Gemini 的 5504)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '16:9', '4K')).toBe('3840x2160')
  })

  it('resolves 21:9 @ 4K to 3840x1632 (cinema cap)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '21:9', '4K')).toBe('3840x1632')
  })

  it('returns undefined for ratio="auto" (no size sent, backend decides)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, 'auto', '2K')).toBeUndefined()
    expect(resolve(cfg, undefined, '2K')).toBeUndefined()
  })

  it('falls back to defaultResolution (2K) when resolution is omitted', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '1:1')).toBe('2048x2048')
  })

  it('returns undefined for unknown ratio key', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '7:2', '1K')).toBeUndefined()
  })
})

describe('ApiService.gpt-image-2-vip JSON payload (text-to-image)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  /**
   * 反向断言: vip 必须不发 response_format='url'。
   * 文档虽支持 "url", 但实测 apiyi 返回的 CDN URL 在国内访问不了 (用户已验证)。
   * 留空让上游走默认 b64_json, 才能保证图片回得来。
   * 单张几 MB base64 的主线程开销留待渲染端 (Blob URL / Worker decode) 解决,
   * 不在 API 参数上做手脚。
   */
  it('does NOT set response_format="url" (apiyi url 在国内访问不了)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2-vip', 'a cat', '1280x720', 'high')
    expect((payload as any).response_format).not.toBe('url')
  })

  // 2026-06-05 实测翻转: 探针 quality='high'→200, quality='zzz_invalid'→400 "不合法的quality",
  // 证明 vip 校验且真实支持 quality。旧断言"vip 不支持 quality"作废。
  it('includes size AND quality (vip 实测支持 quality)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2-vip', 'a cat', '1280x720', 'high')
    expect(payload).toMatchObject({
      model: 'gpt-image-2-vip',
      prompt: 'a cat',
      size: '1280x720',
      quality: 'high',
    })
  })

  it('omits quality when not provided (vip)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2-vip', 'a cat', '1280x720')
    expect((payload as any).quality).toBeUndefined()
  })

  it('omits size when value is "auto" (and still does not force url)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2-vip', 'a cat', 'auto')
    expect((payload as any).size).toBeUndefined()
    expect((payload as any).response_format).not.toBe('url')
  })

  it('retries a transient HTTP 500 once for gpt-image-2-vip JSON generation', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    ;(service as any).apiKey = 'sk-test'
    ;(service as any).currentSite = 'apiyi'

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'temporary upstream failure' } }),
        { status: 500, statusText: 'Internal Server Error', headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ data: [{ b64_json: 'AAA' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.generateImage({
      prompt: 'a cat',
      model: 'gpt-image-2-vip',
      ratio: '1:1',
      resolution: '2K',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.success).toBe(true)
  })
})

describe('ApiService.gpt-image-2-vip FormData (image-edit)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  /**
   * 反向断言: vip 编辑请求也不发 response_format=url。
   * 同样原因 —— 国内取不到 apiyi 返回的 URL, 留默认 b64_json。
   */
  it('does NOT append response_format=url to FormData (apiyi url 国内不可达)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()

    // 直接 patch convertToBlob, 避开 jsdom 下 Response.blob() 返回值不被 FormData 认可的怪坑
    const pngBlob = new Blob(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      { type: 'image/png' },
    )
    ;(service as any).convertToBlob = async () => pngBlob

    const apiCalls: { url: string; body: FormData }[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (init?.body instanceof FormData) {
        apiCalls.push({ url, body: init.body })
      }
      return new Response(
        JSON.stringify({ data: [{ url: 'https://r2cdn.example.com/x.png' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    ;(service as any).apiKey = 'sk-test'
    const site = {
      name: 'test',
      baseURL: 'https://api.apiyi.com',
      authType: 'bearer' as const,
    }
    const makeForm = (service as any).makeGptImage2FormDataRequest.bind(service)
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='

    await makeForm(
      'https://api.apiyi.com/v1/images/edits',
      'gpt-image-2-vip',
      'change background',
      [tinyPng],
      site,
      undefined,
      900_000,
      '2048x2048',
      'high',
    )

    expect(apiCalls).toHaveLength(1)
    const form = apiCalls[0].body
    expect(form.get('response_format')).not.toBe('url')
    expect(form.get('model')).toBe('gpt-image-2-vip')
    expect(form.get('prompt')).toBe('change background')
    expect(form.get('size')).toBe('2048x2048')
    // 2026-06-05: vip 编辑请求也要带 quality(实测支持)
    expect(form.get('quality')).toBe('high')
  })
})
