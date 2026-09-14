import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BILLING_MARKER_HEADER, BILLING_MARKER_VALUE } from '../../../../../types/authApi'

/**
 * GPT Image 2.5 (flare / sunburst / all) 回归。
 *
 * flare / sunburst 与 gpt-image-2 同端点、同 30 档 size,quality 多 xhigh/max,
 * 默认 high。all 是网页逆向按张计费,尺寸写进 prompt,回 b64_json。
 * 不接 gpt-image-2.5-vip。
 */

const OFFICIAL_30_SIZES = new Set([
  '1280x1280', '848x1280', '1280x848', '960x1280', '1280x960',
  '1024x1280', '1280x1024', '720x1280', '1280x720', '1280x544',
  '2048x2048', '1360x2048', '2048x1360', '1536x2048', '2048x1536',
  '1632x2048', '2048x1632', '1152x2048', '2048x1152', '2048x864',
  '2880x2880', '2336x3520', '3520x2336', '2480x3312', '3312x2480',
  '2560x3216', '3216x2560', '2160x3840', '3840x2160', '3840x1632',
])

describe('ApiService.gpt-image-2.5 config', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const)(
    '%s is official Images API with 30-size map and 2.5 quality ladder',
    async (id) => {
      const { ApiService } = await import('../ApiService')
      const service = new ApiService()
      const cfg = service.getModelConfig(id)
      expect(cfg).toBeDefined()
      expect(cfg?.sizeStrategy).toBe('gpt-image-2')
      expect(cfg?.baseURL).toContain('/v1/images/generations')
      expect(cfg?.editURL).toContain('/v1/images/edits')
      // 五档、无 auto:apiyi 生图页对 2.5 就是 low…max 五档,auto 在 2.5 上费用漂移
      expect(cfg?.qualities?.map((q) => q.key)).toEqual([
        'low', 'medium', 'high', 'xhigh', 'max',
      ])
      expect(cfg?.defaultQuality).toBe('high')
      expect(cfg?.defaultResolution).toBe('2K')
      expect(cfg?.capabilities?.qualityControl).toBe(true)
      expect(cfg?.capabilities?.resolutionControl).toBe(true)
      expect(cfg?.capabilities?.transparentBackgroundControl).toBe(true)
      expect(cfg?.vendor).toBe('openai')
      expect(cfg?.isNew).toBe(true)
    },
  )

  it('only flare / sunburst expose the transparent-background axis', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    for (const id of ['gpt-image-2.5-all', 'gpt-image-2', 'gpt-image-2-vip', 'custom-imagemodel-gt']) {
      expect(service.getModelConfig(id)?.capabilities?.transparentBackgroundControl).toBeFalsy()
    }
  })

  it('flare is the faster t2i sibling; sunburst is the slower edit sibling', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    expect(service.getModelConfig('gpt-image-2.5-flare')?.time).toBe('20s')
    expect(service.getModelConfig('gpt-image-2.5-sunburst')?.time).toBe('40s')
  })

  it('gpt-image-2.5-all is prompt-size / b64_json, no size or quality axes', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2.5-all')
    expect(cfg).toBeDefined()
    expect(cfg?.sizeStrategy).toBe('prompt')
    expect(cfg?.price).toBe(0.03)
    expect(cfg?.capabilities?.qualityControl).toBeFalsy()
    expect(cfg?.capabilities?.resolutionControl).toBeFalsy()
    expect(cfg?.qualities).toBeUndefined()
  })

  it('aliases the legacy gpt-image-2-all key onto 2.5-all', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const viaAlias = service.getModelConfig('gpt-image-2-all')
    const viaNew = service.getModelConfig('gpt-image-2.5-all')
    expect(viaAlias).toBe(viaNew)
    expect(Object.keys(service.getAllModels())).not.toContain('gpt-image-2-all')
  })

  it('does not register the unstable gpt-image-2.5-vip channel', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    expect(Object.keys(service.getAllModels())).not.toContain('gpt-image-2.5-vip')
    expect(service.getModelConfig('gpt-image-2.5-vip')).toBeUndefined()
  })

  it('resolves 1:1 @ 2K to 2048x2048 for both official 2.5 models', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const resolve = (service as any).resolveImageSizeFromMap.bind(service)
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
      const cfg = service.getModelConfig(id)!
      const size = resolve(cfg, '1:1', '2K')
      expect(size).toBe('2048x2048')
      expect(OFFICIAL_30_SIZES.has(size)).toBe(true)
    }
  })
})

