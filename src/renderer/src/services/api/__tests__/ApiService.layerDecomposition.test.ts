import { describe, it, expect } from 'vitest'
import { ApiService, extractLayersFromApiResponse } from '../ApiService'

/**
 * Seedream 5.0 Pro 图层拆分（Ark `layer_decomposition`）。
 *
 * 挂在与普通生图同一个 /v1/images/generations 端点上，靠开关区分：带开关回
 * 1 张底图 + 最多 16 张透明 PNG 图层，逐项带 z_index / bounding_box / name /
 * description。这里锁死的都是「错了不会报错、只会静默降级成一张普通图」的地方——
 * 上游对不认识的字段一律忽略，所以每一条都必须靠测试守住。
 */
describe('Seedream 5.0 Pro layer decomposition capability', () => {
  const service = new ApiService()

  it('is enabled on 5.0 Pro only', () => {
    expect(service.getModelConfig('doubao-seedream-5-0-pro-260628')?.capabilities?.layerDecomposition).toBe(true)
    // 同族的 4.5 / 其他出图模型都没有这个能力，别让开关漏到普通渠道上
    expect(service.getModelConfig('seedream-4-5-251128')?.capabilities?.layerDecomposition).toBeUndefined()
    expect(service.getModelConfig('gpt-image-2')?.capabilities?.layerDecomposition).toBeUndefined()
  })
})

describe('Seedream 5.0 Pro layer decomposition payload', () => {
  const service = new ApiService()
  const cfg = service.getModelConfig('doubao-seedream-5-0-pro-260628')!
  const REF = 'https://cos.example.com/image-history/scene.png'

  function build(options: Record<string, unknown>) {
    return (service as any).buildOpenAIPayload({
      model: 'doubao-seedream-5-0-pro-260628',
      modelConfig: cfg,
      count: 1,
      layerDecomposition: true,
      referenceImages: [REF],
      prompt: '',
      ...options,
    })
  }

  it('sends the layer_decomposition switch with a single top-level image', () => {
    const payload = build({ resolution: '2K' })
    expect(payload.layer_decomposition).toBe(true)
    expect(payload.image).toBe(REF)
    // 拆分只吃单张输入图；发 images[] 上游会当普通多参考图生图处理
    expect(payload.images).toBeUndefined()
  })

  it('sends size as a tier, never as `宽x高` pixels', () => {
    // 发像素串会把拆出来的底图强行改成 UI 选的比例，与图层 bounding_box 坐标系错位
    expect(build({ resolution: '2K' }).size).toBe('2K')
    expect(build({ resolution: '1.5K' }).size).toBe('1.5K')
    expect(build({ resolution: '1K' }).size).toBe('1K')
    // 普通生图会把 ratio+resolution 映射成像素；拆分模式下 ratio 必须完全不起作用
    expect(build({ resolution: '2K', ratio: '16:9' }).size).toBe('2K')
  })

  it('falls back to the auto tier for pixel strings and unknown resolutions', () => {
    // UI 的分辨率值可能已经是像素串（普通生图路径留下的），不能原样发出去
    expect(build({ resolution: '2560x1440' }).size).toBe('auto')
    expect(build({ resolution: '4K' }).size).toBe('auto')
    expect(build({ resolution: undefined }).size).toBe('auto')
  })

  it('omits `n` entirely — the layer count is decided upstream by image content', () => {
    const payload = build({ resolution: '2K', count: 4 })
    expect(payload.n).toBeUndefined()
  })

  it('omits an empty prompt instead of sending `prompt: ""` (empty means auto-split-everything)', () => {
    // 上游把空串当成一个有效但无意义的提示词，会污染自动拆分
    expect(build({ prompt: '' })).not.toHaveProperty('prompt')
    expect(build({ prompt: '   ' })).not.toHaveProperty('prompt')
  })

  it('keeps a non-empty prompt (trimmed) to steer which layers get split out', () => {
    expect(build({ prompt: '  只拆出前景人物  ' }).prompt).toBe('只拆出前景人物')
  })

  it('requests url output — 17 × 2K images as b64_json would spike renderer memory', () => {
    const payload = build({ resolution: '2K' })
    expect(payload.response_format).toBe('url')
    expect(payload.output_format).toBe('png')
  })

  it('prefers imageBase64 over referenceImages as the split source', () => {
    const dataUrl = 'data:image/png;base64,AAAA'
    const payload = build({ imageBase64: dataUrl })
    expect(payload.image).toBe(dataUrl)
  })

  it('builds a normal pixel-size payload when the switch is off (no regression)', () => {
    const payload = (service as any).buildOpenAIPayload({
      model: 'doubao-seedream-5-0-pro-260628',
      modelConfig: cfg,
      count: 1,
      prompt: '写实城市夜景',
      ratio: '16:9',
      resolution: '2K',
    })
    expect(payload.layer_decomposition).toBeUndefined()
    expect(payload.size).toBe('2560x1440')
    expect(payload.n).toBe(1)
  })
})

