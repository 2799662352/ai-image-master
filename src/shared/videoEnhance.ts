/**
 * 视频高清的两条渠道:模型名、参数轴、按次价格。
 *
 * 渲染层(提交前展示价格、组选项)与主进程(把选项翻成网关模型名)共用,所以在 shared。
 *
 * ## 价格是「挂牌价快照」,网关才是结算权威
 *
 * 这张表镜像的是 new-api `relay/channel/aisr/constants.go` 的 `priceTable`
 * (阿里云云市场商品页挂牌价,元/分钟,网关直接当元/次用)。这里写一份是为了
 * **提交前**能告诉用户要花多少 —— 而实际扣多少由网关按它那张表预扣。两边不一致时
 * 网关说了算;有条测试守住这里与网关源码里的数字对得上。
 *
 * ## 为什么按次而不按时长
 *
 * 上游按 算法 × 分辨率 × 帧率 三维定价,但请求里只有前两个,帧率来自源视频,且
 * 状态 / 结果都不回报实际用量 —— 网关既无法预估也无法事后结算。所以一档一模型、
 * 一模型一固定价,**长视频也按一分钟收**。这是网关侧已知并接受的取舍,客户端
 * 只能如实展示,不能替它算得更准。
 */

export type EnhanceProvider = 'volc' | 'damo'
export type DamoAlgo = 'standard' | 'pro'
export type DamoResolution = '720p' | '1080p' | '2k' | '4k' | '8k'
export type DamoFps = 30 | 60 | 120

export const DAMO_ALGOS: readonly DamoAlgo[] = ['standard', 'pro']
export const DAMO_RESOLUTIONS: readonly DamoResolution[] = ['720p', '1080p', '2k', '4k', '8k']
export const DAMO_FPS: readonly DamoFps[] = [30, 60, 120]

/** 火山 MediaKit:一个模型、固定档(professional / 2k / 30fps)、按次 ¥0.1。 */
export const VOLC_ENHANCE_MODEL = 'volc-enhance-video'
export const VOLC_ENHANCE_PRICE_YUAN = 0.1

/**
 * 阿里 DAMO 挂牌价(元/次)。规律:pro 恒为 standard 的 3 倍;帧率翻倍价格翻倍。
 * 顺序对应 DAMO_FPS = [30, 60, 120]。
 */
const DAMO_PRICE_TABLE: Readonly<Record<DamoAlgo, Readonly<Record<DamoResolution, readonly [number, number, number]>>>> = {
  standard: { '720p': [2, 4, 8], '1080p': [4, 8, 16], '2k': [8, 16, 32], '4k': [16, 32, 64], '8k': [64, 128, 256] },
  pro: { '720p': [6, 12, 24], '1080p': [12, 24, 48], '2k': [24, 48, 96], '4k': [48, 96, 192], '8k': [192, 384, 768] },
}

export interface DamoSpec {
  algo: DamoAlgo
  resolution: DamoResolution
  fps: DamoFps
}

/** 用户没动选项时的 DAMO 档:最便宜那一档,避免默认就是几十块。 */
export const DEFAULT_DAMO_SPEC: DamoSpec = { algo: 'standard', resolution: '720p', fps: 30 }

/** 提交载荷里的高清规格。`provider` 缺省视为火山(默认且最便宜)。 */
export type EnhanceSpec =
  | { provider: 'volc' }
  | ({ provider: 'damo' } & DamoSpec)

export const DEFAULT_ENHANCE_SPEC: EnhanceSpec = { provider: 'volc' }

/** 网关上的 DAMO 模型名,与 new-api 的 `damo-aisr-%s-%s-%dfps` 一致。 */
export function damoModelName(spec: DamoSpec): string {
  return `damo-aisr-${spec.algo}-${spec.resolution}-${spec.fps}fps`
}

export function damoPriceYuan(spec: DamoSpec): number {
  return DAMO_PRICE_TABLE[spec.algo][spec.resolution][DAMO_FPS.indexOf(spec.fps)]
}

/** 规格 → 网关模型名。主进程提交时用。 */
export function enhanceModelFor(spec: EnhanceSpec | undefined): string {
  if (!spec || spec.provider === 'volc') return VOLC_ENHANCE_MODEL
  return damoModelName(spec)
}

/** 规格 → 按次价格。渲染层提交前展示用。 */
export function enhancePriceYuan(spec: EnhanceSpec | undefined): number {
  if (!spec || spec.provider === 'volc') return VOLC_ENHANCE_PRICE_YUAN
  return damoPriceYuan(spec)
}

/** 给列表 / 结果卡看的短标签,如「火山」「DAMO 标准 1080P 30fps」。 */
export function enhanceSpecLabel(spec: EnhanceSpec | undefined): string {
  if (!spec || spec.provider === 'volc') return '火山'
  const algo = spec.algo === 'pro' ? 'Pro' : '标准'
  return `DAMO ${algo} ${spec.resolution.toUpperCase()} ${spec.fps}fps`
}

/**
 * 把不可信的载荷收敛成合法规格。认不出就当火山 —— 两个方向代价不对称:误判成火山
 * 最多花 ¥0.1;误判成某个 DAMO 档可能一下扣几百。
 */
export function coerceEnhanceSpec(raw: unknown): EnhanceSpec {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_ENHANCE_SPEC
  const r = raw as Record<string, unknown>
  if (r.provider !== 'damo') return DEFAULT_ENHANCE_SPEC
  const algo = DAMO_ALGOS.find((a) => a === r.algo)
  const resolution = DAMO_RESOLUTIONS.find((x) => x === r.resolution)
  const fps = DAMO_FPS.find((f) => f === r.fps)
  if (!algo || !resolution || !fps) return DEFAULT_ENHANCE_SPEC
  return { provider: 'damo', algo, resolution, fps }
}
