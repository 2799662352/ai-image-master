import { describe, expect, it } from 'vitest'
import { ApiService } from '../ApiService'

/**
 * Nano Banana 2.1(gemini-nano-banana-2.1,apiyi 2026-10-06 上线)。
 * 契约来自 https://docs.apiyi.com/api-capabilities/gemini-nano-banana-2.1/overview:
 * - 谷歌原生 `:generateContent`,请求/返回结构与 Nano Banana 2 相同;
 * - imageSize 只有 1K / 2K / 4K —— 传 "512" 直接 400,沿用 Nano2 的 0.5K 档会必挂;
 * - 14 种宽高比,8:1 在 1K 下是 2928×352(与 Nano2 不同)。
 */
describe('ApiService Nano Banana 2.1 model config', () => {
  const service = new ApiService()
  const cfg = service.getModelConfig('gemini-nano-banana-2.1')!

  it('is a gemini-native model on its own endpoint, with base64 inline refs', () => {
    expect(cfg).toBeDefined()
    expect(cfg.apiType).toBe('gemini-native')
    expect(cfg.vendor).toBe('google')
    expect(cfg.baseURL).toMatch(/\/v1beta\/models\/gemini-nano-banana-2\.1:generateContent$/)
    expect(cfg.inlineRefImageAsBase64).toBe(true)
  })

  it('offers 1K/2K/4K only — no 0.5K (upstream rejects imageSize 512)', () => {
    expect(cfg.resolutions?.map((r) => r.key)).toEqual(['1K', '2K', '4K'])
    expect(cfg.defaultResolution).toBe('1K')
    for (const row of Object.values(cfg.resolutionMap ?? {})) {
      expect(Object.keys(row)).not.toContain('0.5K')
    }
  })

  it('lists the 14 documented aspect ratios plus auto', () => {
    expect(cfg.ratios?.map((r) => r.key).sort()).toEqual(
      ['auto', '1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].sort(),
    )
    expect(cfg.resolutionMap?.['8:1']?.['1K']).toBe('2928×352')
    expect(cfg.resolutionMap?.['16:9']?.['4K']).toBe('5504×3072')
  })

  it('sends imageSize and aspectRatio explicitly in generationConfig.imageConfig', () => {
    const payload = (service as unknown as {
      buildGeminiNativePayload(o: Record<string, unknown>): any
    }).buildGeminiNativePayload({
      prompt: '一只猫',
      ratio: '3:4',
      resolution: '2K',
      referenceImages: ['data:image/jpeg;base64,AAAA'],
      modelConfig: cfg,
    })

    expect(payload.generationConfig.imageConfig).toEqual({ aspectRatio: '3:4', imageSize: '2K' })
    // 一个 part 只放 text 或 inline_data 之一:1 个文本段 + N 个图片段。
    const parts = payload.contents[0].parts
    expect(parts[0]).toEqual({ text: '生成图片：一只猫' })
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } })
  })

  it('has a receipt price so the cost estimate is not read from displayName', () => {
    expect(cfg.price).toBeGreaterThan(0)
  })
})
