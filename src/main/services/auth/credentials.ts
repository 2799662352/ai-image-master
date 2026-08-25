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

/**
 * 落盘的 JSON 不可信,必须逐字段校验后才能当成凭证。
 *
 * 不做这一步,一个被篡改成 `{"userId":"u1"}` 的文件仍是合法 JSON,
 * `as StoredCredential` 会让它一路通过,下游据此发出 `Bearer undefined` ——
 * 而正确行为是「当作没有凭证」。类型断言不是校验。
 */
function parseCredential(json: string): StoredCredential | null {
  const raw: unknown = JSON.parse(json)
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  for (const k of ['token', 'userId', 'username', 'displayName', 'role'] as const) {
    if (typeof c[k] !== 'string') return null
  }
  if (!c.token) return null
  if (typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt)) return null
  return {
    token: c.token as string,
    userId: c.userId as string,
    username: c.username as string,
    displayName: c.displayName as string,
    role: c.role as string,
    expiresAt: c.expiresAt,
  }
}

function readFromSafeStorage(): StoredCredential | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const p = filePath()
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p) as Buffer
    const json = safeStorage.decryptString(buf)
    return parseCredential(json)
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

/**
 * 返回**副本**,不是缓存对象本身。
 *
 * 直接把缓存交出去的话,任何调用方改一下返回值就永久污染了本会话的缓存 ——
 * 比如把 token 置空,后续每次读都拿到那个坏值,而磁盘上其实是好的。
 * 写入侧同理:存进来的对象也要拷一份,免得调用方之后改它反向影响缓存。
 */
export function getCredential(): StoredCredential | null {
  if (inMemoryFallback) return { ...inMemoryFallback }
  if (cached === undefined) cached = readFromSafeStorage()
  return cached ? { ...cached } : null
}

export function setCredential(cred: StoredCredential): void {
  const snapshot: StoredCredential = { ...cred }
  const written = writeToSafeStorage(snapshot)
  if (written) {
    inMemoryFallback = null
    cached = snapshot
  } else {
    inMemoryFallback = snapshot
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