describe('generateImage layer decomposition guards', () => {
  function makeService() {
    const service = new ApiService() as any
    service.apiKey = 'test-key'
    // 5.0 Pro 声明了 requiredSiteKey，请求被钉到 Miau 站点并读**该站点**的 Key。
    // 不给的话先撞上「未配置 API Key」，测不到下面的拆分守卫。
    localStorage.setItem('api_key_antigravity', 'test-key')
    return service
  }

  it('rejects models without the capability instead of silently generating a normal image', async () => {
    // 上游把 layer_decomposition 当未知字段丢掉，照常出一张普通图 —— 用户只会疑惑
    // 「拆分怎么没生效」，还照付一张图的钱。必须在发请求前拦住。
    const result = await makeService().generateImage({
      prompt: 'a',
      model: 'gpt-image-2',
      referenceImages: ['https://cos.example.com/a.png'],
      layerDecomposition: true,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('不支持图层拆分')
  })

  it('rejects a split request with no input image (it would degrade to text-to-image)', async () => {
    const result = await makeService().generateImage({
      prompt: 'a',
      model: 'doubao-seedream-5-0-pro-260628',
      layerDecomposition: true,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('需要一张待拆分的输入图')
  })
})

describe('requiredSiteKey — 只经 Miau 提供的渠道钉住站点', () => {
  it('5.0 Pro 声明了 Miau 站点(否则 buildRequestUrl 会把 host 换成当前站点的)', () => {
    const service = new ApiService()
    const cfg = service.getModelConfig('doubao-seedream-5-0-pro-260628')!
    expect(cfg.requiredSiteKey).toBe('antigravity')
    expect(cfg.baseURL).toContain('miauapi.13797248455.xyz')
  })

  it('其余 miau-only 渠道一并声明(腾讯 / 万相 / 千问)', () => {
    const service = new ApiService()
    for (const key of ['custom-imagemodel-gt', 'wan2.7-image-pro', 'qwen-image-3.0-pro']) {
      expect(service.getModelConfig(key)?.requiredSiteKey, key).toBe('antigravity')
    }
  })

  it('普通中转渠道不声明 —— 它们要跟着用户选的站点走', () => {
    const service = new ApiService()
    for (const key of ['gpt-image-2', 'gpt-image-2-vip', 'seedream-4-5-251128']) {
      expect(service.getModelConfig(key)?.requiredSiteKey, key).toBeUndefined()
    }
  })

  it('未配置 Miau Key 时报出「哪个站点缺 Key」，而不是打到别的站点拿 404', () => {
    localStorage.removeItem('api_key_antigravity')
    const service = new ApiService() as any
    service.apiKey = 'key-for-some-other-site'

    return service
      .generateImage({ prompt: 'a cat', model: 'doubao-seedream-5-0-pro-260628' })
      .then((result: any) => {
        expect(result.success).toBe(false)
        expect(result.error).toContain('Miau API')
        expect(result.error).toContain('API Key')
      })
  })

  it('调用方显式传的 siteKey 优先级高于模型声明(codex 出图保留覆盖能力)', () => {
    localStorage.removeItem('api_key_antigravity')
    localStorage.setItem('api_key_yunwu', 'explicit-key')
    const service = new ApiService() as any

    // 显式 siteKey 存在 → 用它，读的是 yunwu 的 Key（不是 Miau 的），所以不会撞
    // 「未配置 Miau Key」。停在拆分守卫上就证明站点解析没把它钉回 Miau。
    return service
      .generateImage({
        prompt: 'a cat',
        model: 'doubao-seedream-5-0-pro-260628',
        siteKey: 'yunwu',
        layerDecomposition: true,
      })
      .then((result: any) => {
        expect(result.success).toBe(false)
        // 过了站点/Key 解析，停在拆分的输入图守卫上 —— 说明没被钉回 Miau 而报缺 Key。
        expect(result.error).toContain('需要一张待拆分的输入图')
      })
  })
})

describe('extractLayersFromApiResponse', () => {
  it('keeps the z_index === 0 base layer (truthiness check would drop it)', () => {
    const layers = extractLayersFromApiResponse({
      data: [{ url: 'https://x/base.png', z_index: 0 }],
    })
    expect(layers).toHaveLength(1)
    expect(layers[0].zIndex).toBe(0)
  })

  it('sorts by zIndex ascending so the base image is always first', () => {
    const layers = extractLayersFromApiResponse({
      data: [
        { url: 'https://x/top.png', z_index: 2 },
        { url: 'https://x/base.png', z_index: 0 },
        { url: 'https://x/mid.png', z_index: 1 },
      ],
    })
    expect(layers.map((l) => l.url)).toEqual([
      'https://x/base.png',
      'https://x/mid.png',
      'https://x/top.png',
    ])
  })

  it('carries bounding_box in both coordinate systems without converting', () => {
    const [layer] = extractLayersFromApiResponse({
      data: [
        {
          url: 'https://x/a.png',
          z_index: 1,
          bounding_box: {
            absolute: [10, 20, 300, 400],
            normalized: [0.01, 0.02, 0.3, 0.4],
          },
        },
      ],
    })
    expect(layer.boundingBox).toEqual({
      absolute: [10, 20, 300, 400],
      normalized: [0.01, 0.02, 0.3, 0.4],
    })
  })

  it('drops non-numeric bounding_box entries rather than poisoning the coordinate array', () => {
    const [layer] = extractLayersFromApiResponse({
      data: [{ url: 'https://x/a.png', z_index: 1, bounding_box: { absolute: [null, 'x', NaN] } }],
    })
    expect(layer.boundingBox).toBeUndefined()
  })

  it('carries name and description when present', () => {
    const [layer] = extractLayersFromApiResponse({
      data: [{ url: 'https://x/a.png', z_index: 1, name: ' 前景人物 ', description: ' 站立的女性 ' }],
    })
    expect(layer.name).toBe('前景人物')
    expect(layer.description).toBe('站立的女性')
  })

  it('skips items without z_index (a degraded single-image response is not a layer stack)', () => {
    const layers = extractLayersFromApiResponse({
      data: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png', z_index: 0 }],
    })
    expect(layers.map((l) => l.url)).toEqual(['https://x/b.png'])
  })

  it('returns [] for ordinary generation responses so callers keep their existing behavior', () => {
    expect(extractLayersFromApiResponse({ data: [{ url: 'https://x/a.png' }] })).toEqual([])
    expect(extractLayersFromApiResponse({ data: [] })).toEqual([])
    expect(extractLayersFromApiResponse(null)).toEqual([])
    expect(extractLayersFromApiResponse({ notData: 1 })).toEqual([])
  })

  it('falls back to b64_json only when no url is present', () => {
    const [layer] = extractLayersFromApiResponse({
      data: [{ b64_json: 'QUJD', z_index: 0 }],
    })
    expect(layer.url.startsWith('data:image/')).toBe(true)
  })

  it('reads mime per item — output_format describes the base image, layers are always png', () => {
    const layers = extractLayersFromApiResponse({
      mime_type: 'image/jpeg',
      data: [
        { url: 'https://x/base.jpg', z_index: 0, output_format: 'jpeg' },
        { url: 'https://x/top.png', z_index: 1, output_format: 'png' },
      ],
    })
    expect(layers[0].mimeType).toBe('image/jpeg')
    expect(layers[1].mimeType).toBe('image/png')
  })
})

describe('parseResponse with layer decomposition', () => {
  const cfg = { capabilities: {} } as any

  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('reorders images by zIndex so images[0] is the base layer', async () => {
    const service = new ApiService() as any
    const result = await service.parseResponse(
      jsonResponse({
        data: [
          { url: 'https://x/top.png', z_index: 2, name: '前景' },
          { url: 'https://x/base.png', z_index: 0, name: '底图' },
        ],
      }),
      cfg,
      true,
    )
    expect(result.success).toBe(true)
    // extractImagesFromApiResponse 按 data[] 原序返回，叠放顺序只有 z_index 说得准
    expect(result.images).toEqual(['https://x/base.png', 'https://x/top.png'])
    expect(result.layers.map((l: any) => l.name)).toEqual(['底图', '前景'])
  })

  it('returns a plain success when upstream degrades to one image with no z_index', async () => {
    const service = new ApiService() as any
    const result = await service.parseResponse(
      jsonResponse({ data: [{ url: 'https://x/only.png' }] }),
      cfg,
      true,
    )
    // 图确实出来了，只是没有图层栈 —— 不该报错
    expect(result.success).toBe(true)
    expect(result.images).toEqual(['https://x/only.png'])
    expect(result.layers).toBeUndefined()
  })

  it('does not attach layers when the flag is off, even if z_index is present', async () => {
    const service = new ApiService() as any
    const result = await service.parseResponse(
      jsonResponse({ data: [{ url: 'https://x/a.png', z_index: 0 }] }),
      cfg,
    )
    expect(result.success).toBe(true)
    expect(result.layers).toBeUndefined()
  })
})
