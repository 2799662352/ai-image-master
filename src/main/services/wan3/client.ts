/**
 * 万相 3.0 的 HTTP 客户端 —— provider 分派的第三处（前两处是组包与响应解析）。
 *
 * 打的是 Miau（new-api）的视频端点：
 *   POST {base}/video/generations       创建任务
 *   GET  {base}/video/generations/{id}  查询任务
 *
 * `fetch` 由外部注入，默认由调用方传入 Electron 的 `net.fetch`。注入的意义不只是
 * 可测：整条请求塑形能在没有 Electron 的环境下被断言。查询信封已于 2026-08-14
 * 用真网关钉死（见 `response.ts`），单测用那份真实回形做夹具。
 */

import { MIAU_BASE_URL } from '../../../shared/miau'
import { SeedanceApiError } from '../seedance/apiError'
import { retrySubmit, type RetrySubmitOptions } from '../seedance/submitRetry'
import type { Wan3CreateTaskBody } from './request'
import { parseWan3TaskResult, type Wan3TaskResult } from './response'

/**
 * 单次请求的硬超时。与 Seedance 那条同一个数：创建/查询都是轻量 JSON 接口，
 * 正常 <2s；不设超时的话，代理或上游 TCP 半开会让 fetch 永远悬挂，用户视角就是
 * 卡片一直转圈。
 */
export const WAN3_REQUEST_TIMEOUT_MS = 30_000

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * 这一次往返的**整份**鉴权头。
 *
 * 收整份而不是一枚 apiKey,是因为万相同一条 transport 要服务两种计费:
 *  - 自填 Key → `{ Authorization: 'Bearer <miau key>' }`
 *  - 平台余额 → `gatewayPlatformHeaders(<影子 token>)`,里面除了 Authorization
 *    还有三个计费归属头。
 *
 * 拆成「apiKey + 可选的额外头」会重新打开那个已经堵过一次的洞:归属头漏了照样能
 * 出片、钱也扣对,只是平台用量明细里一条都查不到,而且**一个错都不报**。
 * (同一条纪律见 `auth/gatewayToken.gatewayPlatformHeaders` 的注释:刻意不提供
 * 只取 Authorization 的入口。)
 *
 * 凭据缺席的判断因此也归调用方 —— transport 的 `requireApiKey` 早就在做这件事,
 * 而且它分得清「没选计费池」和「没填 Miau Key」这两句完全不同的人话。
 */
export type Wan3AuthHeaders = Readonly<Record<string, string>>

export interface Wan3Client {
  createTask: (body: Wan3CreateTaskBody, auth: Wan3AuthHeaders) => Promise<{ id: string }>
  queryTask: (taskId: string, auth: Wan3AuthHeaders) => Promise<Wan3TaskResult>
}

export interface Wan3ClientOptions {
  /**
   * 必填，而不是默认取 Electron 的 `net.fetch`。顶层 `import { net } from 'electron'`
   * 会让这个模块在 Electron 之外根本加载不了 —— 注入 fetch 的意义就废了一半，
   * 连对着真网关跑烟测都做不到。Electron 依赖留在组合根（调用方本来就在主进程）。
   */
  fetchImpl: FetchLike
  baseUrl?: string
  /**
   * 「这次往返动了钱」的回调,用来触发余额刷新。只在**提交成功**与**轮询到终态**
   * 时调 —— 中间那些 running 轮询一分钱不动,报了就是给一条视频白查十几次余额。
   * 与 `seedanceGateway/client.ts` 同一个形状与同一条理由。
   */
  onBilledExchange?: () => void
  /** 提交重试的注入点，测试用来去掉真实等待。 */
  retryOptions?: RetrySubmitOptions
}

/** 上游不会再变、余额已经结清的状态。只有走到这几个才值得刷余额。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * 兜底守卫。凭据缺席的**人话**归 transport 说(它分得清「没选计费池」和「没填
 * Miau Key」),这里只挡住「头都组错了」这种编程错误,免得裸奔出去撞一个
 * 看不懂的 401。
 */
function requireAuth(auth: Wan3AuthHeaders): Wan3AuthHeaders {
  // 大小写不敏感找头名:HTTP 头本来就不区分,而调用方各写各的拼写(我们自己写
  // `Authorization`,`gatewayPlatformHeaders` 也是,但没有任何东西保证第三处也是)。
  const value = Object.entries(auth).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  // 光判整串非空不够:`Bearer ` 加一个空 token 也是非空的,而它出网就是一个 401。
  // 去掉 scheme 之后还得剩下东西。
  const token = (value ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    throw new Error('未配置 Miau 密钥,无法使用万相 3.0。请先在设置里填写图片生成的 Miau Key。')
  }
  return auth
}

