/**
 * 万相任务查询响应 → 内部 `SeedanceQueryResult` —— provider 分派的第二处。
 *
 * ## 为什么两种取值路径都认
 *
 * 我们打的是 Miau 网关而不是 DashScope 直连。指南写的网关回形是
 * `output.video_url`；而 DashScope 官方 Python SDK 读的是
 * `output.results[0].url`。网关有没有把这一层抹平，我们无法本地实测。
 *
 * 少认一种的代价是「任务明明成功了却报 `succeeded 但缺少 video_url`」——一次
 * 白花的生成；多认一种没有任何代价。所以两种都认，网关形状优先（它是我们的
 * 直接对端）。
 *
 * ## 认不出的状态一律当 running
 *
 * 判成 `failed` 会让 `pollLoop` 停下并落一张失败卡片，而任务还在上游烧钱跑着，
 * 用户既拿不到结果也不知道钱花哪了。当 running 最坏是多轮询几次，30 分钟的
 * `POLL_TIMEOUT_MS` 会兜住。
 */

import type { SeedanceTaskStatus } from '../../../types/seedance'

export interface Wan3TaskResult {
  id: string
  status: SeedanceTaskStatus
  content?: { video_url?: string }
  error?: { code?: string; message?: string }
}

/** DashScope 的大写任务状态 → 我们的内部状态。 */
const STATUS_BY_UPSTREAM: Record<string, SeedanceTaskStatus> = {
  PENDING: 'queued',
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
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
  // 网关对 Seedance 就直接回小写,万相这条路上也可能被它抹平成同一套。
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

export function parseWan3TaskResult(raw: unknown): Wan3TaskResult {
  const body = asRecord(raw)
  const output = asRecord(body.output)

  const status = resolveStatus(output.task_status ?? body.task_status ?? body.status)
  const id = asString(output.task_id) ?? asString(body.task_id) ?? asString(body.id) ?? ''

  const videoUrl = resolveVideoUrl(output)
  const code = asString(output.code) ?? asString(body.code)
  const message = asString(output.message) ?? asString(body.message)

  return {
    id,
    status,
    // 没有地址就不造一个空 content —— 调用方用 `content?.video_url` 判空。
    ...(videoUrl ? { content: { video_url: videoUrl } } : {}),
    // 两个都没有就不塞空对象,否则调用方会以为「有错误但说不出原因」。
    ...(code || message ? { error: { ...(code ? { code } : {}), ...(message ? { message } : {}) } } : {}),
  }
  // 刻意不透传 completion_tokens:万相按秒计费,没有这个口径。透传会让 pricing
  // 以为能按 token 估价,算出一个凭空的数字 —— 比不显示价格糟得多。
}