describe('ApiService.gpt-image-2.5 quality 解析', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('lets 2.5 official send xhigh/max; drops them on gpt-image-2', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const resolve = (service as any).resolveGptImage2Quality.bind(service)
    expect(resolve('xhigh', 'gpt-image-2.5-flare')).toBe('xhigh')
    expect(resolve('max', 'gpt-image-2.5-sunburst')).toBe('max')
    expect(resolve('high', 'gpt-image-2.5-flare')).toBe('high')
    expect(resolve('xhigh', 'gpt-image-2')).toBeUndefined()
    expect(resolve('max', 'gpt-image-2-vip')).toBeUndefined()
    expect(resolve('auto', 'gpt-image-2.5-flare')).toBeUndefined()
  })
})

describe('ApiService.gpt-image-2.5 JSON payload', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sends size + quality (including xhigh) for flare/sunburst', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2.5-flare', 'a cat', '2048x1152', 'xhigh')
    expect(payload).toMatchObject({
      model: 'gpt-image-2.5-flare',
      prompt: 'a cat',
      size: '2048x1152',
      quality: 'xhigh',
      output_format: 'png',
    })
  })

  it('omits size/quality for 2.5-all and asks for b64_json', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2.5-all', 'a cat', '2048x1152', 'high') as Record<string, unknown>
    expect(payload.model).toBe('gpt-image-2.5-all')
    expect(payload.prompt).toBe('a cat')
    expect(payload.response_format).toBe('b64_json')
    expect(payload.size).toBeUndefined()
    expect(payload.quality).toBeUndefined()
  })

  it('adds background=transparent to the JSON body only when asked', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const on = build('gpt-image-2.5-flare', 'sticker', '2048x2048', 'high', 'transparent') as Record<string, unknown>
    expect(on.background).toBe('transparent')
    expect(on.output_format).toBe('png')
    const off = build('gpt-image-2.5-flare', 'sticker', '2048x2048', 'high') as Record<string, unknown>
    expect(off).not.toHaveProperty('background')
    // 2.5-all 是网页逆向,不吃 Images API 的 background 字段
    const all = build('gpt-image-2.5-all', 'sticker', undefined, undefined, 'transparent') as Record<string, unknown>
    expect(all).not.toHaveProperty('background')
  })
})

/**
 * 官转原生多图:apiyi 生图页给 gpt-image-2 / 2.5 开了 n=1–4(「数量(原生支持)」+ 倍数计费
 * 提示),我们照做。请求侧 `n` 只看 maxOutputs(>1 才发,单张请求体不变),-all / vip /
 * 腾讯 image2(maxOutputs 1)永远不带 n —— 网页逆向线路根本没这个参数。
 */
