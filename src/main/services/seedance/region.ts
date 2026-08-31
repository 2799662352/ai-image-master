// Seedance 站点 region 内存态 + Base URL / 模型 ID 解析（无 Electron 依赖，便于单测）。
// 持久化由 credentials.ts 读写；本模块只持会话级当前值。

import type { SeedanceModelAlias, SeedanceRegion } from '../../../types/seedance'
import { WAN3_PRIME_UPSTREAM_MODEL_ID, WAN3_UPSTREAM_MODEL_ID } from '../wan3/model'

export const SEEDANCE_REGION_BASE_URLS: Record<SeedanceRegion, string> = {
  global: 'https://vvdance.ai',
  cn: 'https://vvdance.yongmuai.com',
}

/**
 * 万相 3.0 的上游模型 ID —— 定义在 `../wan3/model`（region 是 vvdance 的站点概念，
 * 万相不分区域，让它的 id 住在这里会误导）。
 *
 * 仍然在下面两张 region 表里各登记一次，是为了保住
 * `Record<VideoModelAlias, string>` 的穷尽性：正是这个穷尽性在加 wan3 时把
 * 「你还没决定这个模型的 id」直接编译报错报了出来。改成 Partial 会让下一个模型
 * 悄悄漏掉。
 */
export { WAN3_UPSTREAM_MODEL_ID } from '../wan3/model'

/**
 * 海外 GLOBAL（默认）直连 vvdance.ai Ark → dreamina-*；
 * 国内直连 yongmuai.com → doubao-*。MCP 别名仍是 2.0 / 2.0-fast。
 *
 * `2.5` 的 global ID 读自控制台模型下拉的 option value（2026-08-08 实测）；
 * cn ID 出自国内站开发文档 §9.2 价格表（2026-08-12 版），见
 * {@link SEEDANCE_CN_2_5_ENABLED}。
 */
export const SEEDANCE_MODEL_IDS_BY_REGION: Record<
  SeedanceRegion,
  Record<SeedanceModelAlias, string>
> = {
  global: {
    '2.0': 'dreamina-seedance-2-0-260128',
    '2.0-fast': 'dreamina-seedance-2-0-fast-260128',
    '2.0-mini': 'dreamina-seedance-2-0-mini-260615',
    '2.5': 'dreamina-seedance-2-5-260628',
    // 万相两档在两张表里填的是同一个值 —— 它不分区域（见文件头注释），登记在这里
    // 纯粹是为了保住 `Record<VideoModelAlias, string>` 的穷尽性。
    wan3: WAN3_UPSTREAM_MODEL_ID,
    'wan3-prime': WAN3_PRIME_UPSTREAM_MODEL_ID,
  },
  cn: {
    '2.0': 'doubao-seedance-2-0-260128',
    '2.0-fast': 'doubao-seedance-2-0-fast-260128',
    '2.0-mini': 'doubao-seedance-2-0-mini-260615',
    '2.5': 'doubao-seedance-2-5-260628',
    wan3: WAN3_UPSTREAM_MODEL_ID,
    'wan3-prime': WAN3_PRIME_UPSTREAM_MODEL_ID,
  },
}

/**
 * 国内区 Seedance 2.5 的灰度闸 —— **已于 2026-08-12 打开**。
 *
 * 关着的那段时间里，上面那个 `doubao-seedance-2-5-260628` 是**按 2.0 家族的对称
 * 规律推断**的（global/cn 三个 2.0 ID 后缀逐字相同）：GLOBAL 文档通篇没有
 * `doubao-seedance`，国内站文档当时拿不到。ID 猜错的代价是国内用户提交即报
 * 「模型不存在」，所以宁可先不给点。
 *
 * 打开的依据是国内站开发文档（`vvdance.yongmuai.com`，2026-08-12 版）§9.2 价格表
 * 逐字列出了 `doubao-seedance-2-5-260628`，与推断值完全一致；同版 §2.2 的 2.5 约束
 * （仅 480p/720p、图/视频/音频 30/10/10、总数 50、edit 锁 -1、extend 4-30、允许纯
 * 音频参考）也与 `SEEDANCE_MODEL_CAPABILITIES['2.5']` 逐条对得上。
 *
 * 要临时关掉不必回退发版：设环境变量 `SEEDANCE_CN_25=0` 重启应用即可。
 */
