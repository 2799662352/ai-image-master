import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * apiyi 官转 GPT Image 2.6(`gpt-image-2.6-flare` / `gpt-image-2.6-sunburst`)回归。
 *
 * 与 2.5 官转同端点、同 30 档 size、同清晰度梯子,请求分支完全共用;这里钉住的是
 * 2026-11-09 经 Miau 网关**实测过**的那部分:文生图、n=2 原生多图、透明底、改图 + mask 擦除。
 *
 * 没做的也要钉住,免得以后有人顺手"补全":complexity / markup 图层没有可验证的效果
 * (complexity 上游静默忽略;markup 经 apiyi 不生效),**默认请求**里不能出现它们。
 * GIF / SVG 与帧参数是显式开关,只在用户 / agent 要求时才发,见 `ApiService.gptImage26Output.test.ts`。
 */

const IDS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const

const OFFICIAL_30_SIZES = new Set([
  '1280x1280', '848x1280', '1280x848', '960x1280', '1280x960',
  '1024x1280', '1280x1024', '720x1280', '1280x720', '1280x544',
  '2048x2048', '1360x2048', '2048x1360', '1536x2048', '2048x1536',
  '1632x2048', '2048x1632', '1152x2048', '2048x1152', '2048x864',
  '2880x2880', '2336x3520', '3520x2336', '2480x3312', '3312x2480',
  '2560x3216', '3216x2560', '2160x3840', '3840x2160', '3840x1632',
])

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('ApiService.gpt-image-2.6 官转 config', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it.each(IDS)('%s is the official Images API with the 30-size map and the five-step ladder', async (id) => {
    const { ApiService } = await import('../ApiService')
    const cfg = new ApiService().getModelConfig(id)
    expect(cfg).toBeDefined()
    expect(cfg?.vendor).toBe('openai')
    expect(cfg?.isNew).toBe(true)
    expect(cfg?.sizeStrategy).toBe('gpt-image-2')
    expect(cfg?.baseURL).toBe('https://b.apiyi.com/v1/images/generations')
    expect(cfg?.editURL).toBe('https://b.apiyi.com/v1/images/edits')
    expect(cfg?.qualities?.map((q) => q.key)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(cfg?.defaultQuality).toBe('high')
    expect(cfg?.defaultResolution).toBe('2K')
    expect(cfg?.capabilities).toMatchObject({
      imageEdit: true,
      referenceImage: true,
      nativeBatch: true,
      maxOutputs: 4,
      qualityControl: true,
      resolutionControl: true,
      transparentBackgroundControl: true,
    })
  })

  // 档位说明里的美元数是按 2.5 的 token 量折的(low 约 200 / medium 439),2.6 同档位 token 不同
  // (实测 low 824 / medium 1449 / high 1758),照抄会让用户按 2.5 的价估 2.6 的账。
  it.each(IDS)('%s shows no 2.5 dollar prices in the quality ladder', async (id) => {
    const { ApiService } = await import('../ApiService')
    const cfg = new ApiService().getModelConfig(id)
    for (const q of cfg?.qualities ?? []) {
      expect(q.description ?? '', `${id}/${q.key}`).not.toMatch(/\$/)
    }
    // 2.5 官转自己仍带美元价,没被误伤。
    const flare25 = new ApiService().getModelConfig('gpt-image-2.5-flare')
    expect(flare25?.qualities?.some((q) => /\$/.test(q.description ?? ''))).toBe(true)
  })

  // 没测过的耗时不写进配置("不编数字")。
  it.each(IDS)('%s declares no made-up timing and is not pinned to Miau', async (id) => {
    const { ApiService } = await import('../ApiService')
    const cfg = new ApiService().getModelConfig(id)
    expect(cfg?.time).toBeUndefined()
    expect(cfg?.requiredSiteKey).toBeUndefined()
  })

  // GIF / SVG(2026-11-09 实测可用,new-api #197 上线后不开透传也转发)已开,见
  // `ApiService.gptImage26Output.test.ts`。complexity(上游静默忽略,效果测不出)与 markup
  // (经 apiyi 不生效)仍不声明 —— 没有可验证的效果就不给用户一个看起来能用的开关。
  it('still does not declare complexity / markup (no verifiable effect through apiyi)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    for (const id of IDS) {
      const cfg = service.getModelConfig(id)!
      expect(cfg.defaultParams).toEqual({ output_format: 'png' })
      expect(JSON.stringify(cfg)).not.toMatch(/complexity|markup/i)
    }
  })

  it('resolves 1:1 @ 2K to 2048x2048 and every ratio × tier to a legal official size', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const resolve = (service as any).resolveImageSizeFromMap.bind(service)
    for (const id of IDS) {
      const cfg = service.getModelConfig(id)!
      expect(resolve(cfg, '1:1', '2K')).toBe('2048x2048')
      for (const ratio of cfg.ratios ?? []) {
        if (ratio.key === 'auto') continue
        for (const tier of ['1K', '2K', '4K']) {
          expect(OFFICIAL_30_SIZES.has(resolve(cfg, ratio.key, tier)), `${id} ${ratio.key} ${tier}`).toBe(true)
        }
      }
    }
  })

  it('sits right before the 2.5 官转 pair in the model dropdown order', async () => {
    const { ApiService } = await import('../ApiService')
    const keys = Object.keys(new ApiService().getAllModels())
    const i = keys.indexOf('gpt-image-2.6-flare')
    expect(i).toBeGreaterThan(-1)
    expect(keys.slice(i, i + 4)).toEqual([
      'gpt-image-2.6-flare',
      'gpt-image-2.6-sunburst',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
    ])
  })

  it('shares the 2.5 quality gate: xhigh / max go through, auto is dropped', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const resolve = (service as any).resolveGptImage2Quality.bind(service)
    for (const id of IDS) {
      expect(resolve('xhigh', id)).toBe('xhigh')
      expect(resolve('max', id)).toBe('max')
      expect(resolve('high', id)).toBe('high')
      expect(resolve('auto', id)).toBeUndefined()
    }
  })
})

