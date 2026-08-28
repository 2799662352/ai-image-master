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
/**
 * 登出代际。`clearGatewayTokens()` 自增,在途请求靠它判断自己是不是已经过期。
 *
 * 清 `inflight` 只删 Map 条目,**取消不了已经建好的 promise 链** —— 那条链稍后
 * 仍会 resolve 并接着写缓存、落盘,而 `fs.rm` 早就跑完了。结果是用户点完登出,
 * 盘上又躺回一枚永不过期、无法单独吊销的 token。
 */
let generation = 0

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

  const gen = generation
  const task = fetchToken(pool)
    .then(async (token) => {
      // 出发之后有人登出了。token 照常还给调用方(它自己会撞 401,不必额外造错),
      // 但**一个字节的状态都不能写** —— 写了就是把刚清空的缓存和刚删掉的加密
      // 文件原样填回去。
      if (gen !== generation) return token
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
 * 有没有**真的**加密。三道判断,每道都有依据:
 *
 * 1. 问 `isAsyncEncryptionAvailable()` 而不是同步的 `isEncryptionAvailable()`。
 *    异步加密器是惰性初始化的(electron.d.ts:11881),两者结论可以不一致;不一致
 *    时 `encryptStringAsync` 会 reject,而调用处的 `.catch(() => {})` 把它整个吞
 *    掉 —— 表现为「以为落了盘,其实一直没落」,零信号。落盘走异步链路,就得问
 *    异步链路自己的可用性。
 * 2. 非 Linux 直接认为有效。`getSelectedStorageBackend()` 标着 `@platform linux`
 *    (electron.d.ts:11874);Electron 43.2.0 + win32 实测 `typeof` 就是
 *    `'undefined'`,调用直接抛 TypeError。不短路的话它会掉进下面的 catch,等于
 *    **在我们的主力平台上永久关掉落盘** —— 每次重启白白多一次网络往返,还不报错。
 * 3. Linux 上只否掉 `basic_text`。它用硬编码明文口令,等于没加密,而
 *    `isEncryptionAvailable()` 在这个后端下**照样返回 true**(它只回答「有没有加密
 *    能力」,不回答「这加密有没有用」)。我们出 AppImage,那正是最容易没有 secret
 *    store 的场景。
 *
 *    判据是「等于 basic_text」而不是「在白名单里」:后端枚举一直在长(kwallet →
 *    kwallet5 → kwallet6),白名单写死在今天,明天 Electron 加个 kwallet7 就会静默
 *    停止落盘。只否掉已知坏的那一个,新来的按好的用。
 */
async function encryptionIsReal(): Promise<boolean> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false
    if (process.platform !== 'linux') return true
    // app ready 之前调会返回 'unknown',但那时上面一步已经是 false,走不到这里。
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    // 判不出来就当没加密:宁可每次重取,不可明文落盘。
    return false
  }
}

async function persist(): Promise<void> {
  if (!(await encryptionIsReal())) return // 只留内存,重启后重取
  const payload = JSON.stringify(Object.fromEntries(cache))
  const buf = await safeStorage.encryptStringAsync(payload)
  await fs.writeFile(storePath(), buf)
}

export async function loadPersisted(): Promise<void> {
  if (!(await encryptionIsReal())) return
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
  // 必须在 rm 之前:在途请求要靠它判断自己该不该继续写状态。
  generation += 1
  await fs.rm(storePath(), { force: true }).catch(() => {})
}