export const SEEDANCE_CN_2_5_ENABLED = true

/**
 * 还没接完传输层、因而**不可选**的模型。
 *
 * 现在是空的：万相 3.0 的传输层已于 2026-08-14 接通并对着真网关跑通端到端
 * （`scripts/smoke-wan3.ts`：提交 → queued → running → succeeded → 取到地址）。
 *
 * 留着这个集合而不是删掉：下一个模型进来时，「能力表已落位但传输层还没接」
 * 之间总有一段窗口，那段时间它不该出现在下拉里让用户选到一个必然失败的选项。
 */
const NOT_YET_SELECTABLE: ReadonlySet<SeedanceModelAlias> = new Set([])

const CN_ONLY_GATED: ReadonlySet<SeedanceModelAlias> = new Set(['2.5'])

function cn25Enabled(): boolean {
  const env = (process.env.SEEDANCE_CN_25 || '').trim().toLowerCase()
  if (env === '1' || env === 'true') return true
  if (env === '0' || env === 'false') return false
  return SEEDANCE_CN_2_5_ENABLED
}

/** 该 region 当前是否放开这个模型（灰度中的组合返回 false）。 */
export function isSeedanceModelAvailable(
  alias: SeedanceModelAlias,
  region: SeedanceRegion = getSeedanceRegion(),
): boolean {
  if (NOT_YET_SELECTABLE.has(alias)) return false
  if (region === 'cn' && CN_ONLY_GATED.has(alias)) return cn25Enabled()
  return true
}

/** 该 region 当前可选的模型别名（UI 下拉、MCP enum 都应该只认这一份）。 */
export function listSeedanceModelAliases(
  region: SeedanceRegion = getSeedanceRegion(),
): SeedanceModelAlias[] {
  return (Object.keys(SEEDANCE_MODEL_IDS_BY_REGION[region]) as SeedanceModelAlias[]).filter(
    (alias) => isSeedanceModelAvailable(alias, region),
  )
}

const DEFAULT_REGION: SeedanceRegion = 'global'

let currentRegion: SeedanceRegion = DEFAULT_REGION

export function parseSeedanceRegion(value: unknown): SeedanceRegion | null {
  if (value === 'global' || value === 'cn') return value
  return null
}

export function getSeedanceRegion(): SeedanceRegion {
  return currentRegion
}

/** 仅更新内存态；持久化请走 credentials.setSeedanceCredentials({ region })。 */
export function setSeedanceRegionMemory(region: SeedanceRegion): void {
  currentRegion = region
}

/**
 * Base URL 解析顺序：env `SEEDANCE_BASE_URL` > region 预设 > 默认 global。
 * 末尾斜杠会被剥掉，避免 path 拼接成 `//api/...`。
 */
export function resolveSeedanceBaseUrl(
  region: SeedanceRegion = currentRegion,
  envUrl: string | undefined = process.env.SEEDANCE_BASE_URL,
): string {
  const env = (envUrl || '').trim().replace(/\/+$/, '')
  if (env) return env
  return SEEDANCE_REGION_BASE_URLS[region]
}

export function getSeedanceBaseUrl(): string {
  return resolveSeedanceBaseUrl(getSeedanceRegion())
}

export function resolveSeedanceModelId(
  alias: SeedanceModelAlias,
  region: SeedanceRegion = getSeedanceRegion(),
): string {
  return SEEDANCE_MODEL_IDS_BY_REGION[region][alias]
}
