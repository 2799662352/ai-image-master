import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NOVELAI_V45_PARAM_SPECS,
  NOVELAI_V5_PARAM_SPECS,
} from '../../../../../shared/imageModelParams'
import { ApiService } from '../ApiService'
import { getModelParamSpecs } from '../imageParamControls'

/**
 * NovelAI(经 TTAPI,网关渠道类型 77):`nai-diffusion-{5,4-5}-{full,curated}`。
 *
 * 形态:OpenAI 兼容外壳(`size` / `n`)+ 顶层专属字段(`character_prompts` / 采样参数 / 图生图)。
 * 按张固定价计费,所以守卫分四块:
 *  1. 模型配置(站点绑定 / 画幅 / 清晰度 / 能力位 / 排序);
 *  2. 请求体(字段名与网关逐一对应、未设置的不发、图生图字段只在有底图时发);
 *  3. 出网前校验(越界一律拒绝不纠正,一次都不出网);
 *  4. 不自动重试(5xx 后重试 = 多扣一张的价)。
 */

const V5 = ['nai-diffusion-5-full', 'nai-diffusion-5-curated'] as const
const V45 = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'] as const
const MODELS = [...V5, ...V45] as const

describe('NovelAI 模型配置', () => {
  const service = new ApiService()
  const all = service.getAllModels()

  it.each(MODELS)('%s:Miau 网关专属、NovelAI 厂商、OpenAI 图片端点', (id) => {
    const cfg = all[id]
    expect(cfg).toBeDefined()
    expect(cfg.vendor).toBe('novelai')
    expect(cfg.requiredSiteKey).toBeDefined()
    expect(cfg.apiType).toBe('image-generation')
    expect(cfg.baseURL).toMatch(/\/v1\/images\/generations$/)
    expect(cfg.sizeStrategy).toBe('resolution-map')
  })

  it('不编造耗时:没有实测就不写 time', () => {
    for (const id of MODELS) expect(all[id].time).toBeUndefined()
  })

  it('比例:7 个定档比例,没有「自适应」;清晰度 1K / 2K,默认 1K', () => {
    for (const id of MODELS) {
      expect(all[id].ratios?.map((r) => r.key)).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])
      expect(all[id].resolutions?.map((r) => r.key)).toEqual(['1K', '2K'])
      expect(all[id].defaultResolution).toBe('1K')
    }
  })

  it('比例 × 清晰度表里每个格子都有尺寸', () => {
    for (const id of MODELS) {
      const map = all[id].resolutionMap!
      for (const ratio of all[id].ratios!) {
        for (const res of all[id].resolutions!) {
          expect(map[ratio.key]?.[res.key], `${id} ${ratio.key} ${res.key}`).toMatch(/^\d+x\d+$/)
        }
      }
    }
  })

  it('能力位:原生一次最多 4 张、参考图只有 1 张、不支持局部重绘 / 图层拆分', () => {
    for (const id of MODELS) {
      const cap = all[id].capabilities!
      expect(cap.multipleImages).toBe(true)
      expect(cap.nativeBatch).toBe(true)
      expect(cap.maxOutputs).toBe(4)
      expect(cap.referenceImage).toBe(true)
      expect(cap.maxReferenceImages).toBe(1)
      expect(cap.customSize).toBe(false)
      expect(cap.imageEdit).toBe(false)
      expect(cap.layerDecomposition).toBeFalsy()
    }
  })

  it('透明背景只有 V5 开放', () => {
    for (const id of V5) expect(all[id].capabilities!.transparentBackgroundControl).toBe(true)
    for (const id of V45) expect(all[id].capabilities!.transparentBackgroundControl).toBe(false)
  })

  it('模型专属参数表与共享的单一事实来源是同一份(V5 / V4.5 各一份)', () => {
    for (const id of V5) expect(getModelParamSpecs(all[id])).toBe(NOVELAI_V5_PARAM_SPECS)
    for (const id of V45) expect(getModelParamSpecs(all[id])).toBe(NOVELAI_V45_PARAM_SPECS)
  })

  it('下拉顺序:紧跟悠船,V5 Full → V5 Curated → V4.5 Full → V4.5 Curated', () => {
    const keys = Object.keys(all)
    const turbo = keys.indexOf('youchuan-v8.2-turbo')
    expect(keys.slice(turbo + 1, turbo + 5)).toEqual([...MODELS])
  })
})

