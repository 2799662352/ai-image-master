// Seedance API Key 安全存储 —— 与 tencent/credentials.ts 同款 safeStorage 模式
// （无 legacy electron-store 迁移负担，结构更简）。
// 优先级：safeStorage 持久化 > 环境变量 SEEDANCE_API_KEY。

import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'

const SAFE_STORAGE_FILENAME = 'seedance-credentials.bin'

export interface SeedanceKeyState {
  hasKey: boolean
  /** 形如 `sk-1a****`，仅用于设置页展示。 */
  keyMasked?: string
  source: 'store' | 'env' | 'none'
}

let cached: { apiKey: string; source: SeedanceKeyState['source'] } | null = null
/** safeStorage 不可用时的会话级兜底（与 tencent 同策略）。 */
let inMemoryFallback: string | null = null

function binPath(): string {
  return path.join(app.getPath('userData'), SAFE_STORAGE_FILENAME)
}

function readFromSafeStorage(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const p = binPath()
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p) as Buffer
    const key = safeStorage.decryptString(buf).trim()
    return key || null
  } catch (e) {
    console.warn('[seedance/credentials] safeStorage read failed:', e)
    return null
  }
}

function writeToSafeStorage(apiKey: string): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const p = binPath()
    if (!apiKey) {
      if (fs.existsSync(p)) fs.unlinkSync(p)
      return true
    }
    fs.writeFileSync(p, safeStorage.encryptString(apiKey))
    return true
  } catch (e) {
    console.warn('[seedance/credentials] safeStorage write failed:', e)
    return false
  }
}

function resolve(): { apiKey: string; source: SeedanceKeyState['source'] } {
  if (inMemoryFallback != null) {
    return { apiKey: inMemoryFallback, source: inMemoryFallback ? 'store' : 'none' }
  }
  const stored = readFromSafeStorage()
  if (stored) return { apiKey: stored, source: 'store' }
  const env = (process.env.SEEDANCE_API_KEY || '').trim()
  if (env) return { apiKey: env, source: 'env' }
  return { apiKey: '', source: 'none' }
}

export function getSeedanceApiKey(): string {
  if (!cached) cached = resolve()
  return cached.apiKey
}

export function getSeedanceKeyState(): SeedanceKeyState {
  if (!cached) cached = resolve()
  const { apiKey, source } = cached
  return {
    hasKey: !!apiKey,
    keyMasked: apiKey ? `${apiKey.slice(0, 5)}****` : undefined,
    source,
  }
}

/** 传空字符串即清除已存 Key。 */
export function setSeedanceApiKey(apiKey: string): void {
  const trimmed = (apiKey || '').trim()
  if (!writeToSafeStorage(trimmed)) {
    inMemoryFallback = trimmed
    console.warn('[seedance/credentials] safeStorage unavailable; using in-memory fallback')
  } else {
    inMemoryFallback = null
  }
  cached = null
}
