import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 腾讯 image2(custom-imagemodel-gt) 编辑路径：参考图为 COS/远端 URL 时，
 * 走 JSON `images:[url]` 而不是 base64 multipart。
 */
describe('ApiService custom-imagemodel-gt edit → JSON images[url] (no base64)', () => {
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

  it('sends JSON body with image URLs (not FormData / not base64)', async () => {
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
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toBe(cfg.editURL)
    // 必须是 JSON，不是 FormData
    expect(capturedInit?.body).toBeTypeOf('string')
    const body = JSON.parse(capturedInit!.body as string)
    expect(body.model).toBe('custom-imagemodel-gt')
    expect(body.prompt).toBe('合并这几张图')
    expect(body.images).toEqual(urls)
    expect(body.n).toBe(1)
    expect(body.quality).toBe('high')
    expect(body.extra_body).toMatchObject({ logo_add: 0 })
    // 绝不内联 base64
    expect(capturedInit!.body as string).not.toContain('base64')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('only takes JSON path for all-http sources (guard: every isHttp)', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-imagemodel-gt')!
    // 守卫逻辑单测：混入 data: 源时不应判定为「全 URL」
    const allHttp = (srcs: string[]) =>
      srcs.every((s) => typeof s === 'string' && /^https?:\/\//i.test(s))
    expect(allHttp(['https://a/x.png', 'https://a/y.png'])).toBe(true)
    expect(allHttp(['https://a/x.png', 'data:image/png;base64,aaa'])).toBe(false)
    expect(cfg.editURL).toBeTruthy()
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

  it('FormData edit（data: 参考图回落路径）也带 extra_body.logo_add:0', async () => {
    const service = await makeService()
    const cfg = service.getModelConfig('custom-imagemodel-gt')!

    // convertToBlob 在测试环境下无法真正把 data: 解码成 jsdom Blob，直接桩成真 Blob，
    // 让 FormData 编辑路径得以走完（被测对象是 extra_body 字段，不是图片解码）。
    vi.spyOn(service as any, 'convertToBlob').mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )

    let capturedForm: FormData | undefined
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body instanceof FormData) capturedForm = init.body
      return new Response(JSON.stringify({ data: [{ url: 'https://x/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    // data: 参考图 → 触发 FormData 回落路径（非全 http URL）
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
    })

    expect(capturedForm, '未走到 FormData edit 路径').toBeDefined()
    expect(capturedForm!.get('extra_body')).toBe(JSON.stringify({ logo_add: 0 }))
  })
})
