import { describe, it, expect } from 'vitest'
import { ApiService } from '../ApiService'

/**
 * Seedream 5.0 Pro(doubao-seedream-5-0-pro-260628,火山豆包经 Miau 网关)。
 * 契约来自接入文档(seedream-5.0-pro-api-guide.md):
 * - OpenAI 兼容 /v1/images/generations;参考图走顶层 image(首张)+ images(全部,≤10);
 * - size 用像素方式(文档 §7 映射表,1K/2K 两档,无 4K);
 * - Pro 不支持 sequential_image_generation / stream / tools / n>1,从源头不发。
 */
describe('ApiService Seedream 5.0 Pro model config', () => {
  const service = new ApiService()
  const cfg = service.getModelConfig('doubao-seedream-5-0-pro-260628')!

  it('is registered as an image-generation model with seedream size strategy', () => {
    expect(cfg).toBeDefined()
    expect(cfg.apiType).toBe('image-generation')
    expect(cfg.sizeStrategy).toBe('seedream')
    expect(cfg.baseURL).toContain('/v1/images/generations')
  })

  it('offers only 1K/2K resolutions (Pro has no 4K) and defaults to 2K', () => {
    expect(cfg.resolutions?.map((r) => r.key)).toEqual(['1K', '2K'])
    expect(cfg.defaultResolution).toBe('2K')
  })

  it('is single-output only (Pro rejects n / sequential generation)', () => {
    expect(cfg.capabilities?.maxOutputs).toBe(1)
    expect(cfg.capabilities?.multipleImages).toBe(false)
    expect(cfg.defaultParams?.sequential_image_generation).toBeUndefined()
    expect(cfg.defaultParams?.stream).toBeUndefined()
  })
})

describe('ApiService Seedream 5.0 Pro request payload', () => {
  const service = new ApiService()
  const cfg = new ApiService().getModelConfig('doubao-seedream-5-0-pro-260628')!

  function build(options: Record<string, unknown>) {
    return (service as any).buildOpenAIPayload({
      model: 'doubao-seedream-5-0-pro-260628',
      modelConfig: cfg,
      count: 1,
      ...options,
    })
  }

  it('builds text-to-image payload with pixel size from the doc §7 map (2K default)', () => {
    const payload = build({ prompt: '写实城市夜景', ratio: '16:9', resolution: '2K' })
    expect(payload.model).toBe('doubao-seedream-5-0-pro-260628')
    expect(payload.prompt).toBe('写实城市夜景')
    expect(payload.size).toBe('2560x1440')
    expect(payload.n).toBe(1)
    // Pro 不支持的字段绝不出现
    expect(payload.sequential_image_generation).toBeUndefined()
    expect(payload.stream).toBeUndefined()
    expect(payload.parameters).toBeUndefined()
    expect(payload.input).toBeUndefined()
  })

  it('maps 1K tiers with Seedream 5.0 pixel edges (not the generic hard-coded table)', () => {
    // 通用硬编码表 16:9/1K = 1376x768,与 5.0 Pro 文档一致;但 4:5/5:4 只有模型表有。
    expect(build({ prompt: 'a', ratio: '4:5', resolution: '1K' }).size).toBe('928x1152')
    expect(build({ prompt: 'a', ratio: '5:4', resolution: '2K' }).size).toBe('2240x1792')
    expect(build({ prompt: 'a', ratio: '1:1', resolution: '1K' }).size).toBe('1024x1024')
  })

  it('sends a single reference image via top-level `image` only', () => {
    const ref = 'https://cos.example.com/image-history/ref-1.png'
    const payload = build({ prompt: '换成赛博朋克夜景', ratio: '1:1', resolution: '2K', referenceImages: [ref] })
    expect(payload.image).toBe(ref)
    expect(payload.images).toBeUndefined()
  })

  it('sends multiple reference images as `image` (first) + `images` (all), per gateway BFF contract', () => {
    const refs = [
      'https://cos.example.com/ref-1.png',
      'https://cos.example.com/ref-2.png',
      'https://cos.example.com/ref-3.png',
    ]
    const payload = build({ prompt: '融合角色与场景', ratio: '1:1', resolution: '2K', referenceImages: refs })
    expect(payload.image).toBe(refs[0])
    expect(payload.images).toEqual(refs)
  })

  it('clamps count to 1 (Pro is single-image; count must not leak as n>1)', () => {
    const payload = build({ prompt: 'a', ratio: '1:1', resolution: '2K', count: 4 })
    expect(payload.n).toBe(1)
  })

  it('clamps an unsupported 4K request to the model default (2K) instead of generic-table pixels', () => {
    // MCP 的 resolution 参数全局允许 4K;5.0 Pro 无 4K 档,须收敛到 defaultResolution,
    // 绝不能从通用硬编码表发出 5120x2880 这种上游不支持的尺寸。
    expect(build({ prompt: 'a', ratio: '16:9', resolution: '4K' }).size).toBe('2560x1440')
    expect(build({ prompt: 'a', ratio: '1:1', resolution: '4K' }).size).toBe('2048x2048')
  })

  it('does NOT inline COS/URL reference images into base64 (URL 直传给上游)', async () => {
    const { wantsInlineBase64ForModel } = await import('../../../utils/refImageStrategy')
    expect(wantsInlineBase64ForModel(cfg)).toBe(false)
  })
})
