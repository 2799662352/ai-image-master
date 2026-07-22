// Seedance 站点 region 内存态 + Base URL / 模型 ID 解析（无 Electron 依赖，便于单测）。
// 持久化由 credentials.ts 读写；本模块只持会话级当前值。

import type { SeedanceModelAlias, SeedanceRegion } from '../../../types/seedance'

export const SEEDANCE_REGION_BASE_URLS: Record<SeedanceRegion, string> = {
  global: 'https://vvdance.ai',
  cn: 'https://vvdance.yongmuai.com',
}

/**
 * 海外 GLOBAL（默认）直连 vvdance.ai Ark → dreamina-*；
 * 国内直连 yongmuai.com → doubao-*。MCP 别名仍是 2.0 / 2.0-fast。
 */
export const SEEDANCE_MODEL_IDS_BY_REGION: Record<
  SeedanceRegion,
  Record<SeedanceModelAlias, string>
> = {
  global: {
    '2.0': 'dreamina-seedance-2-0-260128',
    '2.0-fast': 'dreamina-seedance-2-0-fast-260128',
    '2.0-mini': 'dreamina-seedance-2-0-mini-260615',
  },
  cn: {
    '2.0': 'doubao-seedance-2-0-260128',
    '2.0-fast': 'doubao-seedance-2-0-fast-260128',
    '2.0-mini': 'doubao-seedance-2-0-mini-260615',
  },
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
