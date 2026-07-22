// Seedance 视频生成计费估算 —— 文档 9.2 官方价格表(2026-07-22 口径)。
// 费用 = completion_tokens / 1_000_000 × 单价;单价按 模型 × 分辨率档 × 是否含视频输入。

import type { SeedanceModelAlias } from '../../../../types/seedance'

/** $ / 1M tokens。standard = 480p/720p;fhd = 1080p(仅 2.0 满血有此档)。 */
const PRICE_TABLE: Record<
  SeedanceModelAlias,
  { standard: { noVideo: number; withVideo: number }; fhd?: { noVideo: number; withVideo: number } }
> = {
  '2.0': {
    standard: { noVideo: 7.0, withVideo: 4.3 },
    fhd: { noVideo: 7.7, withVideo: 4.7 },
  },
  '2.0-fast': {
    standard: { noVideo: 5.6, withVideo: 3.3 },
  },
  '2.0-mini': {
    standard: { noVideo: 3.5, withVideo: 2.1 },
  },
}

/** 单价($/1M tokens)。未知组合(如 fast/mini 配 1080p)返回 null。 */
export function unitPriceUsd(
  model: SeedanceModelAlias,
  resolution: string,
  hasVideoInput: boolean,
): number | null {
  const entry = PRICE_TABLE[model]
  if (!entry) return null
  const tier = resolution === '1080p' ? entry.fhd : entry.standard
  if (!tier) return null
  return hasVideoInput ? tier.withVideo : tier.noVideo
}

/** 按上游回传的 completion_tokens 估算本次费用(USD)。无法估算返回 null。 */
export function estimateCostUsd(
  model: SeedanceModelAlias,
  resolution: string,
  hasVideoInput: boolean,
  completionTokens: number | undefined,
): number | null {
  if (typeof completionTokens !== 'number' || !Number.isFinite(completionTokens) || completionTokens <= 0) {
    return null
  }
  const price = unitPriceUsd(model, resolution, hasVideoInput)
  if (price == null) return null
  return (completionTokens / 1_000_000) * price
}

/** 展示格式:$0.056(3 位小数,<0.001 显示 <$0.001)。 */
export function formatCostUsd(cost: number): string {
  if (cost > 0 && cost < 0.001) return '<$0.001'
  return `$${cost.toFixed(3)}`
}
