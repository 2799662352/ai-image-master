// IdP 客户端与派生的会话状态。token 只存在于主进程,渲染层只看得到 `getAuthState()`。
//
// 出网一律走 `net.fetch`(electron)而不是 Node 全局 fetch:前者走 Chromium 网络栈,
// 继承系统代理与企业根证书;后者两样都不继承,在有代理的办公网里直接失败。

import { net } from 'electron'
import { clearCredential, credentialSource, getCredential, setCredential } from './credentials'
// `AuthState` 的单一真源在 `src/types/authApi.ts` —— preload 与渲染层同吃一份,
// 不在这里再声明一遍(AgentApi 就是因为两处各写一份而漂移过)。
import type { AuthState } from '../../../types/authApi'

const DEFAULT_BASE_URL = 'https://13797248455.xyz'
const REQUEST_TIMEOUT_MS = 15_000
const PROBE_INTERVAL_MS = 60_000

export type { AuthState }

export interface PairingStart {
  pairingId: string
  authorizeUrl: string
  expiresIn: number
}

/** 带后端错误码的异常,供 IPC 层映射成用户文案(`PAIRING_EXPIRED` → 「二维码过期了」)。 */
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * 每次调用都重读环境变量 —— 不能在模块加载时求值。
 * 主进程模块在 `app` ready 之前就被 import,那时测试或启动脚本可能还没写入覆盖值。
 */
export function authBaseUrl(): string {
  const raw = process.env.CATIMATION_AUTH_BASE_URL?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

/**
 * 非 2xx **不抛异常**,原样交回 `{ status, body }`。
 *
 * 配对路径要把错误码抛给调用方,存活探测却要按状态码分支(401/403 清凭证、其余视为存活),
 * 两者对「失败」的定义不同。在这一层就抛的话,探测端要靠 catch 里反解异常来区分,
 * 分不清「HTTP 403」和「网络断了」—— 而这两者的正确处置恰好相反。
 */
async function sendJson(
  path: string,
  method: 'GET' | 'POST',
  opts: { body?: Record<string, unknown>; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`

    const res = await net.fetch(`${authBaseUrl()}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    })

    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await res.json()
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
    } catch {
      // 空响应体(如 204)或非 JSON 错误页。状态码本身已经够用了。
    }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 后端有**两套**错误信封,两套都要认:
 *   - 配对路由(`desktopAuth.ts:17`):`{ success:false, error:{ code, message } }`
 *   - `authMiddleware`(`middleware/auth.ts:66,84,92,103`):`{ success:false, message }`,**没有 code**
 *
 * 只解析第一套的话,探测路径上的 401/403 会拿到 `undefined` 错误码,封号检测静默失效。
 * 拿不到 code 时按状态码合成 `HTTP_403`,保证 code 永远是个非空字符串。
 */
function toAuthError(status: number, body: Record<string, unknown>): AuthError {
  const enveloped = body.error as { code?: unknown; message?: unknown } | undefined
  const code =
    typeof enveloped?.code === 'string' && enveloped.code ? enveloped.code : `HTTP_${status}`
  const message =
    (typeof enveloped?.message === 'string' && enveloped.message) ||
    (typeof body.message === 'string' && body.message) ||
    `请求失败(HTTP ${status})`
  return new AuthError(code, status, message)
}

function requireString(v: unknown, field: string, status: number): string {
  if (typeof v !== 'string' || !v) {
    throw new AuthError('MALFORMED_RESPONSE', status, `响应缺少字段 ${field}`)
  }
  return v
}

/**
 * `POST /api/auth/desktop/start` —— 公开端点,成功是 **201** 而不是 200。
 *
 * `pkce` 是**必填**的,不是可选的。后端缺 `codeChallenge` 或 `state` 会 400,而 claim
 * 阶段还要用与之配对的 `codeVerifier` —— verifier 归 IPC 编排层(Task 5)持有,所以
 * challenge/state 必须由它传进来。
 *
 * 这里刻意**不**提供「省略时自行生成一对」的兜底:那样 start 会成功,但生成的 verifier
 * 无人持有,失败要推迟到两步之后的 claim 才以 `PKCE_MISMATCH` 的面目出现,比 start 处
 * 一个响亮的 400 难查得多。设成必填,忘记传就是编译错误,连运行都到不了。
 */
export async function startPairing(
  clientName: string,
  callback: { host: string; port: number } | null,
  pkce: { codeChallenge: string; state: string },
): Promise<PairingStart> {
  const body: Record<string, unknown> = {
    codeChallenge: pkce.codeChallenge,
    state: pkce.state,
    clientName,
  }
  if (callback) {
    body.callbackHost = callback.host
    body.callbackPort = callback.port
  }

  const { status, body: res } = await sendJson('/api/auth/desktop/start', 'POST', { body })
  if (status >= 400) throw toAuthError(status, res)

  const data = (res.data ?? {}) as Record<string, unknown>
  const expiresIn = data.expiresIn
  return {
    pairingId: requireString(data.pairingId, 'pairingId', status),
    authorizeUrl: requireString(data.authorizeUrl, 'authorizeUrl', status),
    expiresIn: typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 0,
  }
}