describe('NovelAI 请求体', () => {
  const service = new ApiService()
  const all = service.getAllModels()

  const build = (options: Record<string, unknown> = {}, model: string = 'nai-diffusion-5-full') =>
    (
      service as unknown as { buildRequestBody: (o: Record<string, unknown>) => Record<string, unknown> }
    ).buildRequestBody({
      prompt: '1girl, solo',
      model,
      ratio: '1:1',
      modelConfig: all[model],
      ...options,
    })

  it('什么都不设:model / prompt / size(1:1 1K)/ n:1 + 产品默认采样参数,别的一律不发', () => {
    expect(build()).toEqual({
      model: 'nai-diffusion-5-full',
      prompt: '1girl, solo',
      size: '1024x1024',
      n: 1,
      dataset_mode: 'anime',
      steps: 23,
      scale: 5,
      sampler: 'Euler Ancestral',
      noise_schedule: 'karras',
    })
  })

  it('没有底图时不发 strength / noise / image(网关对「无底图带这两项」直接 400)', () => {
    const body = build({ modelParams: { img2img_strength: 0.5, img2img_noise: 0.1 } })
    for (const key of ['strength', 'noise', 'image', 'img2img_strength', 'img2img_noise']) {
      expect(key in body, key).toBe(false)
    }
  })

  it('刻意不发氛围迁移 / 角色精准参考 / 透明底以外的字段', () => {
    const body = build({ transparentBackground: false })
    for (const key of ['vibe_transfer', 'character_reference', 'background', 'character_prompts', 'response_format']) {
      expect(key in body, key).toBe(false)
    }
  })

  it.each([
    ['1:1', '1K', '1024x1024'],
    ['1:1', '2K', '1536x1536'],
    ['3:2', '1K', '1216x832'],
    ['2:3', '1K', '832x1216'],
    ['16:9', '1K', '1344x768'],
    ['9:16', '2K', '1088x1920'],
    ['4:3', '2K', '1728x1344'],
    ['3:4', '2K', '1344x1728'],
  ])('比例 %s × %s → size %s', (ratio, resolution, size) => {
    expect(build({ ratio, resolution }).size).toBe(size)
  })

  it('清晰度大小写不敏感;缺省 / auto 比例落到 1:1', () => {
    expect(build({ resolution: '2k' }).size).toBe('1536x1536')
    expect(build({ ratio: undefined }).size).toBe('1024x1024')
    expect(build({ ratio: 'auto' }).size).toBe('1024x1024')
  })

  it('n:按 count 发,夹在 1–4;小数向下取整', () => {
    expect(build({ count: 3 }).n).toBe(3)
    expect(build({ count: 4 }).n).toBe(4)
    expect(build({ count: 9 }).n).toBe(4)
    expect(build({ count: 0 }).n).toBe(1)
    expect(build({ count: 2.9 }).n).toBe(2)
    expect(build({ count: undefined }).n).toBe(1)
  })

  it('V5 透明背景:发 background:"transparent"', () => {
    expect(build({ transparentBackground: true }).background).toBe('transparent')
  })

  it.each(V45)('%s 要透明背景直接抛错,指向 V5', (id) => {
    expect(() => build({ transparentBackground: true }, id)).toThrow(/V4\.5 不支持透明背景/)
  })

  it('高级参数原样铺在顶层,类型已规整', () => {
    const body = build({
      modelParams: {
        dataset_mode: 'furry',
        negative_prompt: ' lowres ',
        steps: '30',
        scale: 6.5,
        sampler: 'Euler',
        noise_schedule: 'exponential',
        seed: 42,
      },
    })
    expect(body).toMatchObject({
      dataset_mode: 'furry',
      negative_prompt: 'lowres',
      steps: 30,
      scale: 6.5,
      sampler: 'Euler',
      noise_schedule: 'exponential',
      seed: 42,
    })
  })

  it('没声明的键不外发(切模型后残留的悠船参数 / agent 手滑)', () => {
    const body = build({ modelParams: { chaos: 30, hd: true, stylize: 500, weird: 1 } })
    for (const key of ['chaos', 'hd', 'stylize', 'weird']) expect(key in body, key).toBe(false)
  })

  it('通用 negativePrompt / seed 是别名;两者都给时以 modelParams 为准', () => {
    expect(build({ negativePrompt: 'lowres' }).negative_prompt).toBe('lowres')
    expect(build({ negativePrompt: 'lowres', modelParams: { negative_prompt: 'blurry' } }).negative_prompt).toBe('blurry')
    expect(build({ seed: 7 }).seed).toBe(7)
    expect(build({ seed: 7, modelParams: { seed: 9 } }).seed).toBe(9)
    expect('seed' in build()).toBe(false)
    expect('negative_prompt' in build()).toBe(false)
    expect('negative_prompt' in build({ negativePrompt: '   ' })).toBe(false)
  })

  it('角色提示词:翻成网关的 character_prompts [{prompt, uc?, center:{x,y}}]', () => {
    const body = build({
      modelParams: {
        characters: [
          { prompt: '1girl, red hair', uc: 'hat', x: 0.2, y: 0.4 },
          { prompt: '1boy' },
          { prompt: 'off', enabled: false },
          { prompt: '' },
        ],
      },
    })
    expect(body.character_prompts).toEqual([
      { prompt: '1girl, red hair', uc: 'hat', center: { x: 0.2, y: 0.4 } },
      { prompt: '1boy', center: { x: 0.5, y: 0.5 } },
    ])
    expect('characters' in body).toBe(false)
  })

  it('没有有效角色就不发 character_prompts', () => {
    expect('character_prompts' in build({ modelParams: { characters: [{ prompt: '' }] } })).toBe(false)
  })

  it('V4.5 最多 6 个角色、V5 最多 22 个;超出抛错而不是截断', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ prompt: `c${i}` }))
    expect((build({ modelParams: { characters: rows(22) } }).character_prompts as unknown[]).length).toBe(22)
    expect(() => build({ modelParams: { characters: rows(23) } })).toThrow(/最多 22 个/)
    expect((build({ modelParams: { characters: rows(6) } }, 'nai-diffusion-4-5-full').character_prompts as unknown[]).length).toBe(6)
    expect(() => build({ modelParams: { characters: rows(7) } }, 'nai-diffusion-4-5-full')).toThrow(/最多 6 个/)
  })

  describe('图生图', () => {
    it('http(s) 底图发成 image,并带上 strength / noise(默认 0.7 / 0)', () => {
      const body = build({ referenceImages: ['https://e.com/base.png'] })
      expect(body.image).toBe('https://e.com/base.png')
      expect(body.strength).toBe(0.7)
      expect(body.noise).toBe(0)
      expect('img2img_strength' in body).toBe(false)
    })

    it('用户给的强度 / 噪声原样带上', () => {
      const body = build({
        referenceImages: ['https://e.com/base.png'],
        modelParams: { img2img_strength: 0.35, img2img_noise: 0.2 },
      })
      expect(body.strength).toBe(0.35)
      expect(body.noise).toBe(0.2)
    })

    it('强度越界抛错', () => {
      expect(() =>
        build({ referenceImages: ['https://e.com/base.png'], modelParams: { img2img_strength: 1 } }),
      ).toThrow(/NovelAI 参数有误.*不能大于 0.99/)
    })

    it('2 张参考图报错而不是只取第一张', () => {
      expect(() => build({ referenceImages: ['https://e.com/1.png', 'https://e.com/2.png'] })).toThrow(
        /只支持 1 张参考图，当前传了 2 张/,
      )
    })

    it('base64 / 本地路径底图被拒,并说清出路', () => {
      expect(() => build({ referenceImages: ['data:image/png;base64,AAAA'] })).toThrow(/http\/https/)
      expect(() => build({ referenceImages: ['C:/pics/a.png'] })).toThrow(/http\/https/)
      expect(() => build({ imageBase64: 'data:image/png;base64,AAAA' })).toThrow(/不接受本地文件或 base64/)
    })
  })

  it('不认识的比例 / 清晰度抛错,不悄悄换成别的尺寸', () => {
    expect(() => build({ ratio: '21:9' })).toThrow(/不支持画幅「21:9」/)
    expect(() => build({ ratio: '5:4' })).toThrow(/不支持画幅/)
    expect(() => build({ resolution: '4K' })).toThrow(/只支持 1K \/ 2K 清晰度/)
  })
})

