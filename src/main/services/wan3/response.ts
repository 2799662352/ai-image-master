/**
 * 万相任务查询响应 → 内部 `SeedanceQueryResult` —— provider 分派的第二处。
 *
 * ## 2026-08-14 真网关钉死的信封
 *
 * `GET /v1/video/generations/{id}` 的真实回形是 Miau 任务记录包在 `data` 里，
 * DashScope 原文再套一层 `data.data.output`：
 *
 * ```
 * { code: "success", data: {
 *     task_id: "task_…",          // 网关 id，后续查询必须用这个
 *     status: "QUEUED" | "IN_PROGRESS" | "SUCCESS" | "FAILURE",
 *     result_url?: "https://…",   // 成功时网关层也有一份
 *     fail_reason?: string,
 *     data: { output: { task_id: "<dashscope-uuid>", task_status, video_url } }
 * } }
 * ```
 *
 * 组包指南写的顶层 `output.video_url` 是直连 DashScope / 另一套 BFF 的形状。
 * 按那份解析会把已完成的任务当成还在跑 —— pollLoop 空转到 30 分钟超时，
 * 而成片已经躺在 OSS 上没人认领。两种形状都认，**网关信封优先**。
 *
 * 内层 `output.task_id` 是 DashScope 自己的 uuid，拿去再查本网关会
 * `task_not_exist`。任务号只取网关的 `data.task_id`。
 *
 * ## 认不出的状态一律当 running
 *
 * 判成 `failed` 会让 `pollLoop` 停下并落一张失败卡片，而任务还在上游烧钱跑着。
 * 当 running 最坏是多轮询几次，30 分钟的 `POLL_TIMEOUT_MS` 会兜住。
 */

import type { SeedanceTaskStatus } from '../../../types/seedance'

export interface Wan3TaskResult {
  id: string
  status: SeedanceTaskStatus
  content?: { video_url?: string }
  error?: { code?: string; message?: string }
}

/** DashScope 大写状态 + Miau 网关大写状态 → 内部小写状态。 */
const STATUS_BY_UPSTREAM: Record<string, SeedanceTaskStatus> = {
  PENDING: 'queued',
  QUEUED: 'queued',
  RUNNING: 'running',
  IN_PROGRESS: 'running',
  SUCCEEDED: 'succeeded',
  SUCCESS: 'succeeded',
  FAILED: 'failed',
  FAILURE: 'failed',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
  UNKNOWN: 'running',
}

const INTERNAL_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function resolveStatus(raw: unknown): SeedanceTaskStatus {
  const text = asString(raw)
  if (!text) return 'running'
  if (INTERNAL_STATUSES.has(text)) return text as SeedanceTaskStatus
  return STATUS_BY_UPSTREAM[text.toUpperCase()] ?? 'running'
}

function resolveVideoUrl(output: Record<string, unknown>): string | undefined {
  const direct = asString(output.video_url)
  if (direct) return direct
  const results = output.results
  if (Array.isArray(results)) {
    for (const item of results) {
      const url = asString(asRecord(item).url)
      if (url) return url
    }
  }
  return undefined
}

/**
 * 查询接口把任务记录包在 `data` 里；创建接口和旧 mock 把字段放在顶层。
 * 用任务号 / 网关状态 / 进度这些「只有任务记录才有」的字段来识别，避免把
 * DashScope 的 `output` 误当成网关信封。
 */
function unwrapGatewayRecord(body: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(body.data)
  if (
    asString(nested.task_id) ||
    asString(nested.status) ||
    asString(nested.result_url) ||
    asString(nested.progress)
  ) {
    return nested
  }
  return body
}

/** 信封自己的 `code: "success"` 不是错误码。 */
function envelopeErrorCode(value: unknown): string | undefined {
  const text = asString(value)
  if (!text || text.toLowerCase() === 'success') return undefined
  return text
}

export function parseWan3TaskResult(raw: unknown): Wan3TaskResult {
  const body = asRecord(raw)
  const record = unwrapGatewayRecord(body)
  const output = asRecord(asRecord(record.data).output ?? record.output ?? body.output)

  const status = resolveStatus(output.task_status ?? record.status ?? body.task_status ?? body.status)
  // 网关 task_id 必须压过内层 DashScope uuid，否则后续查询会打到一个不存在的 id。
  const id =
    asString(record.task_id) ?? asString(body.task_id) ?? asString(body.id) ?? asString(output.task_id) ?? ''

  const videoUrl = resolveVideoUrl(output) ?? asString(record.result_url)
  const code = asString(output.code) ?? envelopeErrorCode(body.code)
  const message = asString(output.message) ?? asString(record.fail_reason) ?? asString(body.message)

  return {
    id,
    status,
    ...(videoUrl ? { content: { video_url: videoUrl } } : {}),
    ...(code || message ? { error: { ...(code ? { code } : {}), ...(message ? { message } : {}) } } : {}),
  }
  // 刻意不透传 completion_tokens:万相按秒计费,没有这个口径。透传会让 pricing
  // 以为能按 token 估价,算出一个凭空的数字 —— 比不显示价格糟得多。
}
