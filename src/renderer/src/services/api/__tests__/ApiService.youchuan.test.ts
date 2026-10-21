import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { YOUCHUAN_V8_PARAM_SPECS } from '../../../../../shared/imageModelParams'
import { ApiService } from '../ApiService'
import { getModelParamSpecs } from '../imageParamControls'

/**
 * 悠船(Midjourney)渠道:`youchuan-v8.2`(快速)/ `youchuan-v8.2-turbo`(极速)。
 *
 * 请求形态与别的渠道都不一样,所以守卫分四块:
 *  1. 模型配置(站点绑定 / 画幅 / 能力位 / 排序);
 *  2. 请求体(顶层 `aspect_ratio`、`images:[{image_url}]`、模型专属参数、**没有** size / n);
 *  3. 出网前校验(越界一律拒绝不纠正 —— 按次计费);
 *  4. 不自动重试(5xx 后重试 = 多扣一次 4 张的价)。
 */

const MODELS = ['youchuan-v8.2', 'youchuan-v8.2-turbo'] as const

describe('悠船 模型配置', () => {
  const service = new ApiService()
  const all = service.getAllModels()

  it.each(MODELS)('%s:Miau 网关专属、Midjourney 厂商、OpenAI 图片端点', (id) => {
    const cfg = all[id]
    expect(cfg).toBeDefined()
    expect(cfg.vendor).toBe('midjourney')
    expect(cfg.requiredSiteKey).toBeDefined()
    expect(cfg.apiType).toBe('image-generation')
    expect(cfg.baseURL).toMatch(/\/v1\/images\/generations$/)
    expect(cfg.sizeStrategy).toBe('aspect-ratio')
  })

  it('快速是新模型、标 60s;极速标 30s', () => {
    expect(all['youchuan-v8.2'].isNew).toBe(true)
    expect(all['youchuan-v8.2'].time).toBe('60s')
    expect(all['youchuan-v8.2-turbo'].time).toBe('30s')
  })

  it('比例:自适应 + 界面上的 7 个常用比例,没有像素尺寸 / 分辨率档', () => {
    for (const id of MODELS) {
      expect(all[id].ratios?.map((r) => r.key)).toEqual(['auto', '1:1', '4:3', '3:2', '16:9', '3:4', '2:3', '9:16'])
      expect(all[id].resolutionMap).toBeUndefined()
      expect(all[id].resolutions).toBeUndefined()
    }
  })

  it('能力位:支持 20 张参考图、不开数量选择、不支持图层拆分 / 局部重绘', () => {
    for (const id of MODELS) {
      const cap = all[id].capabilities!
      expect(cap.referenceImage).toBe(true)
      expect(cap.maxReferenceImages).toBe(20)
      expect(cap.multipleImages).toBe(false)
      expect(cap.maxOutputs).toBe(1)
      expect(cap.layerDecomposition).toBeFalsy()
      expect(cap.imageEdit).toBe(false)
    }
  })

  it('模型专属参数表与共享的单一事实来源是同一份', () => {
    for (const id of MODELS) {
      expect(getModelParamSpecs(all[id])).toBe(YOUCHUAN_V8_PARAM_SPECS)
    }
    // 别的渠道没有
    expect(getModelParamSpecs(all['gpt-image-2.5-flare'])).toEqual([])
  })

  it('下拉顺序:紧跟千问,快速在前、极速在后', () => {
    const keys = Object.keys(all)
    const qwen = keys.indexOf('qwen-image-3.0-pro')
    expect(keys.slice(qwen + 1, qwen + 3)).toEqual(['youchuan-v8.2', 'youchuan-v8.2-turbo'])
  })
})

