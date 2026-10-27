import { describe, expect, it } from 'vitest'
import {
  DAMO_ALGOS,
  DAMO_FPS,
  DAMO_RESOLUTIONS,
  DEFAULT_ENHANCE_SPEC,
  coerceEnhanceSpec,
  damoModelName,
  damoPriceYuan,
  enhanceModelFor,
  enhancePriceYuan,
  enhanceSpecLabel,
} from '../videoEnhance'

describe('videoEnhance', () => {
  it('模型名与 new-api 的 damo-aisr-%s-%s-%dfps 一致', () => {
    expect(damoModelName({ algo: 'pro', resolution: '4k', fps: 60 })).toBe('damo-aisr-pro-4k-60fps')
    expect(enhanceModelFor({ provider: 'volc' })).toBe('volc-enhance-video')
    expect(enhanceModelFor(undefined)).toBe('volc-enhance-video')
  })

  /**
   * 价格表镜像网关源码 `relay/channel/aisr/constants.go`。这里把那张表的**规律**
   * 钉死(pro = 3× standard,帧率翻倍价格翻倍,分辩率阶梯),外加几个锚点数字
   * (2026-09-01 测试网关 /api/pricing 实测)。改一个数就得两边一起改。
   */
  it('DAMO 价格表与网关一致:锚点数字', () => {
    expect(damoPriceYuan({ algo: 'standard', resolution: '720p', fps: 30 })).toBe(2)
    expect(damoPriceYuan({ algo: 'standard', resolution: '4k', fps: 30 })).toBe(16)
    expect(damoPriceYuan({ algo: 'pro', resolution: '2k', fps: 60 })).toBe(48)
    expect(damoPriceYuan({ algo: 'pro', resolution: '8k', fps: 120 })).toBe(768)
  })

  it('DAMO 价格表与网关一致:规律', () => {
    for (const resolution of DAMO_RESOLUTIONS) {
      for (const fps of DAMO_FPS) {
        const s = damoPriceYuan({ algo: 'standard', resolution, fps })
        const p = damoPriceYuan({ algo: 'pro', resolution, fps })
        expect(p).toBe(s * 3)
      }
      for (const algo of DAMO_ALGOS) {
        expect(damoPriceYuan({ algo, resolution, fps: 60 })).toBe(damoPriceYuan({ algo, resolution, fps: 30 }) * 2)
        expect(damoPriceYuan({ algo, resolution, fps: 120 })).toBe(damoPriceYuan({ algo, resolution, fps: 60 }) * 2)
      }
    }
  })

  it('30 个 SKU 一个不多一个不少', () => {
    const names = new Set<string>()
    for (const algo of DAMO_ALGOS) for (const resolution of DAMO_RESOLUTIONS) for (const fps of DAMO_FPS) {
      names.add(damoModelName({ algo, resolution, fps }))
    }
    expect(names.size).toBe(30)
  })

  it('火山 ¥0.1 是默认,也是最便宜', () => {
    expect(enhancePriceYuan(DEFAULT_ENHANCE_SPEC)).toBe(0.1)
    expect(enhancePriceYuan({ provider: 'damo', algo: 'standard', resolution: '720p', fps: 30 })).toBeGreaterThan(0.1)
  })

  /** 认不出就当火山 —— 误判成 DAMO 某档可能一下扣几百,方向不对称。 */
  it('不可信载荷收敛:非法值一律回火山', () => {
    expect(coerceEnhanceSpec(undefined)).toEqual({ provider: 'volc' })
    expect(coerceEnhanceSpec({ provider: 'damo' })).toEqual({ provider: 'volc' })
    expect(coerceEnhanceSpec({ provider: 'damo', algo: 'ultra', resolution: '4k', fps: 30 })).toEqual({ provider: 'volc' })
    expect(coerceEnhanceSpec({ provider: 'damo', algo: 'pro', resolution: '4k', fps: '30' })).toEqual({ provider: 'volc' })
    expect(coerceEnhanceSpec({ provider: 'damo', algo: 'pro', resolution: '4k', fps: 30 }))
      .toEqual({ provider: 'damo', algo: 'pro', resolution: '4k', fps: 30 })
  })

  it('标签', () => {
    expect(enhanceSpecLabel(undefined)).toBe('火山')
    expect(enhanceSpecLabel({ provider: 'damo', algo: 'standard', resolution: '1080p', fps: 30 })).toBe('DAMO 标准 1080P 30fps')
  })
})
