/**
 * 「经 Miau 网关提交 Seedance」的 HTTP 客户端。
 *
 *   POST {base}/video/generations   创建任务
 *   GET  {base}/videos/{id}         查询任务   ← 见下面的 ⚠️
 *
 * `MIAU_BASE_URL` 已含 `/v1`,所以这里拼的是相对段。
 *
 * `fetch` 由外部注入。理由同 wan3：顶层 `import { net } from 'electron'` 会让这个
 * 模块在 Electron 之外根本加载不了 —— 那样连对着真网关跑烟测都做不到,而这条路
 * 恰恰有一个必须靠烟测才能定的问题(轮询路径)。
 */

import { MIAU_BASE_URL } from '../../../shared/miau'
import { SeedanceApiError } from '../seedance/apiError'
import { retrySubmit, type RetrySubmitOptions } from '../seedance/submitRetry'
import type { SeedanceGatewayCreateTaskBody } from './request'
import { parseSeedanceGatewayTaskResult, type SeedanceGatewayTaskResult } from './response'

/** 与 wan3 逐字相同 —— 网关的 OpenAI 兼容视频端点只有这一个。 */
export const SEEDANCE_GATEWAY_CREATE_PATH = '/video/generations'

/**
 * ⚠️ **尚未经真网关证实。**
 *
 * 网关侧参考实现打的是 `GET /v1/videos/{id}`,而本仓已经跑通的 wan3 打的是
 * `GET /v1/video/generations/{id}`（2026-08-14 对着真网关钉死）。两条路径可能
 * 都在（各管各的上游），也可能只有一条。
 *
 * 提成常量 + 允许 `queryPath` 覆盖,是为了让烟测能拿同一个真 taskId 把两条都打
 * 一遍再定,而不是改代码重编译。定下来之后把这段注释换成结论和日期。
 * 待办登记在计划的 Task 6 第一条。
 */
export const SEEDANCE_GATEWAY_QUERY_PATH = '/videos'

/** 与 Seedance / wan3 同一个数：创建与查询都是轻量 JSON 接口,正常 <2s。 */
export const SEEDANCE_GATEWAY_REQUEST_TIMEOUT_MS = 30_000

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface SeedanceGatewayClient {
  createTask: (body: SeedanceGatewayCreateTaskBody, apiKey: string) => Promise<{ id: string }>
  queryTask: (taskId: string, apiKey: string) => Promise<SeedanceGatewayTaskResult>
}

export interface SeedanceGatewayClientOptions {
  fetchImpl: FetchLike
  baseUrl?: string
  /** 见 {@link SEEDANCE_GATEWAY_QUERY_PATH}。烟测用它试另一条路径。 */
  queryPath?: string
  /**
   * 由 token 组出这次请求的**完整**鉴权头。
   *
   * 生产上传的是 `auth/gatewayToken.gatewayPlatformHeaders` —— 它把 Authorization
   * 与计费归属绑在一起,刻意不给只取其一的入口:少了归属头,消费会以空归属落库,
   * 钱扣对了却在用量明细里查不到,而且一个错都不报。
   *
   * **现取而不是构造时定死**:用户中途切池,下一次提交就该记到新池上,
   * 而 transport 的生命周期跟着整个视频服务走、不跟着一次提交走。
   *
   * 缺省只给 Authorization —— 单测与将来可能的自填 Key 直连用。
   */
  authHeaders?: (apiKey: string) => Record<string, string>
  /**
   * 「这次往返动了钱」的回调,用来触发余额刷新。
   *
   * **只在真正改变余额的两个时刻调**:提交成功(上游预扣)与轮询拿到终态
   * (上游结算差额、可能退款)。中间那些 running 轮询一分钱不动,报了就是给
   * 一条 60 秒的视频白查二十次余额。
   *
   * 注入而不是直接 import:这个模块刻意保持在 Electron 之外可加载(为了能对着
   * 真网关跑烟测),而且它自己不知道这次用的是平台余额还是用户自填 Key ——
   * 那个结论在 `seedance/runtime.ts` 手上,由那边决定传不传。
   */
  onBilledExchange?: () => void
  /** 提交重试的注入点，测试用来去掉真实等待。 */
  retryOptions?: RetrySubmitOptions
}

