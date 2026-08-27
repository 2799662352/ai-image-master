// IdP 客户端与派生的会话状态。token 只存在于主进程,渲染层只看得到 `getAuthState()`。
//
// 出网一律走 `net.fetch`(electron)而不是 Node 全局 fetch:前者走 Chromium 网络栈,
// 继承系统代理与企业根证书;后者两样都不继承,在有代理的办公网里直接失败。

import { net } from 'electron'
import { clearCredential, credentialSource, getCredential, setCredential } from './credentials'
// `AuthState` 的单一真源在 `src/types/authApi.ts` —— preload 与渲染层同吃一份,
// 不在这里再声明一遍(AgentApi 就是因为两处各写一份而漂移过)。
import type { AuthState } from '../../../types/authApi'
import { MAX_RECHARGE_CNY } from '../../../types/authApi'

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

// ───────────────────────────────────────────────────────────────────────────
// 用量明细与充值
//
// 与上面的额度查询同一条约定:**不与存活探测共用节流,也不做缓存。** 明细与订单状态都是
// 用户正盯着的实时数据 —— 充值后余额没变、轮询卡在旧状态,比多发一次请求糟得多。
//
// 查询参数一律 **camelCase**。BFF 收 camelCase、自己改名成 snake_case 再转发给 Go
// (`userOrg.ts:356-359`)。客户端「贴心地」提前改成 snake_case 的话,整组参数会被 BFF
// 忽略、静默退化成默认值 —— 表现成「筛选和翻页都没生效」,一个错都不报。
//
// 响应解包统一 `body.data ?? body`:usage 路由是 `{success:true,data}`、payment 路由是
// `{ok:true,data}`。两套成功信封的**标志位不同但负载都在 `data` 下**,所以一套解包够用;
// 反过来说,任何去读 `body.success` 来判断成败的写法都会在 payment 那半边静默失效。
// ───────────────────────────────────────────────────────────────────────────

/** 后端硬上限(`userOrg.ts`)。客户端也 clamp —— 别指望后端兜,兜不兜是另一份代码的事。 */
const MAX_PAGE_SIZE = 100

/**
 * 与后端默认值一致。**显式送出**而不是靠后端兜:响应里的 `page_size` 偶尔缺席,
 * 有个确定的回落值才能让 UI 算总页数(回落成 0 会算出 Infinity 页)。
 */
const DEFAULT_PAGE_SIZE = 20

// 单笔充值上限住在 `types/authApi.ts`,因为**渲染层也要它** —— 充值弹窗要在用户输入时
// 就地拦下超限,不能等一个 RTT 回来才说「金额超限」。跨进程共用一个常量的房规范例是
// `types/videoWorkbench.ts` 的 `WORKBENCH_STATUS_MAX_PAGE_SIZE`(主进程与渲染层各 import
// 同一份)。在两边各写一个 4000 必然漂移:改了一处、另一处继续放行,而错的那一侧要么
// 白发一次请求、要么把合法金额拦在门外。

export interface UsageLogRow {
  id: number
  /** Unix 秒(不是毫秒)。 */
  createdAt: number
  /** `2` = 消费,`6` = 退款。完整枚举见 `log.go:53-61`。 */
  type: number
  modelName: string
  /** 原始 quota 整数,**退款为负**。500000 = ¥1。 */
  quota: number
  promptTokens: number
  completionTokens: number
  feature: string | null
  tokenName: string | null
  projectId: number | null
  producerProjectId: number | null
}

export interface UsageLogPage {
  rows: UsageLogRow[]
  /** 后端 count **不按 type 过滤**,所以它含退款行。见 `log.go:333-342`。 */
  total: number
  /** **0 基**。 */
  page: number
  pageSize: number
}

export interface UsageModelSummary {
  /** 后端按 `model_name` 分组,GROUP BY 出来的那一组可以是 NULL。 */
  modelName: string | null
  /** **毛消费额,不含退款** —— 汇总 SQL 带 `WHERE type = LogTypeConsume`(`log.go:365`)。 */
  totalQuota: number
  totalRequests: number
  totalTokens: number
}

export interface UsageQuery {
  /** `0` = 不过滤。**注意 0 是合法值,不是「没传」。** */
  projectId: number
  /** **0 基**(`offset = page * pageSize`)。汇总不用这个字段。 */
  page?: number
  /** 汇总不用这个字段。 */
  pageSize?: number
  /** Unix 秒。后端 `>0` 才生效。 */
  startTime?: number
  endTime?: number
}

