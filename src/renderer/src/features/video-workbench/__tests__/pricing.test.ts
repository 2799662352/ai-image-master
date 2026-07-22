// 计费估算单测 —— 口径 pin 自 seedance-openapi-ark-2026-07-22.md 文档 9.2/9.3。

import { describe, expect, it } from 'vitest'
import { estimateCostUsd, formatCostUsd, unitPriceUsd } from '../pricing'

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
