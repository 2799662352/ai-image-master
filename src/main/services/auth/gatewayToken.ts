import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getCredential } from './credentials'
import { authBaseUrl } from './session'

export interface Pool {
  projectId: number
  /** producer 池才有。**它是池键的另一半**,只按 projectId 认会把两个池悄悄合并。 */
  producerProjectId: number | null
}

export class GatewayTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'GatewayTokenError'
  }
}

function poolKey(p: Pool): string {
  return `${p.projectId}:${p.producerProjectId ?? ''}`
}

/** 明文 token 只活在这里。**绝不导出这个 Map,绝不经 IPC 下发。** */
const cache = new Map<string, string>()
/** 同一个池的并发请求合流成一次网络往返,避免 N 个出图任务同时打后端。 */
const inflight = new Map<string, Promise<string>>()
let activePool: Pool | null = null

export function setActivePool(pool: Pool | null): void {
  activePool = pool
}

/**
 * 给 header 注入器用的同步读。
 *
 * 必须同步:`onBeforeSendHeaders` 在每个请求的热路径上,在那里 await 一次网络
 * 往返会把出图请求整体拖慢,且首次调用时会让请求排队。所以取 token 的时机是
 * 「用户切池 / 登录成功」,不是「请求发出时」。取不到就返回 null,让请求带着
 * 标记头原样出去 —— 网关会回 401,渲染层按既有错误路径提示,不会静默失败。
 */
export function getActivePoolToken(): string | null {
  if (!activePool) return null
  return cache.get(poolKey(activePool)) ?? null
}

export async function getGatewayToken(pool: Pool): Promise<string> {
  const key = poolKey(pool)
  const hit = cache.get(key)
  if (hit) return hit

  const running = inflight.get(key)
  if (running) return running

  const task = fetchToken(pool)
    .then(async (token) => {
      cache.set(key, token)
      await persist().catch(() => {})
      return token
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}

async function fetchToken(pool: Pool): Promise<string> {
  const cred = getCredential()
  if (!cred?.token) {
    throw new GatewayTokenError('NOT_LOGGED_IN', '未登录,无法使用平台余额')
  }

  const url = new URL('/api/user/gateway-token', authBaseUrl())
  url.searchParams.set('projectId', String(pool.projectId))
  if (pool.producerProjectId) {
    url.searchParams.set('producerProjectId', String(pool.producerProjectId))
  }

  let resp: Response
  try {
    resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${cred.token}` },
    })
  } catch {
    // 断网 / DNS 失败。刻意不带原始错误 —— 它对用户无意义,而 message 里可能
    // 含完整 URL。可重试。
    throw new GatewayTokenError('NETWORK', '连不上服务器,请检查网络后重试', true)
  }

  const body = (await resp.json().catch(() => null)) as
    | { success?: boolean; data?: { token_key?: string }; error?: { code?: string; message?: string } }
    | null

  if (!resp.ok || !body?.success) {
    const code = body?.error?.code ?? `HTTP_${resp.status}`
    const message = body?.error?.message ?? '获取平台凭据失败'
    throw new GatewayTokenError(code, message, resp.status >= 500)
  }

  const token = body.data?.token_key
  if (!token) {
    // 200 但 body 畸形。**绝不把 body 打出来** —— 它畸形归畸形,仍可能夹带
    // 部分凭据。只记形状。
    throw new GatewayTokenError('MALFORMED_RESPONSE', '服务端返回的凭据格式不对', true)
  }
  return token
}

// ── 落盘 ───────────────────────────────────────────────────────────────────

function storePath(): string {
  return path.join(app.getPath('userData'), 'gateway-tokens.enc')
}

/**
 * Linux 上有没有真的加密。
 *
 * `isEncryptionAvailable()` 在 `basic_text` 后端下**也返回 true** —— 它只回答
 * 「有没有加密能力」,不回答「这个加密有没有用」。而 basic_text 用的是硬编码
 * 明文口令,等于没加密。我们出 AppImage,那正是最容易没有 secret store 的场景。
 *
 * 判据写成「等于 basic_text」而不是「不在白名单里」:该方法是 Linux 语义,
 * Windows/macOS 上可能返回 'unknown',用白名单会把这两个平台一起误伤。
 */
function encryptionIsReal(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  try {
    // app ready 之前调会返回 'unknown',所以这个函数只能在 ready 之后用。
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    // 该方法在部分平台上可能不存在(老版本 Electron)。存在性未知时按「不确定」
    // 处理,而不确定时宁可不落盘。
    return false
  }
}

async function persist(): Promise<void> {
  if (!encryptionIsReal()) return // 只留内存,重启后重取
  const payload = JSON.stringify(Object.fromEntries(cache))
  const buf = await safeStorage.encryptStringAsync(payload)
  await fs.writeFile(storePath(), buf)
}

export async function loadPersisted(): Promise<void> {
  if (!encryptionIsReal()) return
  try {
    const buf = await fs.readFile(storePath())
    // 异步版**不返回字符串**,返回 `{ shouldReEncrypt, result }`(electron.d.ts
    // 的 `DecryptStringAsyncReturnValue`)—— 与同步的 `decryptString` 不同。
    // 直接把它交给 `JSON.parse` 不只是类型错,运行时会被 stringify 成
    // "[object Object]" 而抛 SyntaxError,再被下面的 catch 吞掉:表现为
    // 「落盘了但重启后永远读不回来」,一个错都不报。
    // `shouldReEncrypt` 刻意不处理:token 是可丢弃的缓存,下次取用时会重新落盘。
    const { result: json } = await safeStorage.decryptStringAsync(buf)
    for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, string>)) {
      if (typeof v === 'string' && v) cache.set(k, v)
    }
  } catch {
    // 文件不存在 / 换了机器解不开 / 格式变了。都不是错误,重取即可。
  }
}

export async function clearGatewayTokens(): Promise<void> {
  cache.clear()
  inflight.clear()
  activePool = null
  await fs.rm(storePath(), { force: true }).catch(() => {})
}