/**
 * `POST /api/auth/desktop/claim` —— 公开端点(此刻客户端还没有任何凭证),成功是 200。
 * 安全性来自「一次性 grantCode + S256 verifier 比对」,不是鉴权头。
 */
export async function claimPairing(
  pairingId: string,
  grantCode: string,
  codeVerifier: string,
): Promise<void> {
  const { status, body } = await sendJson('/api/auth/desktop/claim', 'POST', {
    body: { pairingId, grantCode, codeVerifier },
  })
  if (status >= 400) throw toAuthError(status, body)

  const data = (body.data ?? {}) as Record<string, unknown>
  const user = (data.user ?? {}) as Record<string, unknown>
  const expiresAt = data.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new AuthError('MALFORMED_RESPONSE', status, '响应缺少字段 expiresAt')
  }

  const username = requireString(user.username, 'user.username', status)

  // `displayName` / `role` 在 AuthSession 上是**可选**的,且后端 `issueSessionForUserId`
  // 对空 displayName 传的是 `''`。兜底是必需的,不是装饰:Task 3 的 `parseCredential()`
  // 逐字段校验类型,写进一条 `displayName: undefined` 的凭证,**下次启动**读出来会被判成
  // 「无凭证」—— 用户看到的是「登录成功了,但重启后又忘了我」,而写入侧一切正常。
  // 用 `||` 而不是 `??`:`''` 也要兜底。
  setCredential({
    token: requireString(data.token, 'token', status),
    userId: requireString(user.id, 'user.id', status),
    username,
    displayName: (typeof user.displayName === 'string' && user.displayName) || username,
    role: (typeof user.role === 'string' && user.role) || 'USER',
    expiresAt,
  })
}

/** 渲染层唯一看得到的东西 —— 刻意不含 token,任何分支都不含。 */
export function getAuthState(): AuthState {
  const cred = getCredential()
  if (!cred) {
    return {
      authenticated: false,
      username: null,
      displayName: null,
      role: null,
      credentialSource: credentialSource(),
    }
  }
  return {
    authenticated: true,
    username: cred.username,
    displayName: cred.displayName,
    role: cred.role,
    credentialSource: credentialSource(),
  }
}

let lastProbeAt = 0

/**
 * 封号/踢下线探测。打一个挂在 `authMiddleware` 后面的端点 —— 中间件自己查库
 * (`middleware/auth.ts:81-95`):用户不存在 → 401,`isActive === false` → 403。
 *
 * **绝不能用 `POST /api/auth/verify`**:它只回显 JWT claims、不查库(`routes/auth.ts:267`),
 * 封号了照样通过,探测形同虚设。
 *
 * 选 `GET /api/user/balance` 且**不带 projectId**:token 坏 → 401,封号 → 403,正常 →
 * 处理器因缺 projectId 在 `userOrg.ts:138-143` 提前返回 400,**在触达 `newApiService`
 * 之前**(第 145 行),所以正常路径不产生任何外部依赖调用。
 * ⚠️ 已知耦合:上一句依赖「projectId 校验早于 New API 调用」这个顺序。后端若日后调换,
 * 探测会变成每 60 秒打一次 New API。
 */
export async function probeLiveness(): Promise<void> {
  const cred = getCredential()
  if (!cred) return

  const now = Date.now()
  if (now - lastProbeAt < PROBE_INTERVAL_MS) return
  // 必须在**发请求前**就更新:放到 await 之后的话,并发调用会全部越过上面的缓存检查,
  // 各发一次请求。
  lastProbeAt = now

  // 请求参数在 try **之外**求值:fail-open 的 catch 只该吞网络故障,不该顺带吞掉这一段
  // 自己的编程错误 —— 那会让 bug 表现成「探测悄悄不工作了」,而封号检测正是靠它。
  const token = cred.token

  let status: number
  try {
    ;({ status } = await sendJson('/api/user/balance', 'GET', { token }))
  } catch {
    // fail-open:认证服务故障、断网、超时都不该把用户锁在门外。静默返回,保住登录态。
    // 这里刻意不打日志 —— 离线时每 60 秒刷一条噪音,淹掉真正的错误。
    return
  }

  // **只有** 401/403 才清凭证。其余状态码(含正常路径上的 400)一律视为存活。
  if (status === 401 || status === 403) clearCredential()
}

export function logout(): void {
  clearCredential()
}
