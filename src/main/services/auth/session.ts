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

// ───────────────────────────────────────────────────────────────────────────
// 账号额度查询
//
// **与下面的存活探测严格分开,不共用节流。** 探测刻意**不传** projectId,靠后端在
// `userOrg.ts:138-143` 提前 400 短路、在触达 `newApiService` 之前返回,所以正常路径
// 零外部依赖。额度查询要真传 projectId,会真打 New API —— 两者混用一个节流窗口的
// 后果是:余额查询顺手重置探测窗口,封号检测的实际间隔被拉长到不可预期。
//
// 这几个函数刻意**不做缓存**:余额是用户随时会盯着的数字(充值后、切组织后必须立刻变),
// 缓存带来的「显示旧值」比多发一次请求糟得多。调用频率由 UI 控制。
// ───────────────────────────────────────────────────────────────────────────

/** 500000 quota = ¥1。取自 `new-api/constant/org.go:40`,不要在别处另写一份。 */
const QUOTA_PER_YUAN = 500_000

export interface AccountBalance {
  balanceYuan: number
  balanceQuota: number | null
}

export interface AccountOrganization {
  id: number
  name: string
  studioName: string | null
  balanceYuan: number
  joined: boolean
  /**
   * 仅 producer 项目有。**它是池键的另一半** —— 两个 producer project 可以共用一个
   * `id`,只按 `id` 认会把两个不同的池悄悄合并、把钱记到错的地方。
   */
  producerProjectId?: number
}

export interface PaymentConfig {
  /** 个人计费落点 project id;后端未配置 `PERSONAL_BILLING_PROJECT_ID` 时为 null。 */
  personalBillingProjectId: number | null
}

function requireToken(): string {
  const cred = getCredential()
  if (!cred) throw new AuthError('NOT_AUTHENTICATED', 401, '未登录')
  return cred.token
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 余额。
 *
 * 两种字段拼法都要认:project 池回 `balance_yuan`,producer 池回 `quota_yuan`
 * (shortdrama 的 `billing/platform.ts:136` 实测踩到过)。只认一种会静默显示 ¥0,
 * 而用户看到 0 会以为余额空了 —— 比报错更糟。两个都没有时用 quota 自己换算。
 */
export async function fetchBalance(
  projectId: number,
  producerProjectId?: number,
): Promise<AccountBalance> {
  const token = requireToken()
  const path = producerProjectId
    ? `/api/user/producer-balance?producerId=${projectId}&producerProjectId=${producerProjectId}`
    : `/api/user/balance?projectId=${projectId}`

  const { status, body } = await sendJson(path, 'GET', { token })
  if (status >= 400) throw toAuthError(status, body)

  const data = (body.data ?? body) as Record<string, unknown>
  const quota = num(data.balance_quota)
  const yuan = num(data.balance_yuan) ?? num(data.quota_yuan)
  return {
    balanceQuota: quota,
    balanceYuan: yuan ?? (quota === null ? 0 : quota / QUOTA_PER_YUAN),
  }
}

/**
 * 用户可用的计费池。
 *
 * 用**用户自己的 token** 打,所以后端不可能返回他无权访问的池 —— 权限校验不需要在
 * 客户端再做一遍。注意后端响应里的 `role` 是硬编码的 `'member'`(`userOrg.ts:109`),
 * 没有信息量,这里不透出。
 */
export async function fetchOrganizations(): Promise<AccountOrganization[]> {
  const token = requireToken()
  const { status, body } = await sendJson('/api/user/organizations', 'GET', { token })
  if (status >= 400) throw toAuthError(status, body)

  const raw = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
  return (raw as Record<string, unknown>[]).map((p) => {
    const ppid = num(p.producerProjectId)
    return {
      id: num(p.id) ?? 0,
      name: typeof p.name === 'string' ? p.name : '',
      studioName: typeof p.studioName === 'string' ? p.studioName : null,
      balanceYuan: num(p.balanceYuan) ?? 0,
      joined: p.joined === true,
      // 只在 > 0 时带上:后端对普通 project 回 0 或缺省,而 0 不是一个合法的池键成分。
      ...(ppid !== null && ppid > 0 ? { producerProjectId: ppid } : {}),
    }
  })
}

/**
 * 按次/按秒配额 —— 与 ¥ 余额**互相独立的第二道闸**,任一为零都会拒绝生成。
 * 原样透出后端字段,由 UI 决定怎么呈现;这里不做「够不够」的判断。
 */
export async function fetchQuota(): Promise<Record<string, unknown>> {
  const token = requireToken()
  const { status, body } = await sendJson('/api/user/quota', 'GET', { token })
  if (status >= 400) throw toAuthError(status, body)
  return (body.data ?? body) as Record<string, unknown>
}

/**
 * 支付配置 —— 只为拿「个人计费」的落点 project id。
 *
 * **绝不要硬编码这个 id。** 它由后端 env `PERSONAL_BILLING_PROJECT_ID` 下发
 * (`utils/personalBilling.ts`),且该 project 刻意**不出现在** `/api/user/organizations`
 * 的返回里 —— 那是它的设计前提,不是漏掉了。
 */
export async function fetchPaymentConfig(): Promise<PaymentConfig> {
  const token = requireToken()
  const { status, body } = await sendJson('/api/payment/config', 'GET', { token })
  if (status >= 400) throw toAuthError(status, body)

  const data = (body.data ?? body) as Record<string, unknown>
  const pb = data.personalBilling as { enabled?: unknown; projectId?: unknown } | undefined
  const id = num(pb?.projectId)
  return { personalBillingProjectId: pb?.enabled === true && id !== null ? id : null }
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
