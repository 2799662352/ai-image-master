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
  // 2.5 没有 fhd 档（它只支持 480p/720p，文档 2.2.1），所以只填 standard。
  // 注意它的价差方向和 2.0 家族不同：不含视频比 2.0 更贵、含视频反而更便宜
  // （文档 9.2：$10.70 / $6.40，对 2.0 的 $7.0 / $4.3）。
  '2.5': {
    standard: { noVideo: 10.7, withVideo: 6.4 },
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

/** summarizeCostUsd 需要的最小卡片形状(不依赖 store,便于直接喂普通对象测)。 */
export interface CostCardLike {
  model: SeedanceModelAlias
  resolution: string
  completionTokens?: number
  status: string
}

export interface WorkbenchCostSummary {
  /** 能算出单价的卡片费用合计(USD)。 */
  usd: number
  /** 计入合计的卡片数。 */
  counted: number
  /**
   * **已经花了钱但算不出来**的卡片数。两种来源:上游没回传
   * completion_tokens(succeeded 但字段缺失,多为老数据),以及价目表里没有的组合
   * (如 fast/mini 配 1080p,unitPriceUsd 返回 null)。
   *
   * 这个数必须显示出来 —— 有它时 `usd` 是**下限**而不是总额,把它藏掉就是在报一个
   * 偏低的数字给用户看。
   */
  unpriced: number
}

/**
 * 跨卡费用汇总。
 *
 * **只能事后算,算不了预算。** 费用 = completion_tokens × 单价,而 completion_tokens
 * 是上游生成完才回传的 —— 生成前无从得知,除非自己造一个「分辨率 × 时长 × 帧率
 * → token」的近似模型,那是发明数据。所以这里只回答「已经花了多少」,不做超额拦截。
 *
 * `hasVideoInput` 由调用方注入(生产里是
 * `buildModeMedia(card).referenceVideos.length > 0`),与单卡显示走**同一条推导** ——
 * 含视频输入的单价明显更低(文档 9.2),两处若各算一次必然对不上。
 */
export function summarizeCostUsd<T extends CostCardLike>(
  cards: readonly T[],
  hasVideoInput: (card: T) => boolean,
): WorkbenchCostSummary {
  let usd = 0
  let counted = 0
  let unpriced = 0
  for (const card of cards) {
    const cost = estimateCostUsd(card.model, card.resolution, hasVideoInput(card), card.completionTokens)
    if (cost != null) {
      usd += cost
      counted += 1
      continue
    }
    // 出了片但估不出价 —— 钱是真花了的,只是我们算不出来。
    if (card.status === 'succeeded' || typeof card.completionTokens === 'number') unpriced += 1
  }
  return { usd, counted, unpriced }
}
