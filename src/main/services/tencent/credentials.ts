// src/main/services/tencent/credentials.ts

import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import Store from 'electron-store'
import type { Credentials, CredentialState } from './types'

type InvalidateCallback = () => void
const invalidateCallbacks: InvalidateCallback[] = []

export function onCredentialsInvalidated(cb: InvalidateCallback): void {
  invalidateCallbacks.push(cb)
}

const SAFE_STORAGE_FILENAME = 'tencent-credentials.bin'
const LEGACY_STORE_NAME = 'tencent-credentials'
const LEGACY_ENCRYPTION_KEY = 'tencent-cred-v1'
const DEFAULTS: Credentials = { secretId: '', secretKey: '', bucket: '', region: 'ap-guangzhou' }

function maskSecretId(id: string): string | undefined {
  if (!id) return undefined
  if (id.length < 8) return '****'
  return `${id.slice(0, 4)}****`
}

/**
 * 腾讯云永久 SecretId 恒为 `AKID` 开头的 36 位字符串。用户误把别家 API key
 * 粘进设置页时(实测触发 COS `InvalidAccessKeyId: The access key Id format
 * you provided is invalid`),媒体链路应视为「未配置」自动落回免密钥 STS
 * 通道,而不是拿畸形密钥去签名。宽松校验:AKID 前缀 + 总长 ≥20。
 */
export function isLikelyValidSecretId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('AKID') && id.length >= 20
}

interface Resolved {
  creds: Credentials
  source: CredentialState['credentialSource']
}

let legacyStoreInstance: any = null
let cached: Resolved | null = null
let migrationAttempted = false
let inMemoryFallback: Credentials | null = null

function getLegacyStore() {
  if (!legacyStoreInstance) {
    legacyStoreInstance = new (Store as any)({
      name: LEGACY_STORE_NAME,
      encryptionKey: LEGACY_ENCRYPTION_KEY,
      encryptionAlgorithm: 'aes-256-gcm',
      defaults: DEFAULTS,
    })
  }
  return legacyStoreInstance
}

function safeStorageBinPath(): string {
  return path.join(app.getPath('userData'), SAFE_STORAGE_FILENAME)
}

function readFromSafeStorage(): Credentials | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const p = safeStorageBinPath()
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p) as Buffer
    const json = safeStorage.decryptString(buf)
    return { ...DEFAULTS, ...JSON.parse(json) }
  } catch (e) {
    console.warn('[tencent/credentials] safeStorage read failed:', e)
    return null
  }
}

function writeToSafeStorage(creds: Credentials): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const buf = safeStorage.encryptString(JSON.stringify(creds))
    fs.writeFileSync(safeStorageBinPath(), buf)
    return true
  } catch (e) {
    console.warn('[tencent/credentials] safeStorage write failed:', e)
    return false
  }
}

function readFromLegacyStore(): Credentials | null {
  try {
    const store = getLegacyStore()
    const c: Credentials = {
      secretId: store.get('secretId') || '',
      secretKey: store.get('secretKey') || '',
      bucket: store.get('bucket') || '',
      region: store.get('region') || '',
    }
    if (!c.secretId && !c.secretKey) return null
    return c
  } catch {
    return null
  }
}

function clearLegacyStore(): void {
  try {
    const store = getLegacyStore()
    store.delete('secretId')
    store.delete('secretKey')
    store.delete('bucket')
    store.delete('region')
  } catch (e) {
    console.warn(
      '[tencent/credentials] failed to clear legacy electron-store; ' +
        'plaintext-encrypted-with-hardcoded-key credentials may remain on disk:',
      e,
    )
  }
}

function migrateLegacyOnce(): Credentials | null {
  if (migrationAttempted) return null
  const legacy = readFromLegacyStore()
  if (!legacy) {
    migrationAttempted = true // nothing to migrate; don't keep retrying
    return null
  }
  if (writeToSafeStorage(legacy)) {
    clearLegacyStore()
    migrationAttempted = true
    console.log('[tencent/credentials] migrated from electron-store -> safeStorage')
    return legacy
  }
  // Write failed (e.g., safeStorage transiently unavailable). Surface the legacy
  // creds for this session, but leave migrationAttempted = false so a later
  // setCredentials() / next session can retry the secure write.
  return legacy
}

function loadBuiltin(): Credentials {
  const empty: Credentials = { ...DEFAULTS }
  try {
    const credPath = app.isPackaged
      ? path.join(process.resourcesPath, 'cos-credentials.json')
      : path.resolve(__dirname, '../../../../cos-credentials.json')
    if (fs.existsSync(credPath)) {
      return { ...empty, ...JSON.parse(fs.readFileSync(credPath, 'utf-8')) }
    }
  } catch {}
  return empty
}

const BUILTIN: Credentials = loadBuiltin()

// Per-field fallback: each field tries store -> env -> builtin -> default independently.
function resolve(): Resolved {
  if (inMemoryFallback) {
    return {
      creds: { ...inMemoryFallback },
      source: inMemoryFallback.secretId ? 'memory' : 'none',
    }
  }

  let stored = readFromSafeStorage()
  if (!stored) stored = migrateLegacyOnce()

  const creds: Credentials = {
    secretId:  (stored?.secretId)  || process.env.COS_SECRET_ID  || BUILTIN.secretId  || '',
    secretKey: (stored?.secretKey) || process.env.COS_SECRET_KEY || BUILTIN.secretKey || '',
    bucket:    (stored?.bucket)    || process.env.COS_BUCKET     || process.env.COS_BUCKET_NAME || BUILTIN.bucket || '',
    region:    (stored?.region)    || process.env.COS_REGION     || BUILTIN.region    || DEFAULTS.region,
  }

  let source: CredentialState['credentialSource'] = 'none'
  if (stored?.secretId) source = 'store'
  else if (process.env.COS_SECRET_ID) source = 'env'
  else if (BUILTIN.secretId) source = 'builtin'

  return { creds, source }
}

function getResolved(): Resolved {
  if (!cached) cached = resolve()
  return cached
}

export function getCredentials(): Credentials {
  return { ...getResolved().creds }
}

export function getCredentialState(): CredentialState {
  const { creds, source } = getResolved()
  if (!creds.secretId || !isLikelyValidSecretId(creds.secretId)) {
    // 免密钥通道:没有永久密钥(或存的密钥格式明显不对,会被媒体链路忽略)
    // 时,媒体功能仍可经 SCF 云函数 STS 临时票据运行(桶/区域随票据下发)。
    // 端点故障会在任务运行时以正常失败面呈现。
    return { hasCredentials: true, credentialSource: 'sts' }
  }
  return {
    hasCredentials: true,
    credentialSource: source,
    secretIdMasked: maskSecretId(creds.secretId),
    bucket: creds.bucket || undefined,
    region: creds.region || undefined,
  }
}

export function setCredentials(patch: Partial<Credentials>): void {
  const current = getCredentials()
  const next: Credentials = { ...current, ...patch }

  const written = writeToSafeStorage(next)
  if (!written) {
    inMemoryFallback = next
    console.warn('[tencent/credentials] safeStorage unavailable; using in-memory fallback')
  } else {
    inMemoryFallback = null
  }

  cached = null
  invalidateCallbacks.forEach((cb) => cb())
}
