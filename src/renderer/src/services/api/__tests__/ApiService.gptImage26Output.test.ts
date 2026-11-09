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

  it('2.5 官转 / 腾讯 2.5 / 腾讯 v2 / gpt-image-2 不声明这些参数(各自的合同没验证)', async () => {
    const { ApiService } = await import('../ApiService')
    const svc = new ApiService()
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'custom-model-og-v2.5-f', 'custom-model-og-v2.5-s', 'custom-model-og-v2', 'gpt-image-2']) {
      expect(svc.getModelConfig(id)?.capabilities?.modelParams, id).toBeUndefined()
    }
  })

  it.each(['custom-model-og-v2.6-f', 'custom-model-og-v2.6-s'])(
    '%s(腾讯 2.6)声明 output_format / frame_count / frame_duration_ms / svg_effort 四项,不声明 svg_model / complexity / markup / jpeg',
    async (id) => {
      const { ApiService } = await import('../ApiService')
      const cfg = new ApiService().getModelConfig(id)!
      expect(cfg.capabilities?.modelParams?.map((s) => s.key)).toEqual([
        'output_format',
        'frame_count',
        'frame_duration_ms',
        'svg_effort',
      ])
      expect(JSON.stringify(cfg.capabilities?.modelParams)).not.toMatch(/svg_model|complexity|markup|jpeg/i)
      expect(cfg.defaultParams).toEqual({ output_format: 'png' })
      expect(cfg.displayName).toMatch(/GIF/)
      expect(cfg.displayName).toMatch(/SVG/)
    },
  )
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
      // 1K 档是 1280²(按每帧算),但 GIF 是拼图编码:2 帧 1280² 上游直接 400。收到 960²。
      size: '960x960',
      quality: 'low',
      output_format: 'gif',
      frame_count: 2,
      frame_duration_ms: 100,
    })
    for (const key of ['n', 'background', 'svg', 'complexity', 'markup']) {
      expect(calls[0]!.body, key).not.toHaveProperty(key)
    }
  })

  it('GIF 的尺寸不随 1K / 2K / 4K 档:统统收进拼图预算(960² 起;帧多更小;PNG 的尺寸不受影响)', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    for (const resolution of ['1K', '2K', '4K']) {
      await svc.generateImage({
        prompt: 'p', model: FLARE, siteKey: 'apiyi', ratio: '1:1', resolution,
        modelParams: { output_format: 'gif', frame_count: 4 },
      })
    }
    await svc.generateImage({
      prompt: 'p', model: FLARE, siteKey: 'apiyi', ratio: '1:1', resolution: '1K',
      modelParams: { output_format: 'gif', frame_count: 16 },
    })
    await svc.generateImage({ prompt: 'p', model: FLARE, siteKey: 'apiyi', ratio: '1:1', resolution: '1K' })
    expect(calls.map((c) => c.body.size)).toEqual(['960x960', '960x960', '960x960', '720x720', '1280x1280'])
  })

  it('GIF + 比例 auto(没有可查的尺寸)→ 也要带上收进预算的方图尺寸,不能留给上游挑(上游默认 1024² 会 400)', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({
      prompt: 'p', model: FLARE, siteKey: 'apiyi', ratio: 'auto',
      modelParams: { output_format: 'gif', frame_count: 2 },
    })
    expect(calls[0]!.body.size).toBe('960x960')
  })

  it('SVG 的尺寸不动(只有 GIF 是拼图编码)', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({
      prompt: 'p', model: FLARE, siteKey: 'apiyi', ratio: '1:1', resolution: '1K',
      modelParams: { output_format: 'svg' },
    })
    expect(calls[0]!.body.size).toBe('1280x1280')
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
    // 上游实测:超过 16 报 400,或静默丢掉整个 GIF 配置(17 / 32 / 64 帧请求回的是 9 帧 / 200 ms)。
    ['帧数越界(17)', { modelParams: { output_format: 'gif', frame_count: 17 } }, /帧数/],
    ['帧数越界(64)', { modelParams: { output_format: 'gif', frame_count: 64 } }, /帧数/],
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
  it.each(['custom-model-og-v2.5-s', 'custom-model-og-v2.5-f', 'gpt-image-2.5-flare', 'gpt-image-2'])(
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

/**
 * 腾讯 TokenHub 2.6(custom-model-og-v2.6-f / -s)的 GIF / SVG。
 *
 * 2026-11-09 经 Miau 生产网关实测(sora-ui #324 / sora-ui-backend #177 同口径):
 * - GIF:与 apiyi 同一条拼图规则,但每帧长边取 512(默认画质 high 下 512² 9 帧 ≈ ¥0.51,
 *   960 上限要贵 4–5 倍);不填帧数 = 9 帧 / 200 ms;
 * - SVG:`svg: { model: 'gpt-5.4-mini', reasoning: { effort } }`,effort 只开 none / low;
 * - 结果是带真实后缀(`.gif` / `.svg`)的 URL;请求体里仍带 `extra_body.logo_add: 0` 去水印。
 */
const TX_F = 'custom-model-og-v2.6-f'
const TX_S = 'custom-model-og-v2.6-s'

async function makeMiauService() {
  localStorage.setItem('api_key_antigravity', 'miau-key')
  localStorage.setItem('current_site', 'antigravity')
  const { ApiService } = await import('../ApiService')
  return new ApiService()
}

const TX_URL = 'https://aigc-output-image-1326893053.cos.ap-guangzhou.myqcloud.com/1345773498/x_0.gif?q-sign-algorithm=sha1'

describe('ApiService 腾讯 2.6:GIF / SVG 请求体', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it.each([TX_F, TX_S])('%s GIF:output_format + 帧参数外发,每帧 512²(不是 1K 档的 1280²),保留 logo_add,没有 n / background / svg', async (id) => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    const res = await svc.generateImage({
      prompt: 'a bouncing ball',
      model: id,
      siteKey: 'antigravity',
      ratio: '1:1',
      resolution: '1K',
      quality: 'low',
      modelParams: { output_format: 'gif', frame_count: 2, frame_duration_ms: 100 },
    })
    expect(res.success).toBe(true)
    const url = new URL(calls[0]!.url)
    expect(url.host).toContain('miauapi.13797248455.xyz')
    expect(url.pathname).toBe('/v1/images/generations')
    expect(calls[0]!.body).toMatchObject({
      model: id,
      prompt: 'a bouncing ball',
      size: '512x512',
      quality: 'low',
      output_format: 'gif',
      frame_count: 2,
      frame_duration_ms: 100,
      extra_body: { logo_add: 0 },
    })
    for (const key of ['n', 'background', 'svg', 'complexity', 'markup']) {
      expect(calls[0]!.body, key).not.toHaveProperty(key)
    }
  })

  it('GIF 的尺寸不随 1K / 2K / 4K 档与帧数:都是 512²;16:9 = 512x288;比例 auto 也要显式给 512²', async () => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    for (const resolution of ['1K', '2K', '4K']) {
      await svc.generateImage({
        prompt: 'p', model: TX_F, siteKey: 'antigravity', ratio: '1:1', resolution,
        modelParams: { output_format: 'gif', frame_count: 16 },
      })
    }
    await svc.generateImage({
      prompt: 'p', model: TX_F, siteKey: 'antigravity', ratio: '16:9', resolution: '1K',
      modelParams: { output_format: 'gif', frame_count: 9 },
    })
    await svc.generateImage({
      prompt: 'p', model: TX_F, siteKey: 'antigravity', ratio: 'auto',
      modelParams: { output_format: 'gif', frame_count: 2 },
    })
    // PNG 的尺寸不受影响
    await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', ratio: '1:1', resolution: '1K' })
    expect(calls.map((c) => c.body.size)).toEqual(['512x512', '512x512', '512x512', '512x288', '512x512', '1280x1280'])
  })

  it('GIF 只给 output_format 时,帧参数不出现(上游默认 9 帧 / 200 ms)', async () => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    await svc.generateImage({ prompt: 'p', model: TX_S, siteKey: 'antigravity', modelParams: { output_format: 'gif' } })
    expect(calls[0]!.body.output_format).toBe('gif')
    expect(calls[0]!.body).not.toHaveProperty('frame_count')
    expect(calls[0]!.body).not.toHaveProperty('frame_duration_ms')
  })

  it.each([TX_F, TX_S])('%s SVG:嵌套 svg = gpt-5.4-mini + reasoning.effort(默认 low),尺寸不动,没有帧参数 / n / background', async (id) => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    await svc.generateImage({
      prompt: 'a logo', model: id, siteKey: 'antigravity', ratio: '1:1', resolution: '1K',
      modelParams: { output_format: 'svg' },
    })
    expect(calls[0]!.body.output_format).toBe('svg')
    expect(calls[0]!.body.svg).toEqual({ model: 'gpt-5.4-mini', reasoning: { effort: 'low' } })
    expect(calls[0]!.body.size).toBe('1280x1280')
    expect(calls[0]!.body.extra_body).toEqual({ logo_add: 0 })
    for (const key of ['n', 'background', 'frame_count', 'frame_duration_ms', 'complexity']) {
      expect(calls[0]!.body, key).not.toHaveProperty(key)
    }
  })

  it('SVG 选了 none 就发 none;误带的 svg_model(apiyi 的键)被丢弃,写手固定 gpt-5.4-mini', async () => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    await svc.generateImage({
      prompt: 'p', model: TX_F, siteKey: 'antigravity',
      modelParams: { output_format: 'svg', svg_effort: 'none', svg_model: 'gpt-6-luna' },
    })
    expect(calls[0]!.body.svg).toEqual({ model: 'gpt-5.4-mini', reasoning: { effort: 'none' } })
  })

  it('apiyi 上误带的 svg_effort(腾讯的键)被丢弃,请求体仍是 svg: { model }', async () => {
    const { calls } = stubFetch()
    const svc = await makeService()
    await svc.generateImage({
      prompt: 'p', model: FLARE, siteKey: 'apiyi',
      modelParams: { output_format: 'svg', svg_effort: 'none' },
    })
    expect(calls[0]!.body.svg).toEqual({ model: 'gpt-4.1-mini' })
  })

  it('不设 modelParams / 设 png = 与改动前完全一样的 PNG 请求(不带任何新字段)', async () => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity' })
    await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', modelParams: { output_format: 'png' } })
    for (const c of calls) {
      expect(c.body.output_format).toBe('png')
      expect(c.body.extra_body).toEqual({ logo_add: 0 })
      for (const key of ['svg', 'frame_count', 'frame_duration_ms']) expect(c.body, key).not.toHaveProperty(key)
    }
  })

  it('PNG 仍然可以多图 / 透明底(没被误伤)', async () => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', count: 2, transparentBackground: true })
    expect(calls[0]!.body.n).toBe(2)
    expect(calls[0]!.body.background).toBe('transparent')
  })
})

