import { describe, it, expect } from 'vitest'
import { ApiService } from '../ApiService'

/**
 * Seedream 5.5(doubao-seedream-5-5-261028,火山豆包经 Miau 网关,2026-11-16 接入)。
 *
 * 契约来自接入文档(`2026-11-16-miau-api-seedance-2.5-flash-seedream-5.5.md`):
 * - 与 5.0 Pro 同一套网关转换(`seedream-5` 前缀),一次一张,参考图走顶层 image / images;
 * - 图层分离:用户 2026-11-16 亲测可用,所以 `layerDecomposition` 能力位是开的。
 *
 * ⚠️ 下面**没有**钉死的东西(没验证,不要在这里当成事实):
 * - 5.5 的像素档位表(`resolutionMap`)是照 5.0 Pro 抄的,文档没给 5.5 自己的表;
 * - 参考图张数上限(没配 `maxReferenceImages`);
 * - 5.5 图层分离的计费口径。
 */
describe('ApiService Seedream 5.5 model config', () => {
  const service = new ApiService()
  const cfg = service.getModelConfig('doubao-seedream-5-5-261028')!

  it('is registered as an image-generation model pinned to the Miau site', () => {
    expect(cfg).toBeDefined()
    expect(cfg.apiType).toBe('image-generation')
    expect(cfg.sizeStrategy).toBe('seedream')
    expect(cfg.baseURL).toContain('/v1/images/generations')
    expect(cfg.requiredSiteKey).toBeDefined()
  })

  it('offers only 1K/2K and defaults to 2K (same tiers as 5.0 Pro)', () => {
    expect(cfg.resolutions?.map((r) => r.key)).toEqual(['1K', '2K'])
    expect(cfg.defaultResolution).toBe('2K')
  })

  it('is single-output only', () => {
    expect(cfg.capabilities?.maxOutputs).toBe(1)
    expect(cfg.capabilities?.multipleImages).toBe(false)
    expect(cfg.defaultParams?.sequential_image_generation).toBeUndefined()
    expect(cfg.defaultParams?.stream).toBeUndefined()
  })

  it('supports reference images, image editing and layer decomposition', () => {
    expect(cfg.capabilities?.referenceImage).toBe(true)
    expect(cfg.capabilities?.imageEdit).toBe(true)
    expect(cfg.capabilities?.layerDecomposition).toBe(true)
  })

  it('does not claim a reference-image cap it has not verified', () => {
    expect(cfg.capabilities?.maxReferenceImages).toBeUndefined()
  })

  it('sits right after 5.0 Pro in the model dropdown and is not mistaken for it', () => {
    const keys = Object.keys(service.getAllModels())
    expect(keys.indexOf('doubao-seedream-5-5-261028')).toBe(keys.indexOf('doubao-seedream-5-0-pro-260628') + 1)
    expect(cfg.name).toBe('Seedream 5.5')
    expect(cfg.name).not.toBe(service.getModelConfig('doubao-seedream-5-0-pro-260628')!.name)
  })
})

describe('ApiService Seedream 5.5 request payload', () => {
  const service = new ApiService()
  const cfg = new ApiService().getModelConfig('doubao-seedream-5-5-261028')!

  function build(options: Record<string, unknown>) {
    return (service as any).buildOpenAIPayload({
      model: 'doubao-seedream-5-5-261028',
      modelConfig: cfg,
      count: 1,
      ...options,
    })
  }

  it('builds a text-to-image payload with the 5.5 model id and pixel size', () => {
    const payload = build({ prompt: '写实城市夜景', ratio: '16:9', resolution: '2K' })
    expect(payload.model).toBe('doubao-seedream-5-5-261028')
    expect(payload.prompt).toBe('写实城市夜景')
    expect(payload.size).toBe('2560x1440')
    expect(payload.n).toBe(1)
    expect(payload.sequential_image_generation).toBeUndefined()
    expect(payload.stream).toBeUndefined()
    expect(payload.parameters).toBeUndefined()
    expect(payload.input).toBeUndefined()
  })

  it('sends a single reference via `image` only, several via `image` + `images`', () => {
    const one = 'https://cos.example.com/ref-1.png'
    const single = build({ prompt: 'a', ratio: '1:1', resolution: '2K', referenceImages: [one] })
    expect(single.image).toBe(one)
    expect(single.images).toBeUndefined()

    const refs = ['https://cos.example.com/ref-1.png', 'https://cos.example.com/ref-2.png']
    const multi = build({ prompt: 'a', ratio: '1:1', resolution: '2K', referenceImages: refs })
    expect(multi.image).toBe(refs[0])
    expect(multi.images).toEqual(refs)
  })

  it('clamps count to 1 and an unsupported 4K to the 2K default', () => {
    expect(build({ prompt: 'a', ratio: '1:1', resolution: '2K', count: 4 }).n).toBe(1)
    expect(build({ prompt: 'a', ratio: '16:9', resolution: '4K' }).size).toBe('2560x1440')
  })

  it('does NOT inline COS/URL reference images into base64 (URL 直传给上游)', async () => {
    const { wantsInlineBase64ForModel } = await import('../../../utils/refImageStrategy')
    expect(wantsInlineBase64ForModel(cfg)).toBe(false)
  })
})
