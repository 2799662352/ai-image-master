import { describe, it, expect } from 'vitest'
import {
  deriveImageParamControls,
  normalizeOption,
  FALLBACK_RATIO_OPTIONS,
  FALLBACK_RESOLUTION_OPTIONS,
} from '../imageParamControls'

describe('deriveImageParamControls', () => {
  it('gpt-image-2 三轴: 比例/清晰度(resolution)/质量(quality) 都暴露', () => {
    const c = deriveImageParamControls({
      ratios: [{ key: 'auto', label: '自适应' }, { key: '1:1', label: '方形' }],
      resolutions: [{ key: '1K' }, { key: '2K' }, { key: '4K' }],
      qualities: [
        { key: 'auto', label: '自动' },
        { key: 'low', label: '低' },
        { key: 'medium', label: '中' },
        { key: 'high', label: '高' },
      ],
      defaultResolution: '1K',
      defaultQuality: 'auto',
      capabilities: { resolutionControl: true, qualityControl: true },
    })
    expect(c.supportsResolution).toBe(true)
    expect(c.supportsQuality).toBe(true)
    expect(c.qualityOptions).toHaveLength(4)
    expect(c.resolutionOptions.map((o) => o.key)).toEqual(['1K', '2K', '4K'])
    expect(c.defaultResolution).toBe('1K')
    expect(c.defaultQuality).toBe('auto')
    expect(c.sizeHidden).toBe(false)
  })

  it('无 resolutions / 无 resolutionControl: supportsResolution=false, 回退分辨率列表', () => {
    const c = deriveImageParamControls({
      ratios: [{ key: '16:9' }],
      capabilities: { resolutionControl: false },
    })
    expect(c.supportsResolution).toBe(false)
    expect(c.resolutionOptions).toEqual(FALLBACK_RESOLUTION_OPTIONS)
  })

  it('无 qualities / 无 qualityControl: supportsQuality=false, qualityOptions 为空', () => {
    const c = deriveImageParamControls({
      ratios: [{ key: '16:9' }],
      resolutions: [{ key: '2K' }],
      capabilities: { resolutionControl: true },
    })
    expect(c.supportsQuality).toBe(false)
    expect(c.qualityOptions).toEqual([])
  })

  it('sizeStrategy=prompt: sizeHidden=true', () => {
    const c = deriveImageParamControls({ sizeStrategy: 'prompt' })
    expect(c.sizeHidden).toBe(true)
  })

  it('无 ratios: 回退到默认比例列表', () => {
    const c = deriveImageParamControls({})
    expect(c.ratioOptions).toEqual(FALLBACK_RATIO_OPTIONS)
  })

  it('null/undefined 输入安全', () => {
    const c = deriveImageParamControls(null)
    expect(c.ratioOptions).toEqual(FALLBACK_RATIO_OPTIONS)
    expect(c.supportsResolution).toBe(false)
    expect(c.supportsQuality).toBe(false)
  })
})

describe('normalizeOption (自动归位)', () => {
  const opts = [{ key: 'auto' }, { key: '16:9' }, { key: '1:1' }]

  it('当前值有效则保留', () => {
    expect(normalizeOption('16:9', opts)).toBe('16:9')
  })

  it('当前值无效, 优先用 prefer', () => {
    expect(normalizeOption('xxx', opts, '1:1')).toBe('1:1')
  })

  it('当前值无效且 prefer 也无效, 回退第一个', () => {
    expect(normalizeOption('xxx', opts, 'nope')).toBe('auto')
  })

  it('空选项返回当前值', () => {
    expect(normalizeOption('16:9', [])).toBe('16:9')
  })
})