describe('ApiService 腾讯 2.6:出网前拒绝', () => {
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
    ['GIF + 推理强度', { modelParams: { output_format: 'gif', svg_effort: 'low' } }, /SVG/],
    ['PNG + 推理强度', { modelParams: { svg_effort: 'none' } }, /SVG/],
    ['推理强度越界(medium)', { modelParams: { output_format: 'svg', svg_effort: 'medium' } }, /推理强度/],
    ['帧数越界(1)', { modelParams: { output_format: 'gif', frame_count: 1 } }, /帧数/],
    ['帧数越界(17)', { modelParams: { output_format: 'gif', frame_count: 17 } }, /帧数/],
    ['每帧时长越界(10)', { modelParams: { output_format: 'gif', frame_duration_ms: 10 } }, /时长/],
    ['不认识的格式(jpeg 不在开放范围)', { modelParams: { output_format: 'jpeg' } }, /输出格式/],
  ]

  it.each(cases)('%s → 不发请求,给出中文原因', async (_name, extra, message) => {
    const { fetchMock } = stubFetch()
    const svc = await makeMiauService()
    const res = await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', ...extra })
    expect(res.success).toBe(false)
    expect(res.error ?? '').toMatch(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('腾讯 2.6 的 mask 擦除 / 参考图编辑(不带 GIF / SVG)不受影响,仍走 JSON images[]', async () => {
    const { calls } = stubFetch()
    const svc = await makeMiauService()
    const res = await svc.generateImage({
      prompt: '擦掉', model: TX_F, siteKey: 'antigravity',
      referenceImages: [REF], maskImage: REF,
    })
    expect(res.success).toBe(true)
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/images/edits')
    expect(calls[0]!.body).toHaveProperty('images')
    expect(calls[0]!.body).toHaveProperty('mask')
    for (const key of ['svg', 'frame_count', 'frame_duration_ms']) expect(calls[0]!.body, key).not.toHaveProperty(key)
  })
})

describe('ApiService 腾讯 2.6:不自动重试 + 结果', () => {
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
    const svc = await makeMiauService()
    const res = await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', modelParams })
    expect(res.success).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('网关回的是带真实后缀的 URL(腾讯的实际形态,b64_json 是空的)→ 原样返回', async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [{ url: TX_URL, b64_json: '' }] }), { status: 200 }))
    const svc = await makeMiauService()
    const res = await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', modelParams: { output_format: 'gif' } })
    expect(res.success).toBe(true)
    expect(res.images?.[0]).toBe(TX_URL)
  })

  it('万一回的是 base64:GIF 标 image/gif,SVG 标 image/svg+xml', async () => {
    const svc = await makeMiauService()
    stubFetch(() => new Response(JSON.stringify({ data: [{ b64_json: GIF_B64 }] }), { status: 200 }))
    const gif = await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', modelParams: { output_format: 'gif' } })
    expect(gif.images?.[0]).toBe(`data:image/gif;base64,${GIF_B64}`)
    stubFetch(() => new Response(JSON.stringify({ data: [{ b64_json: SVG_B64 }] }), { status: 200 }))
    const svg = await svc.generateImage({ prompt: 'p', model: TX_F, siteKey: 'antigravity', modelParams: { output_format: 'svg' } })
    expect(svg.images?.[0]).toBe(`data:image/svg+xml;base64,${SVG_B64}`)
  })
})