describe('NovelAI 出网前校验与重试策略', () => {
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

  const okN = (n: number) => () =>
    new Response(
      JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ url: `https://cdn.example/out-${i}.png` })) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  it('合法请求:出网一次,body 是 NovelAI 形态,count 张结果全部带回', async () => {
    const fetchFn = stubFetch(okN(3))
    const result = await new ApiService().generateImage({
      prompt: '1girl, solo',
      model: 'nai-diffusion-5-curated',
      ratio: '2:3',
      resolution: '2K',
      count: 3,
      modelParams: { steps: 28, characters: [{ prompt: 'red hair', x: 0.3, y: 0.5 }] },
    })

    expect(result.success).toBe(true)
    expect(result.images).toHaveLength(3)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toMatch(/\/v1\/images\/generations$/)
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'nai-diffusion-5-curated',
      prompt: '1girl, solo',
      size: '1280x1856',
      n: 3,
      dataset_mode: 'anime',
      steps: 28,
      scale: 5,
      sampler: 'Euler Ancestral',
      noise_schedule: 'karras',
      character_prompts: [{ prompt: 'red hair', center: { x: 0.3, y: 0.5 } }],
    })
  })

  it.each([
    ['空提示词', { prompt: '   ' }, /需要提示词/],
    ['提示词超过 4000 字符', { prompt: 'a'.repeat(4001) }, /最长 4000/],
    ['越界参数', { modelParams: { steps: 99 } }, /NovelAI 参数有误/],
    ['不认识的比例', { ratio: '21:9' }, /不支持画幅/],
    ['不认识的清晰度', { resolution: '4K' }, /只支持 1K \/ 2K/],
    ['2 张参考图', { referenceImages: ['https://e.com/1.png', 'https://e.com/2.png'] }, /只支持 1 张/],
    ['本地文件参考图', { referenceImages: ['C:/pics/a.png'] }, /只接受 http\/https/],
    ['base64 参考图', { referenceImages: ['data:image/png;base64,AAAA'] }, /只接受 http\/https/],
    [
      '角色缺提示词',
      { modelParams: { characters: [{ prompt: '', uc: 'hat' }] } },
      /角色 1 的提示词不能为空/,
    ],
    [
      '角色位置越界',
      { modelParams: { characters: [{ prompt: 'a', x: 2 }] } },
      /位置 x/,
    ],
  ])('%s:返回中文错误,一次都不出网', async (_label, extra, message) => {
    const fetchFn = stubFetch(okN(1))
    const result = await new ApiService().generateImage({
      prompt: '1girl',
      model: 'nai-diffusion-5-full',
      ...(extra as Record<string, unknown>),
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(message)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each(V45)('%s 要透明背景:返回中文错误,一次都不出网', async (id) => {
    const fetchFn = stubFetch(okN(1))
    const result = await new ApiService().generateImage({ prompt: '1girl', model: id, transparentBackground: true })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/V4\.5 不支持透明背景/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('错误里带用户给的链接时不被 formatErrorMessage 改写(链接里出现 401 很常见)', async () => {
    const fetchFn = stubFetch(okN(1))
    const result = await new ApiService().generateImage({
      prompt: '1girl',
      model: 'nai-diffusion-5-full',
      referenceImages: ['ftp://example.com/401.png'],
    })

    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/API Key 无效/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('网关 502 也不自动重试 —— 按张计费,上游可能已经开跑,重试 = 多扣一张', async () => {
    const fetchFn = stubFetch(
      () => new Response(JSON.stringify({ error: { message: 'bad gateway' } }), { status: 502 }),
    )
    const result = await new ApiService().generateImage({ prompt: '1girl', model: 'nai-diffusion-5-full' })

    expect(result.success).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
