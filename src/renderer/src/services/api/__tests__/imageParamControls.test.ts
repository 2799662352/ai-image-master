import { describe, it, expect } from 'vitest'
import {
  deriveImageParamControls,
  normalizeOption,
  FALLBACK_RATIO_OPTIONS,
  FALLBACK_RESOLUTION_OPTIONS,
  type ImageParamModelConfig,
} from '../imageParamControls'
import { ApiService } from '../ApiService'

// 从真实服务里取模型表，而不是 export 一份内部常量出来给测试用 —— 后者会把私有
// 配置表变成公开面。getModelConfig 本来就是消费端（UI / AgentToolExecutor）走的那条路。
const models = new ApiService()
const configOf = (key: string) =>
  (models as unknown as { getModelConfig: (k: string) => ImageParamModelConfig }).getModelConfig(key)

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

  it('gpt-image-2.5-flare 五档 quality(无 auto)且默认 high, 有透明底轴', () => {
    const c = deriveImageParamControls(configOf('gpt-image-2.5-flare'))
    expect(c.supportsQuality).toBe(true)
    expect(c.qualityOptions.map((o) => o.key)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(c.defaultQuality).toBe('high')
    expect(c.sizeHidden).toBe(false)
    expect(c.supportsTransparentBackground).toBe(true)
  })

  it('gpt-image-2.5-all 走 prompt size, 无 quality 轴, 无透明底轴', () => {
    const c = deriveImageParamControls(configOf('gpt-image-2.5-all'))
    expect(c.sizeHidden).toBe(true)
    expect(c.supportsQuality).toBe(false)
    expect(c.supportsTransparentBackground).toBe(false)
  })

  it('透明底轴只跟 transparentBackgroundControl 能力位走 —— 腾讯 / gpt-image-2 都没有', () => {
    expect(deriveImageParamControls(configOf('custom-imagemodel-gt')).supportsTransparentBackground).toBe(false)
    expect(deriveImageParamControls(configOf('gpt-image-2')).supportsTransparentBackground).toBe(false)
    expect(deriveImageParamControls(null).supportsTransparentBackground).toBe(false)
  })

  /**
   * 数量轴是从真实模型表派生的，所以这里直接拿 DEFAULT_MODELS 里的千问配置来验 ——
   * 手写一份 capabilities 只能证明函数会算，证明不了那张表填对了。千问官方 n 是 1-6，
   * 早先照 Seedream 抄成 1，界面上就只有「1 张」这一个选项。
   */
  it('千问 3.0 Pro 的数量轴给到 1-6（而不是被 maxOutputs:1 卡死）', () => {
    const c = deriveImageParamControls(configOf('qwen-image-3.0-pro'))
    expect(c.supportsCount).toBe(true)
    expect(c.maxCount).toBe(6)
  })

  it('只出单图的渠道不冒出数量轴 —— 别给没有的能力加个选择器', () => {
    const c = deriveImageParamControls(configOf('doubao-seedream-5-0-pro-260628'))
    expect(c.supportsCount).toBe(false)
    expect(c.nativeBatch).toBe(false)
  })

  /**
   * 官转原生多图:apiyi 生图页给 gpt-image-2 / 2.5 开了 n=1–4,数量轴标「原生支持」并提示
   * 按张数倍数计费。这里从真实模型表取,证明那三条 + 腾讯 image2 fast 的表填对了。
   */
  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'custom-model-og-v2'])(
    '%s 的数量轴是 1-4 原生多图(nativeBatch)',
    (id) => {
      const c = deriveImageParamControls(configOf(id))
      expect(c.supportsCount).toBe(true)
      expect(c.maxCount).toBe(4)
      expect(c.nativeBatch).toBe(true)
    },
  )

  it('万相组图 / 千问变体有数量轴但不是「原生支持」文案位', () => {
    for (const id of ['wan2.7-image-pro', 'qwen-image-3.0-pro']) {
      const c = deriveImageParamControls(configOf(id))
      expect(c.supportsCount, id).toBe(true)
      expect(c.nativeBatch, id).toBe(false)
    }
  })

  it('-all / vip / 腾讯 image2 单图渠道:无数量轴、无原生多图位', () => {
    for (const id of ['gpt-image-2.5-all', 'gpt-image-2-vip', 'custom-imagemodel-gt']) {
      const c = deriveImageParamControls(configOf(id))
      expect(c.supportsCount, id).toBe(false)
      expect(c.nativeBatch, id).toBe(false)
    }
  })

  it('只打 nativeBatch 忘了 multipleImages 也放行数量轴;maxOutputs 1 时 nativeBatch 归 false', () => {
    const only = deriveImageParamControls({ capabilities: { nativeBatch: true, maxOutputs: 4 } })
    expect(only.supportsCount).toBe(true)
    expect(only.nativeBatch).toBe(true)
    const single = deriveImageParamControls({ capabilities: { nativeBatch: true, maxOutputs: 1 } })
    expect(single.supportsCount).toBe(false)
    expect(single.nativeBatch).toBe(false)
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