/** 读 body 但绝不因为解析失败而丢掉状态码 —— 502 的 HTML 页面也要能报出 502。 */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * 错误信封有两种，都是对着真网关探出来的：
 *   网关自身  {"error":{"code":"model_not_found","message":"...","type":"new_api_error"}}
 *   上游透传  {"code":"task_not_exist","message":"task_not_exist","data":null}
 * 只认一种，另一种就退化成一句没有信息量的「万相 API 5xx」。
 */
function extractError(json: Record<string, unknown> | null): { code?: string; message?: string } {
  for (const layer of [asRecord(json?.error), json ?? {}, asRecord(json?.output)]) {
    const code = asString(layer.code)
    const message = asString(layer.message)
    if (code || message) return { code, message }
  }
  return {}
}

/**
 * 网关把这些当 5xx 回，但它们是永久性的：`model_not_found` 意思是「当前 key 的分组
 * 下没有该模型的通道」，重发三次只是让用户多等十秒再看到同一句话。
 */
const PERMANENT_GATEWAY_CODES = new Set(['model_not_found', 'invalid_api_key', 'insufficient_quota'])

/**
 * 保留 `SeedanceApiError` 的身份（下游 pollLoop / submitRetry 都按它判断），只在
 * 上面盖一层「按错误码判永久」的覆盖。
 */
class Wan3ApiError extends SeedanceApiError {
  constructor(
    message: string,
    status: number,
    private readonly permanent: boolean,
  ) {
    super(message, status)
    this.name = 'Wan3ApiError'
  }

  override get retryable(): boolean {
    return this.permanent ? false : super.retryable
  }
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  auth: Wan3AuthHeaders,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WAN3_REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // 整份铺开:平台模式下这里除了 Authorization 还带三个计费归属头,
        // 少了它们钱扣对了但流水查不到。见 `Wan3AuthHeaders`。
        // 提交与轮询都带 —— 轮询触发的差额结算会再写一条日志,那条同样要归属。
        ...auth,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  } finally {
    clearTimeout(timer)
  }

  const json = await readJson(res)
  if (!res.ok) {
    const { code, message } = extractError(json)
    const detail = [code, message].filter(Boolean).join(': ')
    throw new Wan3ApiError(
      `万相 API ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status,
      code ? PERMANENT_GATEWAY_CODES.has(code) : false,
    )
  }
  return json ?? {}
}

export function createWan3Client(options: Wan3ClientOptions): Wan3Client {
  const baseUrl = (options.baseUrl ?? MIAU_BASE_URL).replace(/\/+$/, '')
  const { fetchImpl } = options
  // 缺省 no-op:自填 Key 那条路不花平台余额,没有可刷的东西。
  const noteBilled = options.onBilledExchange ?? ((): void => {})

  return {
    async createTask(body, auth) {
      // 凭据校验放在重试外:它不会因为再试一次而变好。
      const headers = requireAuth(auth)
      // 复用 Seedance 的提交重试。它只重发「能确定上游没受理」的失败,这条判据对
      // 万相同样成立 —— 万相按秒计费,重复建任务同样是一笔没人认领、跑到完的钱。
      return retrySubmit(async () => {
        const json = await request(
          fetchImpl,
          `${baseUrl}/video/generations`,
          { method: 'POST', body: JSON.stringify(body) },
          headers,
        )
        const output = (json.output ?? {}) as Record<string, unknown>
        const id = asString(output.task_id) ?? asString(json.task_id) ?? asString(json.id)
        if (!id) {
          // 没有任务号就无从轮询,而任务很可能已经在上游跑起来了。抛普通 Error
          // (非 SeedanceApiError)使它落在「不安全重发」一侧:重发只会再建一个
          // 同样认领不到的任务。
          //
          // 刻意**不**在这里报消费:这一支会被上层当成失败处理,而它到底扣没扣钱
          // 无从判断。少报一次只是余额晚点刷新,而这条路本来就已经是异常态。
          throw new Error('万相返回里没有任务号,无法跟踪这次生成')
        }
        // 提交成功 = 上游已预扣。报在这里而不是 `request()` 里:那样重试的每一趟
        // 失败往返都会报一次,而失败的往返不动钱。
        noteBilled()
        return { id }
      }, options.retryOptions)
    },

    async queryTask(taskId, auth) {
      const headers = requireAuth(auth)
      const json = await request(
        fetchImpl,
        `${baseUrl}/video/generations/${encodeURIComponent(taskId)}`,
        { method: 'GET' },
        headers,
      )
      const result = parseWan3TaskResult(json)
      // 终态才结算。见 `TERMINAL_STATUSES` 与 `onBilledExchange` 的注释。
      if (TERMINAL_STATUSES.has(result.status)) noteBilled()
      return result
    },
  }
}
