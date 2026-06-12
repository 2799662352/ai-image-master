// Seedance API Key/Secret 安全存储 —— 与 tencent/credentials.ts 同款 safeStorage 模式。
// 文件内容是加密后的 JSON `{ apiKey, apiSecret }`；旧版本只存纯 Key 字符串，
// 读取时向后兼容。
// 优先级：safeStorage 持久化 > 环境变量 SEEDANCE_API_KEY / SEEDANCE_API_SECRET。

import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { SeedanceKeyState } from '../../../types/seedance'

export type { SeedanceKeyState }

const SAFE_STORAGE_FILENAME = 'seedance-credentials.bin'

interface SeedanceCredentials {
  apiKey: string
  apiSecret: string
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
      if (!apiKey && !apiSecret) return null
      return { apiKey, apiSecret }
    } catch {
      /* 落到旧格式分支 */
    }
  }
  // 旧格式：文件里只有纯 API Key 字符串
  return { apiKey: text, apiSecret: '' }
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
    if (!creds.apiKey && !creds.apiSecret) {
      if (fs.existsSync(p)) fs.unlinkSync(p)
      return true
    }
    fs.writeFileSync(p, safeStorage.encryptString(JSON.stringify(creds)))
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
  if (stored) return { creds: stored, source: 'store' }
  const envKey = (process.env.SEEDANCE_API_KEY || '').trim()
  const envSecret = (process.env.SEEDANCE_API_SECRET || '').trim()
  if (envKey || envSecret) {
    return { creds: { apiKey: envKey, apiSecret: envSecret }, source: 'env' }
  }
  return { creds: { apiKey: '', apiSecret: '' }, source: 'none' }
}

export function getSeedanceApiKey(): string {
  if (!cached) cached = resolve()
  return cached.creds.apiKey
}

export function getSeedanceApiSecret(): string {
  if (!cached) cached = resolve()
  return cached.creds.apiSecret
}

export function getSeedanceKeyState(): SeedanceKeyState {
  if (!cached) cached = resolve()
  const { creds, source } = cached
  return {
    hasKey: !!creds.apiKey,
    keyMasked: creds.apiKey ? `${creds.apiKey.slice(0, 5)}****` : undefined,
    source,
    hasSecret: !!creds.apiSecret,
    secretMasked: creds.apiSecret ? `${creds.apiSecret.slice(0, 5)}****` : undefined,
  }
}

/**
 * 写入凭证。字段传 `undefined` 表示保持原值，传空字符串表示清除。
 */
export function setSeedanceCredentials(next: { apiKey?: string; apiSecret?: string }): void {
  if (!cached) cached = resolve()
  const merged: SeedanceCredentials = {
    apiKey: next.apiKey !== undefined ? next.apiKey.trim() : cached.creds.apiKey,
    apiSecret: next.apiSecret !== undefined ? next.apiSecret.trim() : cached.creds.apiSecret,
  }
  if (!writeToSafeStorage(merged)) {
    inMemoryFallback = merged
    console.warn('[seedance/credentials] safeStorage unavailable; using in-memory fallback')
  } else {
    inMemoryFallback = null
  }
  cached = null
}

/** 传空字符串即清除已存 Key（向后兼容旧调用方）。 */
export function setSeedanceApiKey(apiKey: string): void {
  setSeedanceCredentials({ apiKey })
}
