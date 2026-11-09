import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * apiyi 官转 GPT Image 2.6 的 GIF / SVG 输出(2026-11-09 实测 + new-api #197 上线后重测)。
 *
 * - GIF `frame_count: 2, frame_duration_ms: 100` 经 Miau 网关 → 真 2 帧 / 100 ms;
 * - SVG `svg: { model: 'gpt-4.1-mini' }` → 合法矢量。
 *
 * 钉住三件事:
 * 1. 请求体形状(嵌套的 `svg.model`、GIF 帧参数、不带 `background`、不带 `n`);
 * 2. **出网前拒绝**一切会被上游悄悄降级 / 多扣费的组合(数量 > 1、参考图、遮罩、透明底、
 *    帧参数与格式不符),以及别的模型上要 GIF / SVG(否则拿到普通 PNG 却没人告诉你);
 * 3. 不自动重试(上游可能已开跑,重试 = 多扣一次),且返回的 base64 按真实内容标 MIME。
 */

const FLARE = 'gpt-image-2.6-flare'
const SUN = 'gpt-image-2.6-sunburst'

const GIF_B64 = 'R0lGODlhAQABAAAAACw='
const SVG_B64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const REF = `data:image/png;base64,${PNG_B64}`

type Call = { url: string; body: Record<string, unknown> }

function stubFetch(responder?: () => Response): { calls: Call[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') calls.push({ url: String(url), body: JSON.parse(init.body) })
    return (
      responder?.() ??
      new Response(JSON.stringify({ data: [{ b64_json: GIF_B64 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

async function makeService() {
  localStorage.setItem('api_key_apiyi', 'apiyi-key')
  localStorage.setItem('current_site', 'apiyi')
  const { ApiService } = await import('../ApiService')
  return new ApiService()
}

describe('ApiService GPT Image 2.6:GIF / SVG 声明', () => {
  beforeEach(() => vi.resetModules())

  it.each([FLARE, SUN])('%s 声明 output_format / frame_count / frame_duration_ms / svg_model 四项,仍不声明 complexity / markup', async (id) => {
    const { ApiService } = await import('../ApiService')
    const cfg = new ApiService().getModelConfig(id)!
    expect(cfg.capabilities?.modelParams?.map((s) => s.key)).toEqual([
      'output_format',
      'frame_count',
      'frame_duration_ms',
      'svg_model',
    ])
    // complexity 上游静默忽略、markup 经 apiyi 不生效:没有可验证的效果就不开。
    expect(JSON.stringify(cfg)).not.toMatch(/complexity|markup/i)
    // 默认仍是普通 PNG。
    expect(cfg.defaultParams).toEqual({ output_format: 'png' })
  })

  it('腾讯 2.6 / 2.5 官转 / gpt-image-2 不声明这些参数(各自的合同没验证)', async () => {
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()
    for (const id of ['custom-model-og-v2.6-f', 'custom-model-og-v2.6-s', 'gpt-image-2.5-flare', 'gpt-image-2']) {
      expect(svc.getModelConfig(id)?.capabilities?.modelParams, id).toBeUndefined()
    }
  })
})

describe('ApiService GPT Image 2.6:GIF / SVG 请求体', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it.each([FLARE, SUN])('%s GIF:output_format + 帧参数外发,没有 n / background,走 /v1/images/generations', async (id) => {
    const { calls } = stubFetch()
    const svc = await makeService()
    const res = await svc.generateImage({
      prompt: 'a bouncing ball',
      model: id,
      siteKey: 'apiyi',
      ratio: '1:1',
      resolution: '1K',
      quality: 'low',
      modelParams: { output_format: 'gif', frame_count: 2, frame_duration_ms: 100 },
    })
    expect(res.success).toBe(true)
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/images/generations')
    expect(calls[0]!.body).toMatchObject({
      model: id,
      prompt: 'a bouncing ball',
      size: '1280x1280',
      quality: 'low',
      output_format: 'gif',
      frame_count: 2,
      frame_duration_ms: 100,
    })
    for (const key of ['n', 'background', 'svg', 'complexity', 'markup']) {
      expect(calls[0]!.body, key).not.toHaveProperty(key)
    }
  })

  it('GIF 只给 output_format 时,帧参数不出现(上游默认 9 帧 / 200 ms)', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', modelParams: { output_format: 'gif' } })
    expect(calls[0]!.body.output_format).toBe('gif')
    expect(calls[0]!.body).not.toHaveProperty('frame_count')
    expect(calls[0]!.body).not.toHaveProperty('frame_duration_ms')
  })

  it.each([FLARE, SUN])('%s SVG:嵌套 svg.model,默认 gpt-4.1-mini,没有帧参数 / n / background', async (id) => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({ prompt: 'a logo', model: id, siteKey: 'apiyi', modelParams: { output_format: 'svg' } })
    expect(calls[0]!.body.output_format).toBe('svg')
    expect(calls[0]!.body.svg).toEqual({ model: 'gpt-4.1-mini' })
    for (const key of ['n', 'background', 'frame_count', 'frame_duration_ms', 'complexity']) {
      expect(calls[0]!.body, key).not.toHaveProperty(key)
    }
  })

  it('SVG 选了别的写手模型就用它', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({
      prompt: 'p',
      model: FLARE,
      siteKey: 'apiyi',
      modelParams: { output_format: 'svg', svg_model: 'gpt-6-luna' },
    })
    expect(calls[0]!.body.svg).toEqual({ model: 'gpt-6-luna' })
  })

  it('不设 modelParams / 设 png = 与改动前完全一样的 PNG 请求(不带任何新字段)', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi' })
    await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', modelParams: { output_format: 'png' } })
    for (const c of calls) {
      expect(c.body.output_format).toBe('png')
      for (const key of ['svg', 'frame_count', 'frame_duration_ms']) expect(c.body, key).not.toHaveProperty(key)
    }
  })

  it('PNG 仍然可以多图 / 透明底(没被误伤)', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', count: 2, transparentBackground: true })
    expect(calls[0]!.body.n).toBe(2)
    expect(calls[0]!.body.background).toBe('transparent')
  })
})

describe('ApiService GPT Image 2.6:出网前拒绝', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['GIF + 数量 2', { modelParams: { output_format: 'gif' }, count: 2 }, /一次只能出 1 张|数量/],
    ['SVG + 数量 2', { modelParams: { output_format: 'svg' }, count: 2 }, /一次只能出 1 张|数量/],
    ['GIF + 参考图', { modelParams: { output_format: 'gif' }, referenceImages: [REF] }, /文生图|参考图/],
    ['SVG + 参考图', { modelParams: { output_format: 'svg' }, referenceImages: [REF] }, /文生图|参考图/],
    ['GIF + 遮罩', { modelParams: { output_format: 'gif' }, referenceImages: [REF], maskImage: REF }, /文生图|参考图|遮罩/],
    ['GIF + 透明底', { modelParams: { output_format: 'gif' }, transparentBackground: true }, /透明/],
    ['SVG + 透明底', { modelParams: { output_format: 'svg' }, transparentBackground: true }, /透明/],
    ['PNG + 帧数', { modelParams: { frame_count: 4 } }, /GIF/],
    ['SVG + 每帧时长', { modelParams: { output_format: 'svg', frame_duration_ms: 100 } }, /GIF/],
    ['GIF + 写手模型', { modelParams: { output_format: 'gif', svg_model: 'gpt-6-luna' } }, /SVG/],
    ['帧数越界(1)', { modelParams: { output_format: 'gif', frame_count: 1 } }, /帧数/],
    ['帧数越界(65)', { modelParams: { output_format: 'gif', frame_count: 65 } }, /帧数/],
    ['每帧时长越界(10)', { modelParams: { output_format: 'gif', frame_duration_ms: 10 } }, /时长/],
    ['不认识的格式', { modelParams: { output_format: 'avif' } }, /输出格式/],
  ]

  it.each(cases)('%s → 不发请求,给出中文原因', async (_name, extra, message) => {
    const { fetchMock } = stubFetch()
    const svc = await makeService()
    const res = await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', ...extra })
    expect(res.success).toBe(false)
    expect(res.error ?? '').toMatch(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 生成页 / 批量页的参数表不按模型分桶:切走后残留的 GIF 设置用户看不见也清不掉,契约是
  // 「外发时只取当前模型声明过的键」—— 所以别的模型上这些键被丢掉、照常出普通图,不报错。
  // (agent 显式要 GIF / SVG 却落在别的模型上的情形由 gifSvgUnsupportedReason 在入口拦。)
  it.each(['custom-model-og-v2.6-s', 'custom-model-og-v2.6-f', 'gpt-image-2.5-flare', 'gpt-image-2'])(
    '%s 上残留的 GIF / SVG 参数被丢弃,请求体里不出现,照常出图',
    async (id) => {
      const { calls } = stubFetch()
      const svc = await makeService()
      const res = await svc.generateImage({
        prompt: 'p',
        model: id,
        siteKey: 'apiyi',
        modelParams: { output_format: 'gif', frame_count: 4, frame_duration_ms: 100, svg_model: 'gpt-6-luna' },
      })
      expect(res.success).toBe(true)
      expect(calls).toHaveLength(1)
      for (const key of ['svg', 'frame_count', 'frame_duration_ms']) {
        expect(calls[0]!.body, `${id} ${key}`).not.toHaveProperty(key)
      }
      expect(calls[0]!.body.output_format).toBe('png')
    },
  )
})

describe('ApiService GPT Image 2.6:不自动重试 + 结果 MIME', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it.each([{ output_format: 'gif' }, { output_format: 'svg' }])('%o 遇到 502 只发一次(上游可能已经开跑,重试会多扣费)', async (modelParams) => {
    const { fetchMock } = stubFetch(() => new Response('bad gateway', { status: 502 }))
    const svc = await makeService()
    const res = await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', modelParams })
    expect(res.success).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('GIF 的 base64 标 image/gif,SVG 标 image/svg+xml,PNG 仍标 image/png', async () => {
    const svc = await makeService()
    stubFetch(() => new Response(JSON.stringify({ data: [{ b64_json: GIF_B64 }] }), { status: 200 }))
    const gif = await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', modelParams: { output_format: 'gif' } })
    expect(gif.images?.[0]).toBe(`data:image/gif;base64,${GIF_B64}`)

    stubFetch(() => new Response(JSON.stringify({ data: [{ b64_json: SVG_B64 }] }), { status: 200 }))
    const svg = await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', modelParams: { output_format: 'svg' } })
    expect(svg.images?.[0]).toBe(`data:image/svg+xml;base64,${SVG_B64}`)

    stubFetch(() => new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }))
    const png = await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi' })
    expect(png.images?.[0]).toBe(`data:image/png;base64,${PNG_B64}`)
  })

  it('网关回的是 URL(Miau 上 apiyi 的实际形态)就原样返回', async () => {
    const url = 'https://miauapi.13797248455.xyz/response_images/17137/2026/11/09/241'
    stubFetch(() => new Response(JSON.stringify({ data: [{ url }] }), { status: 200 }))
    const svc = await makeService()
    const res = await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', modelParams: { output_format: 'gif' } })
    expect(res.images?.[0]).toBe(url)
  })
})