describe('ApiService.gpt-image-2.6 官转 requests', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  function stubJsonFetch(count = 1): { calls: Array<{ url: string; body: Record<string, unknown> }> } {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const items = [{ b64_json: 'QQ==' }, { b64_json: 'Qg==' }, { b64_json: 'Qw==' }, { b64_json: 'RA==' }].slice(0, count)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof init?.body === 'string') calls.push({ url: String(url), body: JSON.parse(init.body) })
        return new Response(JSON.stringify({ data: items }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    return { calls }
  }

  async function makeService() {
    localStorage.setItem('api_key_apiyi', 'apiyi-key')
    localStorage.setItem('current_site', 'apiyi')
    const { ApiService } = await import('../ApiService')
    return new ApiService()
  }

  it.each(IDS)('%s text-to-image posts to /v1/images/generations with size + quality and only the known fields', async (id) => {
    const { calls } = stubJsonFetch()
    const svc = await makeService()
    const res = await svc.generateImage({ prompt: 'a red apple', model: id, siteKey: 'apiyi', ratio: '1:1', resolution: '2K', quality: 'xhigh' })
    expect(res.success).toBe(true)
    // 域名由当前站点决定(apiyi 站点 / Miau 网关),模型配置里的 b.apiyi.com 只是默认值;这里只钉路径。
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/images/generations')
    expect(calls[0]?.body).toMatchObject({
      model: id,
      prompt: 'a red apple',
      size: '2048x2048',
      quality: 'xhigh',
      output_format: 'png',
    })
    // 网关会丢掉的 2.6 新参数一个都不能出现在请求体里。
    for (const key of ['complexity', 'svg', 'frame_count', 'frame_duration_ms', 'markup']) {
      expect(calls[0]?.body, key).not.toHaveProperty(key)
    }
  })

  it.each(IDS)('%s ships background=transparent only when asked', async (id) => {
    const { calls } = stubJsonFetch()
    const svc = await makeService()
    await svc.generateImage({ prompt: 'logo', model: id, siteKey: 'apiyi', transparentBackground: true })
    await svc.generateImage({ prompt: 'logo', model: id, siteKey: 'apiyi' })
    expect(calls[0]?.body.background).toBe('transparent')
    expect(calls[1]?.body).not.toHaveProperty('background')
  })

  it.each(IDS)('%s count=2 ships native n=2 and returns both images; count above 4 is clamped', async (id) => {
    const { calls } = stubJsonFetch(2)
    const svc = await makeService()
    const res = await svc.generateImage({ prompt: 'cat', model: id, siteKey: 'apiyi', count: 2 })
    expect(calls[0]?.body.n).toBe(2)
    expect(res.images).toHaveLength(2)
    await svc.generateImage({ prompt: 'cat', model: id, siteKey: 'apiyi', count: 9 })
    expect(calls[1]?.body.n).toBe(4)
  })

  it.each(IDS)('%s edit with a mask sends multipart image[] + mask.png to /v1/images/edits', async (id) => {
    // 同 2.5:multipart 路径不发 output_format(上游默认 png);mask 只作用于 image[0]。
    let form: FormData | undefined
    let url = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        if (init?.body instanceof FormData) {
          form = init.body
          url = String(u)
        }
        return new Response(JSON.stringify({ data: [{ b64_json: 'QQ==' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    const svc = await makeService()
    ;(svc as any).convertToBlob = async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    const res = await svc.generateImage({
      prompt: 'remove the star, keep everything else',
      model: id,
      siteKey: 'apiyi',
      referenceImages: [PNG],
      maskImage: PNG,
    })
    expect(res.success).toBe(true)
    expect(new URL(url).pathname).toBe('/v1/images/edits')
    expect(form?.getAll('image[]')).toHaveLength(1)
    const mask = form?.get('mask')
    expect(mask).toBeInstanceOf(Blob)
    expect((mask as File).name).toBe('mask.png')
    expect(form?.get('model')).toBe(id)
    // multipart 同样不带网关会丢掉的 2.6 新字段
    for (const key of ['complexity', 'svg', 'frame_count', 'frame_duration_ms', 'markup']) {
      expect(form?.get(key), key).toBeNull()
    }
  })

  it.each(IDS)('%s rejects a mask without a reference image', async (id) => {
    stubJsonFetch()
    const svc = await makeService()
    const res = await svc.generateImage({ prompt: 'x', model: id, siteKey: 'apiyi', maskImage: PNG })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/参考图|原图/)
  })

  it('on Miau 2.6 官转 is platform-eligible; on apiyi it falls back to the site key', async () => {
    const { ApiService } = await import('../ApiService')
    localStorage.setItem('current_site', 'antigravity')
    const onMiau = new ApiService()
    for (const id of IDS) expect(onMiau.getPlatformBillingEligibility(id).eligible, id).toBe(true)

    localStorage.setItem('current_site', 'apiyi')
    const onApiyi = new ApiService()
    for (const id of IDS) {
      const verdict = onApiyi.getPlatformBillingEligibility(id)
      expect(verdict.eligible, id).toBe(false)
      expect(verdict.blocker, id).toBe('site-not-gateway')
    }
  })
})
