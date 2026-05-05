import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('ApiService.gpt-image-2-vip size resolution', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('registers gpt-image-2-vip in DEFAULT_MODELS with 11 ratios (auto + 10)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')
    expect(cfg).toBeDefined()
    expect(cfg?.name).toBe('GPT Image 2 VIP')
    expect(cfg?.sizeStrategy).toBe('gpt-image-2-vip')
    expect(cfg?.ratios).toHaveLength(11)
    expect(cfg?.resolutions?.map((r) => r.key)).toEqual(['1K', '2K', '4K'])
    expect(cfg?.defaultResolution).toBe('1K')
  })

  it('resolves 16:9 @ 2K to "2752x1536" (ASCII x, not Unicode ×)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '16:9', '2K')).toBe('2752x1536')
  })

  it('resolves all 10 ratios at 1K to non-empty pixel strings', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:4', '4:5']
    for (const r of ratios) {
      const size = resolve(cfg, r, '1K')
      expect(size).toMatch(/^\d+x\d+$/)
    }
  })

  it('returns undefined for ratio="auto" (no size sent, backend decides)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, 'auto', '2K')).toBeUndefined()
    expect(resolve(cfg, undefined, '2K')).toBeUndefined()
  })

  it('falls back to defaultResolution (1K) when resolution is omitted', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '1:1')).toBe('1024x1024')
  })

  it('returns undefined for unknown ratio key', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('gpt-image-2-vip')!
    const resolve = (service as any).resolveGptImage2VipSize.bind(service)
    expect(resolve(cfg, '7:2', '1K')).toBeUndefined()
  })
})

describe('ApiService.gpt-image-2-vip JSON payload', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes size and output_format, excludes quality and response_format', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2-vip', 'a cat', '1376x768', 'high')
    expect(payload).toMatchObject({
      model: 'gpt-image-2-vip',
      prompt: 'a cat',
      size: '1376x768',
      output_format: 'png',
    })
    expect((payload as any).quality).toBeUndefined()
    expect((payload as any).response_format).toBeUndefined()
  })

  it('omits size when value is "auto"', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const build = (service as any).buildGptImage2JsonPayload.bind(service)
    const payload = build('gpt-image-2-vip', 'a cat', 'auto')
    expect((payload as any).size).toBeUndefined()
  })
})
