// 可灵 4.0 / 4.0 Omni 的费用估算。
//
// 口径出处:new-api #183(`klingResolutionRatios`:720P/1080P/2K/4K = 1 / 1.5 / 1.8 / 3.0,
// 以「无参考视频 720P」的 `model_price` 为基数),生产 `/api/pricing`(2026-10-28)两个模型
// `quota_type: 1`、`model_price: 1.20`。网关**不回传**出片秒数(`billed_seconds` 只在网关内部结算用),
// 所以这里按「所选时长 × 单价」估 —— 与万相按 `billedSeconds` 估是两条不同的路,不能混。

import { describe, expect, it } from 'vitest'
import {
  type CostCardLike,
  estimateKlingCostCny,
  klingCnyPerSecond,
  summarizeCostUsd,
  unitPriceCnyPerSecond,
  unitPriceUsd,
} from '../pricing'

describe('klingCnyPerSecond(无参考视频)', () => {
  it('基数 ¥1.2/秒(生产实测 model_price),按 1 / 1.5 / 1.8 / 3.0 放大', () => {
    expect(klingCnyPerSecond('720p')).toBeCloseTo(1.2, 6)
    expect(klingCnyPerSecond('1080p')).toBeCloseTo(1.8, 6)
    expect(klingCnyPerSecond('2k')).toBeCloseTo(2.16, 6)
    expect(klingCnyPerSecond('4k')).toBeCloseTo(3.6, 6)
  })

  it('大小写不敏感(网关同样不敏感);未知档位 / 480p 返回 null,不兜底', () => {
    expect(klingCnyPerSecond('1080P')).toBeCloseTo(1.8, 6)
    expect(klingCnyPerSecond('480p')).toBeNull()
    expect(klingCnyPerSecond('8k')).toBeNull()
  })
})

describe('estimateKlingCostCny', () => {
  it('费用 = 单价 × 所选时长', () => {
    expect(estimateKlingCostCny('kling4', '720p', 5, false)).toBeCloseTo(6, 6)
    expect(estimateKlingCostCny('kling4-omni', '1080p', 10, false)).toBeCloseTo(18, 6)
  })

  it('带参考视频算不出:计价秒数 = max(输入+输出, 2×输出),输入时长我们不知道 —— 返回 null 而不是编一个下限当总额', () => {
    expect(estimateKlingCostCny('kling4-omni', '720p', 5, true)).toBeNull()
  })

  it('时长缺失 / 非正 / 智能时长(-1)都算不出', () => {
    expect(estimateKlingCostCny('kling4', '720p', undefined, false)).toBeNull()
    expect(estimateKlingCostCny('kling4', '720p', 0, false)).toBeNull()
    expect(estimateKlingCostCny('kling4', '720p', -1, false)).toBeNull()
  })

  it('不是可灵就不估(别把万相 / Seedance 套进这条价)', () => {
    expect(estimateKlingCostCny('wan3', '720p', 5, false)).toBeNull()
    expect(estimateKlingCostCny('2.5', '720p', 5, false)).toBeNull()
  })
})

describe('可灵不污染别的估价路', () => {
  it('不是 token 计费:token 价目表对它返回 null', () => {
    expect(unitPriceUsd('kling4', '720p', false)).toBeNull()
    expect(unitPriceUsd('kling4-omni', '720p', true)).toBeNull()
  })

  it('不走万相的「每秒单价 × 回传秒数」那条路(那条靠上游回传的实际秒数,可灵没有)', () => {
    expect(unitPriceCnyPerSecond('kling4', '720p')).toBeNull()
    expect(unitPriceCnyPerSecond('kling4-omni', '1080p')).toBeNull()
  })
})

describe('summarizeCostUsd · 可灵', () => {
  const card = (over: Partial<CostCardLike> = {}): CostCardLike => ({
    model: 'kling4',
    resolution: '720p',
    duration: 5,
    status: 'succeeded',
    ...over,
  })
  const noVideo = () => false

  it('出片成功:按所选时长估价,计入 cny、不污染 usd', () => {
    const s = summarizeCostUsd([card(), card({ resolution: '1080p', duration: 10 })], noVideo)
    expect(s.usd).toBe(0)
    expect(s.cny).toBeCloseTo(6 + 18, 6)
    expect(s.counted).toBe(2)
    expect(s.unpriced).toBe(0)
  })

  it('没成功的卡不计入:网关对失败任务退款,草稿 / 进行中更没花钱', () => {
    for (const status of ['draft', 'queued', 'running', 'failed', 'cancelled']) {
      expect(summarizeCostUsd([card({ status })], noVideo)).toEqual({ usd: 0, cny: 0, counted: 0, unpriced: 0 })
    }
  })

  it('带参考视频的成功卡:钱花了但算不出 → unpriced(合计是下限),不装作没花钱', () => {
    const s = summarizeCostUsd([card({ model: 'kling4-omni' })], () => true)
    expect(s).toEqual({ usd: 0, cny: 0, counted: 0, unpriced: 1 })
  })

  it('卡上没有时长(老数据)同样记 unpriced', () => {
    const s = summarizeCostUsd([card({ duration: undefined })], noVideo)
    expect(s.unpriced).toBe(1)
  })

  it('可灵不会因为没有 completionTokens 被万相 / Seedance 那两条路误记', () => {
    const s = summarizeCostUsd([card({ completionTokens: undefined })], noVideo)
    expect(s.counted).toBe(1)
    expect(s.unpriced).toBe(0)
  })
})