export type RechargeOrderStatus = 'PENDING' | 'PAID' | 'CREDITED' | 'CLOSED'

export interface RechargeOrder {
  outTradeNo: string
  status: RechargeOrderStatus
  /** 十进制字符串(如 `"100.00"`)。**刻意不转 number** —— 见 `money()` 的注释。 */
  totalAmount: string
  /** `PAID` 但入账影子账户失败时非空。 */
  creditError: string | null
}

export interface RechargeOrderCreated extends RechargeOrder {
  payUrl: string
}

/** 项目上下文**严格三选一**(`payment.ts:122-174`),不是三个可选字段。 */
export type RechargeTarget =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number }
  | { kind: 'producer'; producerId: number; producerProjectId: number }

/** 空串按「没有」处理:后端对缺席字段有时给 `null`、有时给 `''`,UI 只需要区分有/无。 */
function text(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/**
 * 金额一律按字符串透出,**不做任何算术**。
 *
 * 支付宝回的是十进制字符串(`"100.00"`)。`parseFloat` 再格式化一趟就足以把 ¥100 显示成
 * ¥99.99999 —— 二进制浮点表示不了 0.1 这类十进制小数。后端偶尔回数字时才 `String()` 一下。
 */
function money(v: unknown): string {
  if (typeof v === 'string') return v
  const n = num(v)
  return n === null ? '' : String(n)
}

/**
 * `projectId` + 时间范围。**明细与汇总共用**这一段,分页参数由明细自己追加 ——
 * 汇总端点不收分页,多发只是噪音。
 */
function usageParams(query: UsageQuery): URLSearchParams {
  const params = new URLSearchParams()
  // 逐个 `String()` 而不是靠 falsy 判断挑「有没有传」:`projectId=0` 是「不过滤」这个
  // 合法语义,被 `if (query.projectId)` 吞掉的话查出来的是别人的默认口径。
  params.set('projectId', String(num(query.projectId) ?? 0))

  // 后端 `>0` 才生效,所以 0 与负数一律不发。
  const start = num(query.startTime)
  const end = num(query.endTime)
  if (start !== null && start > 0) params.set('startTime', String(Math.trunc(start)))
  if (end !== null && end > 0) params.set('endTime', String(Math.trunc(end)))
  return params
}

function toUsageLogRow(raw: Record<string, unknown>): UsageLogRow {
  return {
    id: num(raw.id) ?? 0,
    createdAt: num(raw.created_at) ?? 0,
    type: num(raw.type) ?? 0,
    modelName: typeof raw.model_name === 'string' ? raw.model_name : '',
    // 退款(type=6)的 quota 是**负数**,原样透出。绝不 `Math.abs` ——
    // 取了绝对值,一笔退款在列表里看起来就是「又花了一笔钱」。
    quota: num(raw.quota) ?? 0,
    promptTokens: num(raw.prompt_tokens) ?? 0,
    completionTokens: num(raw.completion_tokens) ?? 0,
    feature: text(raw.feature),
    tokenName: text(raw.token_name),
    projectId: num(raw.project_id),
    producerProjectId: num(raw.producer_project_id),
  }
}

/**
 * 用量明细。响应是 Go `model.Log` 的**整体序列化**:全 snake_case、27 个字段、未脱敏
 * (`log.go:21-50`),排序固定 `id desc`。这里只挑本轮消费的字段归一成 camelCase。
 *
 * ⚠️ 明细的 where **没有 type 过滤**(`log.go:333-342`),而汇总有(`log.go:365`)。
 * 所以一条退款会出现在列表里、却不进汇总,`total` 也是无过滤集合的 count。这个不一致
 * **如实透出、不在这里替后端算净额**:列表是分页的,算出来的「净额」只对当前页成立,
 * 比毛额更误导。由 UI 把汇总标题写成「消费合计(不含退款)」。
 *
 * ⚠️ 端点**只收 `projectId`**(`userOrg.ts:350-354`),不收 `producerProjectId`。而
 * producer 池的键是 `(projectId, producerProjectId)` 两半 —— 选中 producer 池时查出来的
 * 是该 project 下**所有**子项目的流水。客户端过滤只能救列表、救不了服务端预聚合的汇总,
 * 救了还会让两者互相矛盾且分页全错,所以这里一个自造参数都不发,由 UI 给说明条。
 */
export async function fetchUsageLogs(query: UsageQuery): Promise<UsageLogPage> {
  const token = requireToken()

  const params = usageParams(query)
  // `page` 是 0 基,第一页就是那个会被 falsy 判断吞掉的 0 —— 恰好在最常用的一页上出错。
  const page = num(query.page)
  params.set('page', String(page !== null && page > 0 ? Math.trunc(page) : 0))

  const requested = num(query.pageSize)
  const pageSize =
    requested !== null && requested > 0
      ? Math.min(Math.trunc(requested), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  params.set('pageSize', String(pageSize))

  const { status, body } = await sendJson(`/api/user/usage-logs?${params}`, 'GET', { token })
  if (status >= 400) throw toAuthError(status, body)

  const data = (body.data ?? body) as Record<string, unknown>
  const logs = Array.isArray(data.logs) ? (data.logs as Record<string, unknown>[]) : []
  return {
    rows: logs.map(toUsageLogRow),
    total: num(data.total) ?? 0,
    page: num(data.page) ?? 0,
    // 缺 `page_size` 时回落到**本次实际送出的**值,不是 0:UI 拿它算总页数。
    pageSize: num(data.page_size) ?? pageSize,
  }
}

/**
 * 按模型分组的用量汇总。
 *
 * **后端不给顶层合计**(`log.go:355-360` 只返回分组数组),这里也不替它算 —— 算了就得
 * 决定「合计里算不算 model_name 为 NULL 的那一组」,而那是呈现决定,归 UI。
 *
 * ⚠️ 这是**毛消费额**:SQL 带 `WHERE type = LogTypeConsume`。new-api 自己算净额时用的是
 * `type IN (Consume, Refund)` 且排除 `settle_status = Cancelled`(`model/scoped_query.go:124`)
 * —— usage-summary 没走那条正确逻辑,别把它当净额用。
 */
export async function fetchUsageSummary(query: UsageQuery): Promise<UsageModelSummary[]> {
  const token = requireToken()
  const { status, body } = await sendJson(
    `/api/user/usage-summary?${usageParams(query)}`,
    'GET',
    { token },
  )
  if (status >= 400) throw toAuthError(status, body)

  const raw = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
  return (raw as Record<string, unknown>[]).map((s) => ({
    // GROUP BY 出来的组可以是 NULL(旧流水没记模型名)。落成 `''` 的话 UI 会渲染一行
    // 没有名字的空白条目,且与「模型名就是空串」分不开;`null` 才能显示「未标注模型」。
    modelName: text(s.model_name),
    totalQuota: num(s.total_quota) ?? 0,
    totalRequests: num(s.total_requests) ?? 0,
    totalTokens: num(s.total_tokens) ?? 0,
  }))
}

const RECHARGE_STATUSES: readonly RechargeOrderStatus[] = ['PENDING', 'PAID', 'CREDITED', 'CLOSED']

/**
 * 未知状态一律退化成 `PENDING`。
 *
 * 退化方向是刻意选的,不是随手挑的默认值:后端日后加一个终态(比如 `REFUNDED`),退成
 * `PENDING` 只会让轮询等到超时、显示「未完成」;退成 `CREDITED` 则是钱没到账却告诉用户
 * 到账了。两种错法的代价差好几个数量级。
 */
function toRechargeStatus(v: unknown): RechargeOrderStatus {
  return RECHARGE_STATUSES.includes(v as RechargeOrderStatus)
    ? (v as RechargeOrderStatus)
    : 'PENDING'
}

function toRechargeOrder(data: Record<string, unknown>): RechargeOrder {
  return {
    outTradeNo: text(data.outTradeNo) ?? '',
    status: toRechargeStatus(data.status),
    totalAmount: money(data.totalAmount),
    // 🚨 `PAID` **不是**完成态。钱收到了、但入账影子账户失败时,状态就停在 `PAID` 且
    // 这里非空。判「充值成功」必须看 `status === 'CREDITED'`,看 `PAID` 会误报到账。
    creditError: text(data.creditError),
  }
}

/**
 * 把 `RechargeTarget` 展开成**正好一组**互斥字段(`payment.ts:122-174`)。
 *
 * - `personal`:后端固定落到 env 的落点并**跳过成员校验**。再夹带 `projectId` 就会走进
 *   校验分支,而个人落点刻意**不出现在** `/api/user/organizations` 的返回里 → 查不到
 *   `joined` → fail-closed 403。多发一个字段的代价是整条充值路径不可用。
 * - `producer`:两半必须**成对**,缺一后端 400 —— 池键是 `(producerId, producerProjectId)`。
 *
 * 用 switch + `never` 兜底而不是 `if/else`:日后加一种目标,漏改这里是**编译错误**,
 * 而不是发出一个没有项目上下文的 body 让后端猜落点。
 */
function rechargeScope(target: RechargeTarget): Record<string, unknown> {
  switch (target.kind) {
    case 'personal':
      return { personal: true }
    case 'project':
      return { projectId: target.projectId }
    case 'producer':
      return { producerId: target.producerId, producerProjectId: target.producerProjectId }
    default: {
      const exhaustive: never = target
      throw new AuthError('INVALID_TARGET', 400, `未知的充值目标 ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * 建支付宝充值单。三步流程的第一步,后两步是 `shell.openExternal(payUrl)` 与轮询
 * `fetchRechargeOrder`。
 *
 * `payUrl` 由支付宝 SDK **现签**(`alipayService.ts:139-160`),含订单号与
 * `timeout_express`(默认 10m)。**一次性:不能拼、不能缓存、不能预生成** —— 存下来的
 * 链接过期后点开是支付宝的报错页,而用户以为是本应用坏了。
 */
export async function createRechargeOrder(
  amountCny: number,
  target: RechargeTarget,
  subject?: string,
): Promise<RechargeOrderCreated> {
  const token = requireToken()

  // 越界在主进程就拒,不打到后端换一个 400 回来:那样用户要多等一个 RTT 才看到「金额超限」,
  // 而这条判断本地就能下。写成 `!(x > 0)` 而不是 `x <= 0` 是为了同时挡住 NaN
  // (`NaN <= 0` 是 false,会一路放行到后端)。
  if (!(amountCny > 0) || amountCny > MAX_RECHARGE_CNY) {
    throw new AuthError(
      'INVALID_AMOUNT',
      400,
      `充值金额需在 ¥0.01 ~ ¥${MAX_RECHARGE_CNY} 之间(当前 ${amountCny})`,
    )
  }

  const { status, body } = await sendJson('/api/payment/alipay/orders', 'POST', {
    token,
    body: {
      amountCny,
      orderType: 'balance_recharge',
      ...(subject ? { subject } : {}),
      ...rechargeScope(target),
    },
  })
  if (status >= 400) throw toAuthError(status, body)

  const data = (body.data ?? body) as Record<string, unknown>
  return {
    ...toRechargeOrder(data),
    // 缺 payUrl 就无处可跳,是硬失败 —— 让它在这里响亮地抛,而不是把用户送到 about:blank。
    payUrl: requireString(data.payUrl, 'payUrl', status),
  }
}

/**
 * 查单。轮询到 `CREDITED` 才算充值完成 —— 见 `toRechargeOrder` 里那条 🚨。
 * 刻意不做任何缓存或节流:这就是那个用户盯着看的数字。
 *
 * ⚠️ **建单与查单的响应形状不对称**:建单是 `{ok,data}` 且 `data` 直接就是订单
 * (`payment.ts:151,219`),查单在外面**多包一层** `data.order`(`payment.ts:310-329`)。
 * 同一个资源、两个形状。
 *
 * 漏剥这一层不会抛任何错:字段全读成 `undefined`,`toRechargeStatus` 把它退化成
 * `PENDING`(那个退化方向本身是对的),于是轮询**永远等不到 `CREDITED`** —— 用户付了钱、
 * 钱也到了账,应用一路显示「未完成」直到 5 分钟超时。这条最初就是这么写错的,连测试
 * 都用了扁平 mock 陪着一起绿,直到拿后端源码对账才露出来。
 *
 * 写成 `data.order ?? data` 而不是只认 `data.order`:两个函数共用 `toRechargeOrder`,
 * 只认嵌套会反过来把建单弄坏。两条形状各有一条用例钉着。
 */
export async function fetchRechargeOrder(outTradeNo: string): Promise<RechargeOrder> {
  const token = requireToken()
  const { status, body } = await sendJson(
    `/api/payment/alipay/orders/${encodeURIComponent(outTradeNo)}`,
    'GET',
    { token },
  )
  if (status >= 400) throw toAuthError(status, body)

  const data = (body.data ?? body) as Record<string, unknown>
  const order = (data.order ?? data) as Record<string, unknown>
  return toRechargeOrder(order)
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
