/**
 * 万相 3.0 的 HTTP 客户端 —— provider 分派的第三处（前两处是组包与响应解析）。
 *
 * 打的是 Miau（new-api）的视频端点：
 *   POST {base}/video/generations       创建任务
 *   GET  {base}/video/generations/{id}  查询任务
 *
 * `fetch` 由外部注入，默认用 Electron 的 `net.fetch`（走主进程网络栈，继承系统
 * 代理与证书）。注入的意义不只是可测：它让整条请求塑形能在没有 Electron 的环境
 * 下被断言，而这条链路我们**无法本地实测**（需要真实密钥与邀测资格），单测是
 * 唯一能钉住「URL、头、体到底发了什么」的手段。
 */

import { net } from 'electron'
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

export interface Wan3Client {
  createTask: (body: Wan3CreateTaskBody, apiKey: string) => Promise<{ id: string }>
  queryTask: (taskId: string, apiKey: string) => Promise<Wan3TaskResult>
}

export interface Wan3ClientOptions {
  fetchImpl?: FetchLike
  baseUrl?: string
  /** 提交重试的注入点，测试用来去掉真实等待。 */
  retryOptions?: RetrySubmitOptions
}

function requireKey(apiKey: string): string {
  const trimmed = (apiKey ?? '').trim()
  if (!trimmed) {
    // 提交前就说清楚,而不是让用户等一个上游 401 —— 401 看起来像密钥填错了,
    // 而真实情况是压根没填。
    throw new Error('未配置 Miau 密钥,无法使用万相 3.0。请先在设置里填写图片生成的 Miau Key。')
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
  apiKey: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WAN3_REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
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

export function createWan3Client(options: Wan3ClientOptions = {}): Wan3Client {
  const baseUrl = (options.baseUrl ?? MIAU_BASE_URL).replace(/\/+$/, '')
  // 默认走 Electron 的 net.fetch(系统代理/证书);测试注入自己的。
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => net.fetch(url, init as Parameters<typeof net.fetch>[1]))

  return {
    async createTask(body, apiKey) {
      // 密钥校验放在重试外:它不会因为再试一次而变好。
      const key = requireKey(apiKey)
      // 复用 Seedance 的提交重试。它只重发「能确定上游没受理」的失败,这条判据对
      // 万相同样成立 —— 万相按秒计费,重复建任务同样是一笔没人认领、跑到完的钱。
      return retrySubmit(async () => {
        const json = await request(
          fetchImpl,
          `${baseUrl}/video/generations`,
          { method: 'POST', body: JSON.stringify(body) },
          key,
        )
        const output = (json.output ?? {}) as Record<string, unknown>
        const id = asString(output.task_id) ?? asString(json.task_id) ?? asString(json.id)
        if (!id) {
          // 没有任务号就无从轮询,而任务很可能已经在上游跑起来了。抛普通 Error
          // (非 SeedanceApiError)使它落在「不安全重发」一侧:重发只会再建一个
          // 同样认领不到的任务。
          throw new Error('万相返回里没有任务号,无法跟踪这次生成')
        }
        return { id }
      }, options.retryOptions)
    },

    async queryTask(taskId, apiKey) {
      const key = requireKey(apiKey)
      const json = await request(
        fetchImpl,
        `${baseUrl}/video/generations/${encodeURIComponent(taskId)}`,
        { method: 'GET' },
        key,
      )
      return parseWan3TaskResult(json)
    },
  }
}
