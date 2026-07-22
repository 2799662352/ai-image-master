// Seedance API Key/Secret/region 安全存储 —— 与 tencent/credentials.ts 同款 safeStorage 模式。
// 文件内容是加密后的 JSON `{ apiKey, apiSecret, region? }`；旧版本只存纯 Key 字符串，
// 读取时向后兼容。
// 优先级：safeStorage 持久化 > 环境变量 SEEDANCE_API_KEY / SEEDANCE_API_SECRET。
// region 默认 global（海外 VVDance GLOBAL）；Base URL 另可由 SEEDANCE_BASE_URL 覆盖。

import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { SeedanceKeyState, SeedanceRegion } from '../../../types/seedance'
import {
  getSeedanceRegion,
  parseSeedanceRegion,
  setSeedanceRegionMemory,
} from './region'

export type { SeedanceKeyState }

const SAFE_STORAGE_FILENAME = 'seedance-credentials.bin'
const DEFAULT_REGION: SeedanceRegion = 'global'

interface SeedanceCredentials {
  apiKey: string
  apiSecret: string
  region: SeedanceRegion
}

let cached: { creds: SeedanceCredentials; source: SeedanceKeyState['source'] } | null = null
/** safeStorage 不可用时的会话级兜底（与 tencent 同策略）。 */
let inMemoryFallback: SeedanceCredentials | null = null

function binPath(): string {
  return path.join(app.getPath('userData'), SAFE_STORAGE_FILENAME)
}

function parseStored(plain: string): SeedanceCredentials | null {
  const text = plain.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Partial<SeedanceCredentials>
      const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey.trim() : ''
      const apiSecret = typeof obj.apiSecret === 'string' ? obj.apiSecret.trim() : ''
      const region = parseSeedanceRegion(obj.region) ?? DEFAULT_REGION
      if (!apiKey && !apiSecret) {
        // 允许只存 region（用户尚未填 Key）
        return { apiKey: '', apiSecret: '', region }
      }
      return { apiKey, apiSecret, region }
    } catch {
      /* 落到旧格式分支 */
    }
  }
  // 旧格式：文件里只有纯 API Key 字符串
  return { apiKey: text, apiSecret: '', region: DEFAULT_REGION }
}

function readFromSafeStorage(): SeedanceCredentials | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const p = binPath()
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p) as Buffer
    return parseStored(safeStorage.decryptString(buf))
  } catch (e) {
    console.warn('[seedance/credentials] safeStorage read failed:', e)
    return null
  }
}

function writeToSafeStorage(creds: SeedanceCredentials): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const p = binPath()
    if (!creds.apiKey && !creds.apiSecret && creds.region === DEFAULT_REGION) {
      // 默认 region + 无密钥：清文件，避免空壳残留
      if (fs.existsSync(p)) fs.unlinkSync(p)
      return true
    }
    fs.writeFileSync(
      p,
      safeStorage.encryptString(
        JSON.stringify({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          region: creds.region,
        }),
      ),
    )
    return true
  } catch (e) {
    console.warn('[seedance/credentials] safeStorage write failed:', e)
    return false
  }
}

function resolve(): { creds: SeedanceCredentials; source: SeedanceKeyState['source'] } {
  if (inMemoryFallback != null) {
    const has = !!(inMemoryFallback.apiKey || inMemoryFallback.apiSecret)
    return { creds: inMemoryFallback, source: has ? 'store' : 'none' }
  }
  const stored = readFromSafeStorage()
  if (stored) return { creds: stored, source: stored.apiKey || stored.apiSecret ? 'store' : 'none' }
  const envKey = (process.env.SEEDANCE_API_KEY || '').trim()
  const envSecret = (process.env.SEEDANCE_API_SECRET || '').trim()
  if (envKey || envSecret) {
    return {
      creds: { apiKey: envKey, apiSecret: envSecret, region: getSeedanceRegion() || DEFAULT_REGION },
      source: 'env',
    }
  }
  return { creds: { apiKey: '', apiSecret: '', region: DEFAULT_REGION }, source: 'none' }
}

function syncRegionMemory(region: SeedanceRegion): void {
  setSeedanceRegionMemory(region)
}

export function getSeedanceApiKey(): string {
  if (!cached) {
    cached = resolve()
    syncRegionMemory(cached.creds.region)
  }
  return cached.creds.apiKey
}

export function getSeedanceApiSecret(): string {
  if (!cached) {
    cached = resolve()
    syncRegionMemory(cached.creds.region)
  }
  return cached.creds.apiSecret
}

export function getSeedanceKeyState(): SeedanceKeyState {
  if (!cached) {
    cached = resolve()
    syncRegionMemory(cached.creds.region)
  }
  const { creds, source } = cached
  return {
    hasKey: !!creds.apiKey,
    keyMasked: creds.apiKey ? `${creds.apiKey.slice(0, 5)}****` : undefined,
    source,
    hasSecret: !!creds.apiSecret,
    secretMasked: creds.apiSecret ? `${creds.apiSecret.slice(0, 5)}****` : undefined,
    region: creds.region,
  }
}

/**
 * 写入凭证。字段传 `undefined` 表示保持原值，传空字符串表示清除（region 除外）。
 */
export function setSeedanceCredentials(next: {
  apiKey?: string
  apiSecret?: string
  region?: SeedanceRegion
}): void {
  if (!cached) {
    cached = resolve()
    syncRegionMemory(cached.creds.region)
  }
  const merged: SeedanceCredentials = {
    apiKey: next.apiKey !== undefined ? next.apiKey.trim() : cached.creds.apiKey,
    apiSecret: next.apiSecret !== undefined ? next.apiSecret.trim() : cached.creds.apiSecret,
    region: next.region !== undefined ? next.region : cached.creds.region,
  }
  if (!writeToSafeStorage(merged)) {
    inMemoryFallback = merged
    console.warn('[seedance/credentials] safeStorage unavailable; using in-memory fallback')
  } else {
    inMemoryFallback = null
  }
  syncRegionMemory(merged.region)
  cached = null
}

/** 传空字符串即清除已存 Key（向后兼容旧调用方）。 */
export function setSeedanceApiKey(apiKey: string): void {
  setSeedanceCredentials({ apiKey })
}
