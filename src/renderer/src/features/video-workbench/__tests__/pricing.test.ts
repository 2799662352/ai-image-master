// 计费估算单测 —— 口径 pin 自 seedance-openapi-ark-2026-07-22.md 文档 9.2/9.3。

import { describe, expect, it } from 'vitest'
import {
  type CostCardLike,
  estimateCostUsd,
  formatCostUsd,
  summarizeCostUsd,
  unitPriceUsd,
} from '../pricing'

describe('unitPriceUsd(文档 9.2 价格表)', () => {
  it('2.0:标准档/1080p × 是否含视频', () => {
    expect(unitPriceUsd('2.0', '720p', false)).toBe(7.0)
    expect(unitPriceUsd('2.0', '480p', true)).toBe(4.3)
    expect(unitPriceUsd('2.0', '1080p', false)).toBe(7.7)
    expect(unitPriceUsd('2.0', '1080p', true)).toBe(4.7)
  })

  it('fast/mini 只有标准档;1080p 返回 null', () => {
    expect(unitPriceUsd('2.0-fast', '720p', false)).toBe(5.6)
    expect(unitPriceUsd('2.0-fast', '720p', true)).toBe(3.3)
    expect(unitPriceUsd('2.0-mini', '480p', false)).toBe(3.5)
    expect(unitPriceUsd('2.0-mini', '720p', true)).toBe(2.1)
    expect(unitPriceUsd('2.0-fast', '1080p', false)).toBeNull()
    expect(unitPriceUsd('2.0-mini', '1080p', true)).toBeNull()
  })
})

describe('estimateCostUsd(文档 9.3 示例)', () => {
  it('示例 1:fast 720p 无视频 10000 tokens = $0.056', () => {
    expect(estimateCostUsd('2.0-fast', '720p', false, 10_000)).toBeCloseTo(0.056, 6)
  })

  it('示例 2:2.0 1080p 含视频 10000 tokens = $0.047', () => {
    expect(estimateCostUsd('2.0', '1080p', true, 10_000)).toBeCloseTo(0.047, 6)
  })

  it('示例 3:mini 720p 无视频 10000 tokens = $0.035', () => {
    expect(estimateCostUsd('2.0-mini', '720p', false, 10_000)).toBeCloseTo(0.035, 6)
  })

  it('无 tokens / 未知组合返回 null', () => {
    expect(estimateCostUsd('2.0', '720p', false, undefined)).toBeNull()
    expect(estimateCostUsd('2.0', '720p', false, 0)).toBeNull()
    expect(estimateCostUsd('2.0-mini', '1080p', false, 10_000)).toBeNull()
  })
})

describe('formatCostUsd', () => {
  it('常规 3 位小数;极小值显示 <$0.001', () => {
    expect(formatCostUsd(0.056)).toBe('$0.056')
    expect(formatCostUsd(0.0004)).toBe('<$0.001')
  })
})

describe('summarizeCostUsd(跨卡汇总)', () => {
  const card = (patch: Partial<CostCardLike> = {}): CostCardLike => ({
    model: '2.0-fast',
    resolution: '720p',
    status: 'succeeded',
    completionTokens: 10_000,
    ...patch,
  })
  const noVideo = () => false

  it('把能定价的卡加起来,并与单卡口径一致', () => {
    const s = summarizeCostUsd([card(), card(), card()], noVideo)
    expect(s.counted).toBe(3)
    expect(s.unpriced).toBe(0)
    // 单卡 $0.056 × 3
    expect(s.usd).toBeCloseTo(0.056 * 3, 6)
  })

  it('hasVideoInput 走调用方注入 —— 含视频输入单价更低', () => {
    const cards = [card()]
    const without = summarizeCostUsd(cards, () => false).usd
    const withVideo = summarizeCostUsd(cards, () => true).usd
    expect(withVideo).toBeLessThan(without)
    expect(withVideo).toBeCloseTo(0.033, 6)
  })

  it('未跑的卡不计入,也不算「算不出」', () => {
    const s = summarizeCostUsd(
      [
        card({ status: 'draft', completionTokens: undefined }),
        card({ status: 'queued', completionTokens: undefined }),
        card({ status: 'running', completionTokens: undefined }),
      ],
      noVideo,
    )
    expect(s).toEqual({ usd: 0, counted: 0, unpriced: 0 })
  })

  it('出了片但没回传 tokens → 记进 unpriced(钱花了,算不出)', () => {
    const s = summarizeCostUsd([card({ completionTokens: undefined })], noVideo)
    expect(s.counted).toBe(0)
    expect(s.unpriced).toBe(1)
  })

  it('价目表没有的组合(mini + 1080p)→ 记进 unpriced 而不是当成 0', () => {
    const s = summarizeCostUsd([card({ model: '2.0-mini', resolution: '1080p' })], noVideo)
    expect(s.usd).toBe(0)
    expect(s.counted).toBe(0)
    expect(s.unpriced).toBe(1)
  })

  it('失败但有 tokens 的卡照算 —— running 阶段失败上游仍计费', () => {
    const s = summarizeCostUsd([card({ status: 'failed' })], noVideo)
    expect(s.counted).toBe(1)
    expect(s.usd).toBeCloseTo(0.056, 6)
  })

  it('空列表返回全零', () => {
    expect(summarizeCostUsd([], noVideo)).toEqual({ usd: 0, counted: 0, unpriced: 0 })
  })

  it('混合场景:合计只覆盖可定价部分,unpriced 如实计数', () => {
    const s = summarizeCostUsd(
      [
        card(),                                                   // 可定价
        card({ model: '2.0-mini', resolution: '1080p' }),          // 无单价
        card({ completionTokens: undefined }),                     // 出片无 tokens
        card({ status: 'draft', completionTokens: undefined }),     // 没跑
      ],
      noVideo,
    )
    expect(s.counted).toBe(1)
    expect(s.unpriced).toBe(2)
    expect(s.usd).toBeCloseTo(0.056, 6)
  })
})
