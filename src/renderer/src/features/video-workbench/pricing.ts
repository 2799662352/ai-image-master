// Seedance 视频生成计费估算 —— 文档 9.2 官方价格表(2026-07-22 口径)。
// 费用 = completion_tokens / 1_000_000 × 单价;单价按 模型 × 分辨率档 × 是否含视频输入。

import type { SeedanceModelAlias } from '../../../../types/seedance'

/**
 * 按 token 计费的模型不适用时的标记。
 *
 * 万相 3.0 是**按秒**计费的（官方刊例 480P/720P/1080P = ¥0.3/0.6/1.2 每秒），
 * 它的 task 压根不回传 `completion_tokens`，套不进这张表。这里不填一个假数字
 * 蒙混 —— 那会让界面显示一个凭空捏造的价格，比不显示糟得多。
 *
 * 用显式标记而不是把表改成 `Partial`，是为了保住穷尽性：下一个按 token 计费的
 * 模型漏填时仍然编译报错，而不是悄悄拿不到价。
 */
const NOT_TOKEN_BILLED = 'not-token-billed' as const

type TokenPriceTier = { noVideo: number; withVideo: number }
type TokenPriceEntry =
  | { standard: TokenPriceTier; fhd?: TokenPriceTier }
  | typeof NOT_TOKEN_BILLED

/** $ / 1M tokens。standard = 480p/720p;fhd = 1080p(仅 2.0 满血有此档)。 */
const PRICE_TABLE: Record<SeedanceModelAlias, TokenPriceEntry> = {
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
  // 按秒计费，走 CNY_PER_SECOND 那条路，不在这张表里出价。
  wan3: NOT_TOKEN_BILLED,
  'wan3-prime': NOT_TOKEN_BILLED,
}

/**
 * ¥ / 秒。万相 3.0 官方刊例（480P / 720P / 1080P）。
 *
 * **刻意不换算成美元。** 汇率是会变的外部量，写死一个就是把「今天的汇率」冻进
 * 代码，而没有任何东西会提醒我们它已经过时；用户看到的会是一个既不是账单、
 * 也说不清哪天口径的数。所以两种货币各算各的、各显示各的 —— 界面上多一个符号，
 * 好过一个看起来精确的错数。
 */
const CNY_PER_SECOND: Record<string, number> = {
  '480p': 0.3,
  '720p': 0.6,
  '1080p': 1.2,
}

/**
 * Prime 相对标准档的倍率。
 *
 * **不是刊例价,是网关实测比值。** 2026-08-31 拉 `/api/pricing`:`wan3.0-video`
 * 的 `model_price` 为 0.6、`wan3.0-video-prime` 为 0.8,两者 `quota_type` 都是 1
 * (按次)。0.8 / 0.6 = 4/3,乘到上面三档正好得到 0.4 / 0.8 / 1.6 三个整数
 * —— 档位是同比例缩放的,这一点让这个倍率不只是巧合。
 *
 * 为什么用倍率而不是另写一张表:阿里官方刊例里**没有** prime 这一档的每秒价
 * (我们查到的只有网关的按次价)。另写一张表就得凭空造三个数,而这个文件开头
 * 已经立过规矩 ——「不填一个假数字蒙混,那会让界面显示一个凭空捏造的价格」。
 * 倍率则是可追溯的:分子分母都是实测值,推导写在这里。
 *
 * ⚠️ 已知不精确(**两档同等程度地不精确,不是 prime 独有**):万相始终走 Miau
 * 网关,而网关是**按次**收费的,与这里的「按秒」并不是同一个计费基。所以这一栏
 * 给的是官方刊例口径的估算,不等于账单。要真正对齐账单,得把万相改成读网关的
 * 按次价 —— 那是另一件事,不在本次范围内。
 */
const WAN3_PRIME_MULTIPLIER = 0.8 / 0.6

/** ¥/秒 单价。非按秒计费的模型、或未知分辨率返回 null。 */
export function unitPriceCnyPerSecond(model: SeedanceModelAlias, resolution: string): number | null {
  if (PRICE_TABLE[model] !== NOT_TOKEN_BILLED) return null
  const base = CNY_PER_SECOND[resolution.toLowerCase()]
  if (base === undefined) return null
  return model === 'wan3-prime' ? base * WAN3_PRIME_MULTIPLIER : base
}

/** 单价($/1M tokens)。未知组合(如 fast/mini 配 1080p)返回 null。 */
export function unitPriceUsd(
  model: SeedanceModelAlias,
  resolution: string,
  hasVideoInput: boolean,
): number | null {
  const entry = PRICE_TABLE[model]
  if (!entry || entry === NOT_TOKEN_BILLED) return null
  const tier = resolution === '1080p' ? entry.fhd : entry.standard
  if (!tier) return null
  return hasVideoInput ? tier.withVideo : tier.noVideo
}

/**
 * 这张卡有没有可用于估价的 token 数。没有就一定算不出价 —— 是 summarizeCostUsd
 * 得以跳过 hasVideoInput 的前提,所以单独提出来,避免两处判定漂移。
 */
