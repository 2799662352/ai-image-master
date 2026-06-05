import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * gpt-image-2（官转）三参数化（比例 × 分辨率 × 清晰度）回归测试。
 *
 * 背景：gpt-image-2-vip 触发 OpenAI 组织级 input-images 限速，需要能无缝切到官转
 * gpt-image-2。官转的 size 与 vip 完全兼容（vip 30 档 size 均满足官转的合法尺寸约束），
 * 但官转额外支持 quality（auto/low/medium/high）。
 *
 * 目标形态（与 vip 对齐 + 多一个 quality 轴）：
 *  - 比例 ratio：auto + 10 比例（与 vip 一致）
 *  - 分辨率 resolution：1K / 2K / 4K（与 vip 一致），ratio × resolution → size
 *  - 清晰度 quality：auto / low / medium / high（官转独有，单独一个参数）
 *
 * size 解析必须复用同一个 resolveImageSizeFromMap（vip 与官转共用），
 * quality 解析改读独立的 quality 参数（不再借用 resolution）。
 */

// 官转 size 必须落在与 vip 一致的 30 档（这些 size 同时满足官转合法尺寸约束）
const OFFICIAL_30_SIZES = new Set([
  '1280x1280', '848x1280', '1280x848', '960x1280', '1280x960',
  '1024x1280', '1280x1024', '720x1280', '1280x720', '1280x544',
  '2048x2048', '1360x2048', '2048x1360', '1536x2048', '2048x1536',
  '1632x2048', '2048x1632', '1152x2048', '2048x1152', '2048x864',
  '2880x2880', '2336x3520', '3520x2336', '2480x3312', '3312x2480',
  '2560x3216', '3216x2560', '2160x3840', '3840x2160', '3840x1632',
])

const RATIOS_10 = [
  '1:1', '2:3', '3:2', '3:4', '4:3',
  '4:5', '5:4', '9:16', '16:9', '21:9',
]
const TIERS = ['1K', '2K', '4K']

describe('ApiService.gpt-image-2 三参数 config', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('registers gpt-image-2 with 11 ratios (auto + 10) aligned with vip', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2')
    expect(cfg).toBeDefined()
    expect(cfg?.name).toBe('GPT Image 2')
    expect(cfg?.ratios).toHaveLength(11)
    expect(cfg?.ratios?.map((r) => r.key)).toEqual([
      'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:4', '4:5',
    ])
  })

  it('separates resolution (1K/2K/4K) from the quality axis', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2')!
    // resolution 轴 = 1K/2K/4K（与 vip 一致），不再是 low/medium/high
    expect(cfg.resolutions?.map((r) => r.key)).toEqual(['1K', '2K', '4K'])
    expect(cfg.defaultResolution).toBe('1K')
  })

  it('exposes an independent quality axis (auto/low/medium/high) default auto', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2')!
    expect(cfg.qualities?.map((q) => q.key)).toEqual(['auto', 'low', 'medium', 'high'])
    expect(cfg.defaultQuality).toBe('auto')
    expect(cfg.capabilities?.qualityControl).toBe(true)
  })

  it('still exposes resolutionControl + aspectRatioControl', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2')!
    expect(cfg.capabilities?.resolutionControl).toBe(true)
    expect(cfg.capabilities?.aspectRatioControl).toBe(true)
  })
})

describe('ApiService.gpt-image-2 size 解析（与 vip 共用 resolveImageSizeFromMap）', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it.each(RATIOS_10.flatMap(ratio => TIERS.map(tier => [ratio, tier] as const)))(
    'resolves %s @ %s to a size in the 30-enum',
    async (ratio, tier) => {
      const { ApiService } = await import('../ApiService')
      const service = new ApiService()
      const cfg = service.getModelConfig('gpt-image-2')!
      const resolve = (service as any).resolveImageSizeFromMap.bind(service)
      const size = resolve(cfg, ratio, tier)
      expect(size, `${ratio}@${tier} 没解析出 size`).toBeDefined()
      expect(
        OFFICIAL_30_SIZES.has(size),
        `${ratio}@${tier} 解析为 ${size}, 不在 30 档枚举内`,
      ).toBe(true)
    },
  )

  it('resolves 1:1 @ 1K to 1280x1280 (与 vip 同体系)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2')!
    const resolve = (service as any).resolveImageSizeFromMap.bind(service)
    expect(resolve(cfg, '1:1', '1K')).toBe('1280x1280')
  })

  it('resolves 16:9 @ 4K to 3840x2160', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2')!
    const resolve = (service as any).resolveImageSizeFromMap.bind(service)
    expect(resolve(cfg, '16:9', '4K')).toBe('3840x2160')
  })

  it('returns undefined for ratio="auto" (官转 size=auto 不发)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2')!
    const resolve = (service as any).resolveImageSizeFromMap.bind(service)
    expect(resolve(cfg, 'auto', '2K')).toBeUndefined()
  })

  it('resolveGptImage2VipSize 仍可用（向后兼容别名，委托给共用函数）', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const vipCfg = service.getModelConfig('gpt-image-2-vip')!
    const vipResolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(vipResolve(vipCfg, '1:1', '1K')).toBe('1280x1280')
  })
})

describe('ApiService.gpt-image-2 quality 解析（独立 quality 参数）', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('maps low/medium/high to themselves, auto/empty to undefined', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const resolve = (service as any).resolveGptImage2Quality.bind(service)
    expect(resolve('low')).toBe('low')
    expect(resolve('medium')).toBe('medium')
    expect(resolve('high')).toBe('high')
    expect(resolve('auto')).toBeUndefined()
    expect(resolve(undefined)).toBeUndefined()
    expect(resolve('garbage')).toBeUndefined()
  })
})

describe('ApiService.gpt-image-2 JSON payload', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes both size and quality for 官转', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2', 'a cat', '2048x1152', 'high')
    expect(payload).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'a cat',
      size: '2048x1152',
      quality: 'high',
    })
  })

  it('omits quality when it resolves to undefined (auto)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2', 'a cat', '2048x1152', undefined)
    expect((payload as any).quality).toBeUndefined()
    expect((payload as any).size).toBe('2048x1152')
  })
})
