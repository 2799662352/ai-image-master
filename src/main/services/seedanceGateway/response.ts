/**
 * 网关任务查询响应 → 内部 `SeedanceQueryResult` 的子集。
 *
 * ## 完成判据是「URL 存在」,不是 status 字符串
 *
 * 这条与 vvdance 直连**方向相反**,别照抄那边。直连打的是单一上游,判据是
 * `status === 'succeeded'` **且**有 `content.video_url`,缺 URL 算失败
 * （`seedance/taskManager.ts:518-524`）。
 *
 * 网关中转多个上游,终态词不统一（succeeded / completed / done / finished,
 * 还有大小写与本地化的变体）。按词判的话,某个上游换一个写法就会让一条已经
 * 出片的任务一直转到 30 分钟超时,而成片就躺在那个 URL 上没人取。所以:
 * **拿到能用的地址就算成功**,词只在没有地址时才参考。
 *
 * ## 认不出的状态一律当 running
 *
 * 与 wan3 同一个理由:判成 `failed` 会让 `pollLoop` 停下并落一张失败卡片,
 * 而任务还在上游烧钱跑着。当 running 最坏是多轮询几次,30 分钟的
 * `POLL_TIMEOUT_MS` 会兜住。
 *
 * ## 归一表为什么不与 wan3 共用
 *
 * 形状像,含义不同:wan3 那张对的是 DashScope + 网关两套**已知**的大写状态;
 * 这张要对的是「网关背后任意一个上游」的词表,`completed` / `done` /
 * `generating` 这些 DashScope 从不发。合成一张会让两边都被迫接受对方的方言,
 * 而真正兜底的是上面那条「认不出就 running」,不是表有多全。
 */

import type { SeedanceTaskStatus } from '../../../types/seedance'

export interface SeedanceGatewayTaskResult {
  id: string
  status: SeedanceTaskStatus
  content?: { video_url?: string }
  error?: { code?: string; message?: string }
}

const STATUS_BY_UPSTREAM: Record<string, SeedanceTaskStatus> = {
  QUEUED: 'queued',
  PENDING: 'queued',
  WAITING: 'queued',
  IN_QUEUE: 'queued',
  RUNNING: 'running',
  IN_PROGRESS: 'running',
  PROCESSING: 'running',
  GENERATING: 'running',
  SUCCEEDED: 'succeeded',
  SUCCESS: 'succeeded',
  COMPLETED: 'succeeded',
  COMPLETE: 'succeeded',
  DONE: 'succeeded',
  FINISHED: 'succeeded',
  FAILED: 'failed',
  FAILURE: 'failed',
  ERROR: 'failed',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 必须是能下载的 http(s) 地址才算「拿到了成片」。
 *
 * 判据放宽成「非空字符串」的话,上游一个 `"video_url": "pending"` 占位值就会被
 * 当成完成 —— 而完成判据在这条路上同时也是**唯一**的成功判据,误判一次就是
 * 一张点开是 404 的卡片,且任务其实还在跑。
 */
function asHttpUrl(value: unknown): string | undefined {
  const text = asString(value)
  if (!text) return undefined
  return /^https?:\/\//i.test(text) ? text : undefined
}

/** 视频地址可能出现的键名。视频专属的排在前面,通用 `url` 兜底。 */
const URL_KEYS = ['video_url', 'videoUrl', 'result_url', 'resultUrl', 'url'] as const

function urlIn(container: unknown): string | undefined {
  const record = asRecord(container)
  for (const key of URL_KEYS) {
    const url = asHttpUrl(record[key])
    if (url) return url
  }
  return undefined
}

function urlInList(list: unknown): string | undefined {
  for (const item of asArray(list)) {
    const url = urlIn(item)
    if (url) return url
  }
  return undefined
}

/**
 * 多位置兜底。顺序即优先级：先找「明确是这次任务产物」的容器,最后才回到裸顶层。
 *
 * 刻意不写成任意深度的递归搜索：那会把封面图 / 预览图 / 上游文档链接也捞进来,
 * 而这里挑错一个 URL 的代价是「任务显示成功、点开不是成片」——比没找到还糟。
 */
function findVideoUrl(body: Record<string, unknown>, record: Record<string, unknown>): string | undefined {
  const output = asRecord(record.output ?? body.output)
  const inner = asRecord(record.data)

  const containers: unknown[] = [
    record.content,
    output,
    asRecord(inner.output),
    inner.content,
    // `metadata` 是这条上游**实际**放地址的地方 —— 2026-08-29 真机抓到的
    // `doubao-seedance-2-0-260128` 完成响应长这样：
    //   { status: 'completed', progress: 100,
    //     metadata: { upstream_task_id: 'cgt-…', url: 'https://…tos-cn-beijing…' } }
    // 顶层没有任何 url 键。漏了这一格不会报错,而是让这条任务**永远拿不到成片**:
    // 完成判据就是「URL 存在」,于是卡片一路 running 到 30 分钟超时,
    // 而片子早就出好了、钱也早就扣了。光看 status 发现不了 —— 它写着 completed。
    record.metadata,
    inner.metadata,
    record,
    body,
  ]
  for (const container of containers) {
    const url = urlIn(container)
    if (url) return url
  }

  const lists: unknown[] = [
    output.results,
    record.results,
    record.videos,
    body.videos,
    asRecord(inner.output).results,
    Array.isArray(record.data) ? record.data : undefined,
    Array.isArray(body.data) ? body.data : undefined,
  ]
  for (const list of lists) {
    const url = urlInList(list)
    if (url) return url
  }
  return undefined
}

function resolveStatus(raw: unknown): SeedanceTaskStatus | undefined {
  const text = asString(raw)
  if (!text) return undefined
  return STATUS_BY_UPSTREAM[text.toUpperCase()]
}

/**
 * 查询接口把任务记录包在 `data` 里；有的回形直接摊在顶层。用「只有任务记录才有」
 * 的字段识别,免得把某个上游的 `output` 误当成网关信封。
 */
function unwrapGatewayRecord(body: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(body.data)
  if (
    asString(nested.task_id) ||
    asString(nested.status) ||
    asString(nested.result_url) ||
    asString(nested.video_url)
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

export function parseSeedanceGatewayTaskResult(raw: unknown): SeedanceGatewayTaskResult {
  const body = asRecord(raw)
  const record = unwrapGatewayRecord(body)
  const output = asRecord(record.output ?? body.output)
  const errorLayer = asRecord(record.error ?? body.error)

  // 网关 task_id 压过内层上游 uuid：拿内层那个再查本网关会 task_not_exist。
  const id =
    asString(record.task_id) ??
    asString(body.task_id) ??
    asString(record.id) ??
    asString(body.id) ??
    ''

  const videoUrl = findVideoUrl(body, record)
  const upstream = resolveStatus(
    record.status ?? body.status ?? output.task_status ?? record.task_status ?? body.task_status,
  )
  // 见文件头：地址在手就是成功,词说什么都不重要。
  const status: SeedanceTaskStatus = videoUrl ? 'succeeded' : (upstream ?? 'running')

  const code = asString(errorLayer.code) ?? asString(output.code) ?? envelopeErrorCode(body.code)
  const message =
    asString(errorLayer.message) ??
    asString(record.fail_reason) ??
    asString(output.message) ??
    asString(body.message)

  return {
    id,
    status,
    ...(videoUrl ? { content: { video_url: videoUrl } } : {}),
    ...(code || message ? { error: { ...(code ? { code } : {}), ...(message ? { message } : {}) } } : {}),
  }
}