describe('悠船 请求体', () => {
  const service = new ApiService()
  const all = service.getAllModels()

  const build = (options: Record<string, unknown> = {}, model: string = 'youchuan-v8.2') =>
    (
      service as unknown as { buildRequestBody: (o: Record<string, unknown>) => Record<string, unknown> }
    ).buildRequestBody({
      prompt: 'neon street at night',
      model,
      ratio: 'auto',
      modelConfig: all[model],
      ...options,
    })

  it('什么都不设:只发 model / prompt / 默认开的原生 2K,别的一律不发', () => {
    expect(build()).toEqual({ model: 'youchuan-v8.2', prompt: 'neon street at night', hd: true })
  })

  it('极速模型名原样外发(版本 / 速度只来自模型名)', () => {
    expect(build({}, 'youchuan-v8.2-turbo').model).toBe('youchuan-v8.2-turbo')
  })

  it('刻意没有 size / n / response_format / quality 顶层字段', () => {
    const body = build({ resolution: '4K', count: 4, ratio: '16:9' })
    for (const key of ['size', 'n', 'response_format', 'resolution', 'quality', 'image', 'input']) {
      expect(key in body, key).toBe(false)
    }
  })

  it('自适应不发 aspect_ratio;具体比例原样发,含界面外的 W:H', () => {
    expect('aspect_ratio' in build({ ratio: 'auto' })).toBe(false)
    expect('aspect_ratio' in build({ ratio: undefined })).toBe(false)
    expect(build({ ratio: '16:9' }).aspect_ratio).toBe('16:9')
    expect(build({ ratio: '21:9' }).aspect_ratio).toBe('21:9')
  })

  it('关掉原生 2K:显式发 hd:false,赢过默认的 true', () => {
    expect(build({ modelParams: { hd: false } }).hd).toBe(false)
  })

  it('高级参数原样铺在顶层,类型已规整', () => {
    const body = build({
      modelParams: {
        quality: 4,
        chaos: '30',
        stylize: 500,
        raw: true,
        iw: 1.5,
        sref: ['https://e.com/s1.png', 'https://e.com/s2.png'],
        sw: 200,
        sv: 6,
        seed: 42,
        no: 'text, watermark',
      },
    })
    expect(body).toMatchObject({
      hd: true,
      quality: '4',
      chaos: 30,
      stylize: 500,
      raw: true,
      iw: 1.5,
      sref: ['https://e.com/s1.png', 'https://e.com/s2.png'],
      sw: 200,
      sv: 6,
      seed: 42,
      no: 'text, watermark',
    })
  })

  it('没声明的键不外发(切模型后残留的旧值 / agent 手滑)', () => {
    const body = build({ modelParams: { weird: 100, version: '7', turbo: true } })
    expect('weird' in body).toBe(false)
    expect('version' in body).toBe(false)
    expect('turbo' in body).toBe(false)
  })

  it('通用 seed 在没有 modelParams.seed 时当作它的别名;两者都给时以 modelParams 为准', () => {
    expect(build({ seed: 7 }).seed).toBe(7)
    expect(build({ seed: 7, modelParams: { seed: 9 } }).seed).toBe(9)
    expect('seed' in build()).toBe(false)
  })

  it('参考图:http(s) 链接发成 images:[{image_url}],顺序不变', () => {
    const body = build({ referenceImages: ['https://e.com/1.png', 'http://e.com/2.png'] })
    expect(body.images).toEqual([{ image_url: 'https://e.com/1.png' }, { image_url: 'http://e.com/2.png' }])
  })

  it('参考图恰好 20 张全部发出,21 张报错而不是截断', () => {
    const refs = (n: number) => Array.from({ length: n }, (_, i) => `https://e.com/${i}.png`)
    expect((build({ referenceImages: refs(20) }).images as unknown[]).length).toBe(20)
    expect(() => build({ referenceImages: refs(21) })).toThrow(/最多支持 20 张参考图/)
  })

  it('base64 / 本地路径参考图被拒,并说清出路', () => {
    expect(() => build({ referenceImages: ['data:image/png;base64,AAAA'] })).toThrow(/http\/https/)
    expect(() => build({ referenceImages: ['C:/pics/a.png'] })).toThrow(/http\/https/)
    expect(() => build({ imageBase64: 'data:image/png;base64,AAAA' })).toThrow(/不接受本地文件或 base64/)
  })

  it('越界参数抛错,不纠正后照发', () => {
    expect(() => build({ modelParams: { chaos: 500 } })).toThrow(/悠船参数有误.*混沌程度/)
    expect(() => build({ modelParams: { stylize: -1 } })).toThrow(/风格化程度/)
    expect(() => build({ modelParams: { no: 'x --v 6' } })).toThrow(/排除内容/)
  })

  it('不认识的比例报错', () => {
    expect(() => build({ ratio: 'wide' })).toThrow(/不支持画幅/)
    expect(() => build({ ratio: '0:1' })).toThrow(/不支持画幅/)
  })
})

describe('悠船 出网前校验与重试策略', () => {
  beforeEach(() => {
    localStorage.clear()
    // Miau 站点的 Key:走自有 Key 路径,这样「没配 Key」不会抢在参数校验前报错
    localStorage.setItem('api_key_antigravity', 'user-typed-key')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  function stubFetch(handler: () => Response) {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => handler())
    vi.stubGlobal('fetch', fn)
    return fn
  }

  const ok4 = () =>
    new Response(
      JSON.stringify({ data: Array.from({ length: 4 }, (_, i) => ({ url: `https://cdn.example/out-${i}.png` })) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  it('合法请求:出网一次,body 是悠船形态,4 张结果全部带回', async () => {
    const fetchFn = stubFetch(ok4)
    const result = await new ApiService().generateImage({
      prompt: 'neon street',
      model: 'youchuan-v8.2',
      ratio: '16:9',
      modelParams: { chaos: 20 },
    })

    expect(result.success).toBe(true)
    expect(result.images).toHaveLength(4)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toMatch(/\/v1\/images\/generations$/)
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'youchuan-v8.2',
      prompt: 'neon street',
      aspect_ratio: '16:9',
      hd: true,
      chaos: 20,
    })
  })

  it.each([
    ['越界参数', { modelParams: { chaos: 500 } }, /悠船参数有误/],
    ['不认识的比例', { ratio: 'wide' }, /不支持画幅/],
    ['21 张参考图', { referenceImages: Array.from({ length: 21 }, (_, i) => `https://e.com/${i}.png`) }, /最多支持 20 张/],
    ['本地文件参考图', { referenceImages: ['C:/pics/a.png'] }, /只接受 http\/https/],
    ['base64 参考图', { referenceImages: ['data:image/png;base64,AAAA'] }, /只接受 http\/https/],
  ])('%s:返回中文错误,一次都不出网', async (_label, extra, message) => {
    const fetchFn = stubFetch(ok4)
    const result = await new ApiService().generateImage({
      prompt: 'x',
      model: 'youchuan-v8.2',
      ...(extra as Record<string, unknown>),
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(message)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('错误里带用户给的链接时不被 formatErrorMessage 改写(链接里出现 401 很常见)', async () => {
    const fetchFn = stubFetch(ok4)
    const result = await new ApiService().generateImage({
      prompt: 'x',
      model: 'youchuan-v8.2',
      modelParams: { sref: ['ftp://example.com/401.png'] },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('ftp://example.com/401.png')
    expect(result.error).not.toMatch(/API Key 无效/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('网关 502 也不自动重试 —— 按次计费,上游可能已经开跑,重试 = 多扣一次', async () => {
    const fetchFn = stubFetch(
      () => new Response(JSON.stringify({ error: { message: 'bad gateway' } }), { status: 502 }),
    )
    const result = await new ApiService().generateImage({ prompt: 'neon street', model: 'youchuan-v8.2' })

    expect(result.success).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