/** 上游不会再变、余额已经结清的状态。只有走到这几个才值得刷余额。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

function requireKey(apiKey: string): string {
  const trimmed = (apiKey ?? '').trim()
  if (!trimmed) {
    // 提交前就说清楚,而不是让用户等一个上游 401 —— 401 看起来像凭据填错了,
    // 而真实情况是压根没取到。
    throw new Error('没有可用的网关凭据,无法提交视频生成。请先启用平台余额或填写 Miau Key。')
  }
  return trimmed
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
 * 错误信封有两种,都是对着真网关探出来的（同 wan3）：
 *   网关自身  {"error":{"code":"model_not_found","message":"...","type":"new_api_error"}}
 *   上游透传  {"code":"task_not_exist","message":"task_not_exist","data":null}
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
 * 网关把这些当 5xx 回,但它们是永久性的：重发三次只是让用户多等十秒再看到同一句话。
 *
 * 与 `wan3/client.ts` 各持一份而不是共用：两条路的分组、模型目录、配额口径都不同,
 * 将来一定会各自长出对方没有的码。漂移的代价只是「多重试两次」,而为了避免它去
 * 重构一条已经跑通、有完整测试的 provider,风险不成比例。
 */
const PERMANENT_GATEWAY_CODES = new Set(['model_not_found', 'invalid_api_key', 'insufficient_quota'])

/** 保留 `SeedanceApiError` 的身份（pollLoop / submitRetry 都按它判断），只覆盖永久性判定。 */
class SeedanceGatewayApiError extends SeedanceApiError {
  constructor(
    message: string,
    status: number,
    private readonly permanent: boolean,
  ) {
    super(message, status)
    this.name = 'SeedanceGatewayApiError'
  }

  override get retryable(): boolean {
    return this.permanent ? false : super.retryable
  }
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  auth: Record<string, string>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEEDANCE_GATEWAY_REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // 鉴权与计费归属整份来自 `authHeaders` —— 提交与轮询都带。
        // 轮询触发的差额结算会再写一条退款日志,那条同样需要归属。
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
    throw new SeedanceGatewayApiError(
      `网关视频 API ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status,
      code ? PERMANENT_GATEWAY_CODES.has(code) : false,
    )
  }
  return json ?? {}
}

export function createSeedanceGatewayClient(
  options: SeedanceGatewayClientOptions,
): SeedanceGatewayClient {
  const baseUrl = (options.baseUrl ?? MIAU_BASE_URL).replace(/\/+$/, '')
  const queryPath = options.queryPath ?? SEEDANCE_GATEWAY_QUERY_PATH
  const { fetchImpl } = options
  const authHeaders =
    options.authHeaders ?? ((key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` }))
  // 缺省 no-op:自填 Key 那条路不花平台余额,没有可刷的东西。
  const noteBilled = options.onBilledExchange ?? ((): void => {})

  return {
    async createTask(body, apiKey) {
      // 凭据校验放在重试外：它不会因为再试一次而变好。
      const key = requireKey(apiKey)
      // 视频提交**没有幂等键**,重复任务会跑完、计费、且 id 找不回。`retrySubmit`
      // 只重发「能确定上游没受理」的失败,这条判据在这里同样成立。
      return retrySubmit(async () => {
        const json = await request(
          fetchImpl,
          `${baseUrl}${SEEDANCE_GATEWAY_CREATE_PATH}`,
          { method: 'POST', body: JSON.stringify(body) },
          authHeaders(key),
        )
        const nested = asRecord(json.data)
        const id =
          asString(json.task_id) ??
          asString(json.id) ??
          asString(nested.task_id) ??
          asString(nested.id)
        if (!id) {
          // 没有任务号就无从轮询,而任务很可能已经在上游跑起来了。抛普通 Error
          // (非 SeedanceApiError)使它落在「不安全重发」一侧：重发只会再建一个
          // 同样认领不到、同样计费的任务。
          //
          // 刻意**不**在这里报消费:这一支会被上层当成失败处理,而它到底扣没扣钱
          // 无从判断。少报一次的代价是余额晚点刷新,而这条路本来就已经是异常态。
          throw new Error('网关返回里没有任务号,无法跟踪这次生成')
        }
        // 提交成功 = 上游已预扣。报在这里而不是 `request()` 里:那样重试的每一趟
        // 失败往返都会报一次,而失败的往返不动钱。
        noteBilled()
        return { id }
      }, options.retryOptions)
    },

    async queryTask(taskId, apiKey) {
      const key = requireKey(apiKey)
      const json = await request(
        fetchImpl,
        `${baseUrl}${queryPath}/${encodeURIComponent(taskId)}`,
        { method: 'GET' },
        authHeaders(key),
      )
      const result = parseSeedanceGatewayTaskResult(json)
      // 终态才结算。见 `TERMINAL_STATUSES` 与 `onBilledExchange` 的注释。
      if (TERMINAL_STATUSES.has(result.status)) noteBilled()
      return result
    },
  }
}
