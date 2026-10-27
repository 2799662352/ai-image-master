// 与平台后端之间**唯一**的一处出网点:基址 + `net.fetch` + 超时 + 中止,四件事只在这里组合一次。
//
// **刻意做成叶子模块,和 `authBaseUrl.ts` 同一个理由**(见那边顶部):调用方现在有两拨 ——
// `session.ts`(登录/额度/充值)与 `portraitLibrary/platformAssets.ts`(人像库)。若把它留在
// `session.ts` 里导出,人像库一 import 就顺带把 `session.ts → gatewayToken.ts` 整条拉进来,
// 而 `gatewayToken.ts` 持有模块级的明文 token 缓存与登出代际计数器 —— 人像库既用不到它,
// 也不该让它出现在自己的测试夹具里(`session.test.ts` 为此专门 mock 掉了 gatewayToken)。
//
// 本模块只 import `electron` 与两个无依赖的叶子,不会成环。
//
// 出网一律走 `net.fetch`(electron)而不是 Node 全局 fetch:前者走 Chromium 网络栈,
// 继承系统代理与企业根证书;后者两样都不继承,在有代理的办公网里直接失败。

import { net } from 'electron'
import { authBaseUrl } from './authBaseUrl'
import { getCredential } from './credentials'

const REQUEST_TIMEOUT_MS = 15_000

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

export type BackendMethod = 'GET' | 'POST' | 'DELETE' | 'PATCH'

export interface BackendRequestOptions {
  /** JSON 体。与 `form` 互斥。 */
  body?: Record<string, unknown>
  /**
   * multipart 体。传它时**绝不会**设 `Content-Type` —— 少了 fetch 自己生成的 boundary,
   * 服务端 multer 解不出任何字段,回一个「未收到文件」的 400。
   *
   * 必须是**原生** `FormData`(配原生 `Blob`),不能用 npm 的 `form-data` 包:
   * `net.fetch` 只认标准 Fetch 的 BodyInit,拿到 `form-data` 实例会把它序列化成字符串
   * `[object FormData]` 发出去(实证:CherryHQ/cherry-studio#18021)。
   */
  form?: FormData
  token?: string
  /**
   * 额外请求头。**不能覆盖** Authorization / Accept / Content-Type —— 那三个由本函数拥有,
   * 调用方传进来的同名键(**不分大小写**)在组头时被抹掉,见 `OWNED_HEADERS`。
   */
  headers?: Record<string, string>
  /** 默认 15s。服务端长轮询类端点必须显式放大到超过服务端自己的上限。 */
  timeoutMs?: number
}

/**
 * 本函数拥有的三个头。HTTP 头名**大小写不敏感**,而 `{...opts.headers, Accept: …}` 只在
 * 同大小写时才是「覆盖」—— 调用方传个小写 `authorization`,两个键就会**并存**,fetch 构造
 * Headers 时合并成 `Bearer A, Bearer B` → 401,而从调用点看不出任何异常。
 * 所以在组头时按小写比对逐个抹掉,让「本函数拥有」是结构上成立的,而不是靠人记。
 */
const OWNED_HEADERS = ['authorization', 'accept', 'content-type']

function dropOwnedHeaders(headers: Record<string, string>): void {
  for (const k of Object.keys(headers)) {
    if (OWNED_HEADERS.includes(k.toLowerCase())) delete headers[k]
  }
}

/**
 * 非 2xx **不抛异常**,原样交回 `{ status, body }`。
 *
 * 配对路径要把错误码抛给调用方,存活探测却要按状态码分支(401/403 清凭证、其余视为存活),
 * 两者对「失败」的定义不同。在这一层就抛的话,探测端要靠 catch 里反解异常来区分,
 * 分不清「HTTP 403」和「网络断了」—— 而这两者的正确处置恰好相反。
 *
 * 错误信封的解析**不在这里** —— 后端有三套形状,各调用方按自己那批端点映射(见
 * `session.ts:toAuthError` 与 `platformAssets.ts:toAssetError`)。
 */
export async function sendJson(
  path: string,
  method: BackendMethod,
  opts: BackendRequestOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { ...opts.headers }
    dropOwnedHeaders(headers)
    headers.Accept = 'application/json'
    // 走 form 分支时一个 Content-Type 都不设:少了 fetch 自己生成的 boundary,
    // 服务端 multer 解不出任何字段。
    if (!opts.form && opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`

    const res = await net.fetch(`${authBaseUrl()}${path}`, {
      method,
      headers,
      body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
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
 * 平台 JWT。**两拨调用方共用一份**,好让「未登录」在整个主进程里只有一个错误码 ——
 * IPC 层的信封是按 code 分支的,各写一份必然漂移成两个码。
 */
export function requireToken(): string {
  const cred = getCredential()
  if (!cred) throw new AuthError('NOT_AUTHENTICATED', 401, '未登录')
  return cred.token
}

/**
 * 2xx 响应里**声明成必填**的字符串字段的守卫 —— 缺了就抛,不让 `undefined` 顶着
 * `string` 的类型往下游流。
 *
 * 判据是「缺了还能不能继续」而不是「重不重要」:`session.ts` 用它守 `payUrl`(缺了
 * 就无处可跳,只能把用户送到 about:blank)、`platformAssets.ts` 用它守资产 `Id`
 * (缺了 poll 会打出 `/assets/undefined/poll`,而这个 id 还要被持久化)。
 *
 * 和 `sendJson`/`AuthError` 同住这个叶子,是因为两拨调用方都要用它,而放在 `session.ts`
 * 会把 token 缓存拖进人像库的依赖图(理由同本文件顶部);各写一份则必然漂移成两个错误码。
 */
export function requireString(v: unknown, field: string, status: number): string {
  if (typeof v !== 'string' || !v) {
    throw new AuthError('MALFORMED_RESPONSE', status, `响应缺少字段 ${field}`)
  }
  return v
}
