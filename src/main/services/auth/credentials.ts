// safeStorage 凭证加密落盘,懒加载 + 内存降级 + 失效回调注册表。
//
// 形状照抄 `src/main/services/tencent/credentials.ts`,同一套约束的另一份实现:
//   - 不得在模块加载时读盘:`safeStorage.isEncryptionAvailable()` 在 `app` ready
//     之前恒为 false,`encryptString`/`decryptString` 直接 throw。所有磁盘访问
//     (包括 `app.getPath('userData')`)必须懒加载,首次调用 `getCredential()`
//     才触发。
//   - `decryptString` 会校验 v10/v11 密文前缀,文件损坏或截断时抛
//     "Ciphertext does not appear to be encrypted." 而非返回垃圾 —— 读路径整体
//     try/catch,任何异常都当作「无凭证」。
//   - 不调 `setUsePlainTextEncryption(true)`:Linux 无系统密码管理器时它会切到
//     内存固定密码,混淆不是加密。降级到内存(仅本次会话有效)才是诚实的行为。

import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface StoredCredential {
  token: string
  userId: string
  username: string
  displayName: string
  role: string
  expiresAt: number
}

const FILENAME = 'auth-credentials.bin'

// undefined = 尚未读过(尚未触发懒加载);null = 读过,但没有凭证。
let cached: StoredCredential | null | undefined = undefined
let inMemoryFallback: StoredCredential | null = null
const invalidateCallbacks = new Set<() => void>()

function filePath(): string {
  return path.join(app.getPath('userData'), FILENAME)
}

function notify(): void {
  invalidateCallbacks.forEach((cb) => cb())
}

function readFromSafeStorage(): StoredCredential | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const p = filePath()
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p) as Buffer
    const json = safeStorage.decryptString(buf)
    return JSON.parse(json) as StoredCredential
  } catch (e) {
    console.warn('[auth/credentials] safeStorage read failed:', e)
    return null
  }
}

function writeToSafeStorage(cred: StoredCredential): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const buf = safeStorage.encryptString(JSON.stringify(cred))
    fs.writeFileSync(filePath(), buf)
    return true
  } catch (e) {
    console.warn('[auth/credentials] safeStorage write failed:', e)
    return false
  }
}

function removeFromDisk(): void {
  try {
    const p = filePath()
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (e) {
    console.warn('[auth/credentials] failed to remove credential file:', e)
  }
}

export function getCredential(): StoredCredential | null {
  if (inMemoryFallback) return inMemoryFallback
  if (cached === undefined) cached = readFromSafeStorage()
  return cached
}

export function setCredential(cred: StoredCredential): void {
  const written = writeToSafeStorage(cred)
  if (written) {
    inMemoryFallback = null
    cached = cred
  } else {
    inMemoryFallback = cred
    cached = null
    console.warn('[auth/credentials] safeStorage unavailable; using in-memory fallback')
  }
  notify()
}

export function clearCredential(): void {
  inMemoryFallback = null
  cached = null
  removeFromDisk()
  notify()
}

export function credentialSource(): 'safeStorage' | 'memory' | 'none' {
  if (inMemoryFallback) return 'memory'
  if (getCredential()) return 'safeStorage'
  return 'none'
}

export function onCredentialChanged(cb: () => void): () => void {
  invalidateCallbacks.add(cb)
  return () => invalidateCallbacks.delete(cb)
}