describe('ApiService.gpt-image-2.5 原生多图 n', () => {
  const OFFICIAL = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'] as const

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('the three official channels expose a 1-4 native count axis; -all / vip stay single', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    for (const id of OFFICIAL) {
      const caps = service.getModelConfig(id)?.capabilities
      expect(caps?.multipleImages, id).toBe(true)
      expect(caps?.nativeBatch, id).toBe(true)
      expect(caps?.maxOutputs, id).toBe(4)
    }
    for (const id of ['gpt-image-2.5-all', 'gpt-image-2-vip', 'custom-imagemodel-gt']) {
      const caps = service.getModelConfig(id)?.capabilities
      expect(caps?.nativeBatch, id).toBeFalsy()
      expect(caps?.maxOutputs ?? 1, id).toBe(1)
    }
  })

  it('clamps count to [1, maxOutputs] and falls back to 1 on junk', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const resolve = (service as any).resolveImagesApiCount.bind(service)
    const flare = service.getModelConfig('gpt-image-2.5-flare')
    expect(resolve(3, flare)).toBe(3)
    expect(resolve(9, flare)).toBe(4)
    expect(resolve(0, flare)).toBe(1)
    expect(resolve(undefined, flare)).toBe(1)
    expect(resolve(Number.NaN, flare)).toBe(1)
    expect(resolve(2.7, flare)).toBe(2)
    // maxOutputs 1 的渠道:怎么要都只给 1
    expect(resolve(4, service.getModelConfig('gpt-image-2.5-all'))).toBe(1)
    expect(resolve(4, service.getModelConfig('gpt-image-2-vip'))).toBe(1)
    expect(resolve(4, undefined)).toBe(1)
  })

  it('JSON payload carries n only when >1 (single-image body stays byte-identical)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const three = build('gpt-image-2.5-flare', 'a cat', '2048x2048', 'high', undefined, 3) as Record<string, unknown>
    expect(three.n).toBe(3)
    const one = build('gpt-image-2.5-flare', 'a cat', '2048x2048', 'high', undefined, 1) as Record<string, unknown>
    expect(one).not.toHaveProperty('n')
    const legacy = build('gpt-image-2.5-flare', 'a cat', '2048x2048', 'high') as Record<string, unknown>
    expect(legacy).not.toHaveProperty('n')
  })

  it.each(OFFICIAL)('a real generateImage(count=3) on %s ships n=3; count=1 ships no n', async (id) => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        // 三张内容各不相同 —— extractImagesFromApiResponse 会按内容去重,
        // 三张同 base64 只会剩一张,那测的就不是 n 而是去重。
        return new Response(
          JSON.stringify({ data: [{ b64_json: 'QQ==' }, { b64_json: 'Qg==' }, { b64_json: 'Qw==' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'apiyi')
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()

    const result = await svc.generateImage({ prompt: 'cat', model: id, siteKey: 'apiyi', count: 3 })
    expect(bodies[0]?.n).toBe(3)
    // 三张全部回到调用方,不是只取第一张
    expect(result.success).toBe(true)
    expect(result.images).toHaveLength(3)

    await svc.generateImage({ prompt: 'cat', model: id, siteKey: 'apiyi', count: 1 })
    expect(bodies[1]).toBeDefined()
    expect(bodies[1]).not.toHaveProperty('n')
  })

  it('count above the ceiling (MCP count=9) is clamped to n=4, never rejected', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: [{ b64_json: 'QQ==' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'apiyi')
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()
    await svc.generateImage({ prompt: 'cat', model: 'gpt-image-2.5-sunburst', siteKey: 'apiyi', count: 9 })
    expect(bodies[0]?.n).toBe(4)
  })

  it('2.5-all (网页逆向) never sends n even when count>1', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: [{ b64_json: 'QQ==' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'apiyi')
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()
    await svc.generateImage({ prompt: 'cat', model: 'gpt-image-2.5-all', siteKey: 'apiyi', count: 3 })
    expect(bodies[0]).toBeDefined()
    expect(bodies[0]).not.toHaveProperty('n')
  })

  it('edits (multipart) carry n too — 改图一次出 n 个变体', async () => {
    let form: FormData | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        // convertToBlob 也会经这个 fetch 取 data: URL(无 init),只记 multipart 那一发。
        if (init?.body instanceof FormData) form = init.body
        return new Response(JSON.stringify({ data: [{ b64_json: 'QQ==' }, { b64_json: 'Qg==' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'apiyi')
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()
    // 直接 patch convertToBlob —— jsdom 下 Response.blob() 的返回值不被 FormData 认可
    // (同 ApiService.gptImage2Vip.test.ts 的处理),这里测的是 n,不是 blob 转换。
    const pngBlob = new Blob(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      { type: 'image/png' },
    )
    ;(svc as any).convertToBlob = async () => pngBlob
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    await svc.generateImage({
      prompt: 'make it blue',
      model: 'gpt-image-2.5-sunburst',
      siteKey: 'apiyi',
      count: 2,
      referenceImages: [png],
    })
    expect(form).toBeInstanceOf(FormData)
    expect(form?.get('n')).toBe('2')

    form = undefined
    await svc.generateImage({
      prompt: 'make it blue',
      model: 'gpt-image-2.5-sunburst',
      siteKey: 'apiyi',
      count: 1,
      referenceImages: [png],
    })
    expect(form).toBeInstanceOf(FormData)
    expect(form?.get('n')).toBeNull()
  })
})

/**
 * 局部重绘(inpainting)—— `/v1/images/edits` 的 `mask` 字段(P3c,灯箱「擦除」)。
 * 语义按 OpenAI SDK / apiyi mask-editing 文档:PNG 必须带 alpha,alpha=0 的区域 = 可重绘,
 * 尺寸必须与 image[0] 完全一致,只作用于第一张参考图。网页逆向(-all)与腾讯 JSON 契约
 * 没有这个字段 —— 明确报错而不是静默丢掉遮罩后把整张图重画。
 */
describe('ApiService.gpt-image mask (inpainting)', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

  function stubMultipartFetch(): { form: () => FormData | undefined } {
    let form: FormData | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body instanceof FormData) form = init.body
        return new Response(JSON.stringify({ data: [{ b64_json: 'QQ==' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    return { form: () => form }
  }

  async function makeService() {
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'apiyi')
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()
    ;(svc as any).convertToBlob = async () =>
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    return svc
  }

  beforeEach(() => {
    vi.resetModules()
  })

  it('appends the mask as a PNG multipart field next to image[] on official channels', async () => {
    const captured = stubMultipartFetch()
    const svc = await makeService()
    const res = await svc.generateImage({
      prompt: 'remove the cup, keep everything else',
      model: 'gpt-image-2.5-sunburst',
      siteKey: 'apiyi',
      referenceImages: [PNG],
      maskImage: PNG,
    })
    expect(res.success).toBe(true)
    const form = captured.form()
    expect(form).toBeInstanceOf(FormData)
    const mask = form?.get('mask')
    expect(mask).toBeInstanceOf(Blob)
    expect((mask as File).name).toBe('mask.png')
    expect(form?.getAll('image[]')).toHaveLength(1)
  })

  it('rejects a mask without a reference image — there is nothing to inpaint', async () => {
    stubMultipartFetch()
    const svc = await makeService()
    const res = await svc.generateImage({
      prompt: 'x',
      model: 'gpt-image-2.5-flare',
      siteKey: 'apiyi',
      maskImage: PNG,
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/参考图|原图/)
  })

  it('rejects a mask on channels whose edit contract has no mask field (网页逆向 -all)', async () => {
    stubMultipartFetch()
    const svc = await makeService()
    const res = await svc.generateImage({
      prompt: 'x',
      model: 'gpt-image-2.5-all',
      siteKey: 'apiyi',
      referenceImages: [PNG],
      maskImage: PNG,
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/mask|遮罩/)
  })

  it('does not send a mask field when none was given', async () => {
    const captured = stubMultipartFetch()
    const svc = await makeService()
    await svc.generateImage({ prompt: 'x', model: 'gpt-image-2', siteKey: 'apiyi', referenceImages: [PNG] })
    expect(captured.form()?.get('mask')).toBeNull()
  })
})

/**
 * 透明底的闸在 ApiService 而不是 UI:UI 上只对 flare / sunburst 显示开关,但 MCP
 * 工具 / 旧调用方可以带着 transparentBackground 指向任何模型,这里必须按能力位过滤,
 * 否则腾讯 / 万相 / nano 等渠道会收到一个它们不认识的 background 字段。
 */
describe('ApiService.gpt-image-2.5 transparentBackground gate', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('resolves to "transparent" only for models with transparentBackgroundControl', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const resolve = (service as any).resolveTransparentBackground.bind(service)
    const cfg = (id: string) => service.getModelConfig(id)
    expect(resolve(true, cfg('gpt-image-2.5-flare'))).toBe('transparent')
    expect(resolve(true, cfg('gpt-image-2.5-sunburst'))).toBe('transparent')
    expect(resolve(false, cfg('gpt-image-2.5-flare'))).toBeUndefined()
    expect(resolve(undefined, cfg('gpt-image-2.5-flare'))).toBeUndefined()
    expect(resolve(true, cfg('gpt-image-2.5-all'))).toBeUndefined()
    expect(resolve(true, cfg('gpt-image-2'))).toBeUndefined()
    expect(resolve(true, cfg('custom-imagemodel-gt'))).toBeUndefined()
    expect(resolve(true, undefined)).toBeUndefined()
  })

  it('a real generateImage call on flare ships background=transparent; gpt-image-2 does not', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: [{ b64_json: 'QQ==' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'apiyi')
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()

    await svc
      .generateImage({ prompt: 'logo', model: 'gpt-image-2.5-flare', siteKey: 'apiyi', transparentBackground: true })
      .catch(() => {})
    expect(bodies[0]?.background).toBe('transparent')

    await svc
      .generateImage({ prompt: 'logo', model: 'gpt-image-2', siteKey: 'apiyi', transparentBackground: true })
      .catch(() => {})
    expect(bodies[1]).toBeDefined()
    expect(bodies[1]).not.toHaveProperty('background')

    vi.unstubAllGlobals()
    localStorage.clear()
  })
})

/**
 * 2.5 不钉 Miau:当前站点是 Miau 时可走平台额度,当前站点是 apiyi 时走 Key。
 * 钉 requiredSiteKey 会把 apiyi Key 路径堵死,也和 gpt-image-2 家族不一致。
 */
describe('ApiService.gpt-image-2.5 平台额度 / Key', () => {
  const IDS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-all'] as const

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('does not pin flare / sunburst / all to Miau', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    for (const id of IDS) {
      expect(service.getModelConfig(id)?.requiredSiteKey).toBeUndefined()
    }
  })

  it('on Miau, 2.5 is platform-eligible; on apiyi it falls back to the site key', async () => {
    localStorage.setItem('current_site', 'antigravity')
    const { ApiService } = await import('../ApiService')
    const onMiau = new ApiService()
    for (const id of IDS) {
      expect(onMiau.getPlatformBillingEligibility(id).eligible).toBe(true)
    }

    localStorage.setItem('current_site', 'apiyi')
    const onApiyi = new ApiService()
    for (const id of IDS) {
      const verdict = onApiyi.getPlatformBillingEligibility(id)
      expect(verdict.eligible).toBe(false)
      expect(verdict.blocker).toBe('site-not-gateway')
    }
  })

  it('platform mode on Miau sends the billing marker; apiyi still sends the site key', async () => {
    const seen: Record<string, string>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push((init?.headers ?? {}) as Record<string, string>)
        return new Response(JSON.stringify({ data: [{ b64_json: 'QQ==' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )

    localStorage.setItem('api_key_antigravity', 'user-typed-key')
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'antigravity')
    const { useQuotaStore } = await import('../../../stores/useQuotaStore')
    useQuotaStore.setState({ billingSource: 'platform' })
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()

    await svc
      .generateImage({ prompt: 'x', model: 'gpt-image-2.5-flare', siteKey: 'antigravity' })
      .catch(() => {})
    expect(seen[0]?.[BILLING_MARKER_HEADER]).toBe(BILLING_MARKER_VALUE)
    expect(seen[0]?.Authorization).toBeUndefined()

    await svc
      .generateImage({ prompt: 'x', model: 'gpt-image-2.5-flare', siteKey: 'apiyi' })
      .catch(() => {})
    expect(seen[1]?.[BILLING_MARKER_HEADER]).toBeUndefined()
    expect(seen[1]?.Authorization).toBe('Bearer apiyi-key')
  })
})