function hasUsableTokens(completionTokens: number | undefined): completionTokens is number {
  return typeof completionTokens === 'number' && Number.isFinite(completionTokens) && completionTokens > 0
}

/** 同上，按秒计费那条路的对应判据。 */
function hasUsableSeconds(billedSeconds: number | undefined): billedSeconds is number {
  return typeof billedSeconds === 'number' && Number.isFinite(billedSeconds) && billedSeconds > 0
}

/** 按上游回传的 completion_tokens 估算本次费用(USD)。无法估算返回 null。 */
export function estimateCostUsd(
  model: SeedanceModelAlias,
  resolution: string,
  hasVideoInput: boolean,
  completionTokens: number | undefined,
): number | null {
  if (!hasUsableTokens(completionTokens)) return null
  const price = unitPriceUsd(model, resolution, hasVideoInput)
  if (price == null) return null
  return (completionTokens / 1_000_000) * price
}

/** 按实际出片秒数估算本次费用(CNY)。无法估算返回 null。 */
export function estimateCostCny(
  model: SeedanceModelAlias,
  resolution: string,
  billedSeconds: number | undefined,
): number | null {
  if (!hasUsableSeconds(billedSeconds)) return null
  const price = unitPriceCnyPerSecond(model, resolution)
  if (price == null) return null
  return billedSeconds * price
}

/** 展示格式:$0.056(3 位小数,<0.001 显示 <$0.001)。 */
export function formatCostUsd(cost: number): string {
  if (cost > 0 && cost < 0.001) return '<$0.001'
  return `$${cost.toFixed(3)}`
}

/** 展示格式:¥1.50。两位小数 —— 按秒计费的最小档是 ¥0.3/秒,不会小到看不见。 */
export function formatCostCny(cost: number): string {
  return `¥${cost.toFixed(2)}`
}

/**
 * 两种货币的合计怎么显示成一句话。都为 0 时返回 null（调用方据此整块不渲染）。
 * 有两种时并列，**不相加** —— 理由见 CNY_PER_SECOND。
 */
export function formatCostParts(usd: number, cny: number): string | null {
  const parts = [usd > 0 ? formatCostUsd(usd) : null, cny > 0 ? formatCostCny(cny) : null].filter(
    (p): p is string => p !== null,
  )
  return parts.length > 0 ? parts.join(' + ') : null
}

/** summarizeCostUsd 需要的最小卡片形状(不依赖 store,便于直接喂普通对象测)。 */
export interface CostCardLike {
  model: SeedanceModelAlias
  resolution: string
  completionTokens?: number
  /** 按秒计费的模型（万相）用它。与 completionTokens 互斥。 */
  billedSeconds?: number
  status: string
}

export interface WorkbenchCostSummary {
  /** 能算出单价的卡片费用合计(USD)。 */
  usd: number
  /**
   * 按秒计费部分的合计(CNY)。**与 `usd` 并列，不相加** —— 换算要写死汇率，
   * 那等于把今天的汇率冻进代码，而没有任何东西会提醒它过期。
   */
  cny: number
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
 * `hasVideoInput` 由调用方注入(生产里是 `cardHasVideoInput`,与提交拆分同源) ——
 * 含视频输入的单价明显更低(文档 9.2),两处若各算一次必然对不上。
 */
export function summarizeCostUsd<T extends CostCardLike>(
  cards: readonly T[],
  hasVideoInput: (card: T) => boolean,
): WorkbenchCostSummary {
  let usd = 0
  let cny = 0
  let counted = 0
  let unpriced = 0
  for (const card of cards) {
    // 按秒计费那条路(万相)先走完 —— 它压根不回传 token,落到下面必然被记成
    // 「已出片但估不出价」,而它其实是算得出来的。
    if (hasUsableSeconds(card.billedSeconds)) {
      const cost = estimateCostCny(card.model, card.resolution, card.billedSeconds)
      if (cost != null) {
        cny += cost
        counted += 1
      } else {
        unpriced += 1
      }
      continue
    }
    // 先判 token 再问 hasVideoInput:看板上绝大多数是草稿,算不出价,问了白烧。
    // 生产侧的判定本身已经是 O(1) 布尔(`cardHasVideoInput`),这条顺序纪律仍留着
    // —— 万一以后又有人塞回重型推导,草稿热路径不该为此买单。
    if (!hasUsableTokens(card.completionTokens)) {
      // 出了片但估不出价 —— 钱是真花了的,只是我们算不出来。
      if (card.status === 'succeeded' || typeof card.completionTokens === 'number') unpriced += 1
      continue
    }
    const cost = estimateCostUsd(card.model, card.resolution, hasVideoInput(card), card.completionTokens)
    if (cost != null) {
      usd += cost
      counted += 1
      continue
    }
    // token 可用却仍算不出 —— 价目表里没有这个 模型 × 分辨率 组合。
    unpriced += 1
  }
  return { usd, cny, counted, unpriced }
}
