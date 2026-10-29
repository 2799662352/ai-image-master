/**
 * 视频「效果问题反馈」经 Miau 网关的 HTTP 客户端(火山方舟 Case 平台,Seedance 2.x)。
 *
 *   POST {base}/video/badcase/report   上报
 *   POST {base}/video/badcase/query    查询处理结果
 *
 * `MIAU_BASE_URL` 已含 `/v1`,这里拼相对段。`fetch` 与鉴权头都由外部注入:这个模块刻意不 import
 * electron,单测里能直接跑;生产接线在同目录 `ipc.ts`。
 *
 * ## 回包的两层
 *
 * 网关回的是 `{ total, accepted: [...], rejected: [...] }`,**即使整批失败也是这个形状**:
 * 所有候选 Key 都撞上游异常时网关用 502 回,body 仍是 `{ accepted: [], rejected: [{ code: 50200 }] }`。
 * 所以先按 body 形状解析、再看状态码;只有 body 不是这个形状才退到「按状态码说人话」。
 *
 * 错误信封(网关自己,不是上游透传):`{ "error": { "message", "type" } }`。
 *
 * ## 不做的事
 *
 * - **不靠报错文案判断「已提交过」。** 网页版 sora-ui 的做法:上报被拒就再查一次,查到记录就当作已提交。
 *   那是面板的事,这里只如实交出 `rejected`。
 * - **不碰 `model`。** 网关缺省用虚拟模型 `seedance-badcase`(令牌白名单 / 渠道分发 / 用量日志都挂在它上),
 *   我们传了反而多一个要和网关保持一致的名字。
 * - **不重试。** 上报不是幂等的(上游同一任务只收一次),查询有网关侧 45 秒省流;客户端重试只会白烧配额。
 */

import { MIAU_BASE_URL } from '../../../shared/miau'
import {
  VIDEO_BADCASE_CONTACT_MAX_CHARS,
  VIDEO_BADCASE_FEEDBACK_MAX_CHARS,
  isVideoBadcaseType,
  type VideoBadcaseAttachment,
  type VideoBadcaseErrorCode,
  type VideoBadcaseFailure,
  type VideoBadcaseQueryResult,
  type VideoBadcaseRecord,
  type VideoBadcaseRejection,
  type VideoBadcaseReportInput,
  type VideoBadcaseReportResult,
} from '../../../types/videoBadcase'

export const VIDEO_BADCASE_REPORT_PATH = '/video/badcase/report'
export const VIDEO_BADCASE_QUERY_PATH = '/video/badcase/query'

/** 网关自己对上游调用卡 30 秒;客户端多留 5 秒,让它有机会把 502 的 body 回来。 */
export const VIDEO_BADCASE_TIMEOUT_MS = 35_000

/** 上游 / 网关:任务不存在或不属于当前账号。 */
export const BADCASE_CODE_TASK_NOT_FOUND = 40002
/** 网关本地码:调用上游失败(网络 / 鉴权 / 5xx)。 */
export const BADCASE_CODE_UPSTREAM_ERROR = 50200

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface VideoBadcaseClient {
  report: (input: VideoBadcaseReportInput) => Promise<VideoBadcaseReportResult>
  query: (taskId: string) => Promise<VideoBadcaseQueryResult>
}

export interface VideoBadcaseClientOptions {
  fetchImpl: FetchLike
  baseUrl?: string
  /**
   * 这次请求的**完整**鉴权头;`null` = 没有平台凭据。每次调用现取(用户中途切池,下一次就记到新池上)。
   * 生产上传 `gatewayPlatformHeaders(getActivePoolToken())`,它把 Authorization 与计费归属绑在一起。
   */
  authHeaders: () => Record<string, string> | null
  timeoutMs?: number
}

const MSG_PLATFORM_NOT_READY = '平台余额未就绪：请先登录并在账号设置里选择计费池后再提交反馈。'
const MSG_TASK_NOT_FOUND =
  '找不到这条任务：它可能不属于当前账号 / 计费池（请切换到提交这张卡时的计费池再试），或还没同步到上游。'
const MSG_UPSTREAM = '上游反馈服务暂时不可用，请稍后重试。'

function failure(code: VideoBadcaseErrorCode, message: string): VideoBadcaseFailure {
  return { ok: false, code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function runeLength(text: string): number {
  return Array.from(text).length
}

// ---------------------------------------------------------------------------
// 入参校验(网关也会校验;这里先拦下,省一趟往返并给更准的话)

type Validated<T> = { ok: true; value: T } | VideoBadcaseFailure

function validateTaskId(raw: unknown): Validated<string> {
  const taskId = typeof raw === 'string' ? raw.trim() : ''
  if (!taskId) return failure('INVALID_REQUEST', '缺少任务号，无法提交反馈。')
  // 网关的 task_id 支持逗号 / 空白分隔的批量写法;这里一次只处理一个任务,
  // 带分隔符说明传错了东西,拒掉比悄悄变成批量上报安全。
  if (/[\s,，]/.test(taskId)) return failure('INVALID_REQUEST', '任务号格式不对。')
  return { ok: true, value: taskId }
}

export function validateReportInput(raw: unknown): Validated<VideoBadcaseReportInput> {
  if (!isRecord(raw)) return failure('INVALID_REQUEST', '填写内容不符合要求，请检查后重试。')
  const taskId = validateTaskId(raw.taskId)
  if (!taskId.ok) return taskId

  const feedback = typeof raw.feedback === 'string' ? raw.feedback.trim() : ''
  if (!feedback) return failure('INVALID_REQUEST', '请填写问题描述。')
  if (runeLength(feedback) > VIDEO_BADCASE_FEEDBACK_MAX_CHARS) {
    return failure('INVALID_REQUEST', `问题描述最多 ${VIDEO_BADCASE_FEEDBACK_MAX_CHARS} 个字。`)
  }

  const contactInfo = typeof raw.contactInfo === 'string' ? raw.contactInfo.trim() : ''
  if (runeLength(contactInfo) > VIDEO_BADCASE_CONTACT_MAX_CHARS) {
    return failure('INVALID_REQUEST', `联系方式最多 ${VIDEO_BADCASE_CONTACT_MAX_CHARS} 个字。`)
  }

  const rawTypes = raw.badcaseTypes === undefined ? [] : raw.badcaseTypes
  if (!Array.isArray(rawTypes) || !rawTypes.every(isVideoBadcaseType)) {
    return failure('INVALID_REQUEST', '问题类型不在可选范围内。')
  }

  return {
    ok: true,
    value: {
      taskId: taskId.value,
      feedback,
      badcaseTypes: Array.from(new Set(rawTypes)),
      ...(contactInfo ? { contactInfo } : {}),
    },
  }
}

export function validateQueryTaskId(raw: unknown): Validated<string> {
  return validateTaskId(raw)
}

// ---------------------------------------------------------------------------
// 回包解析

function parseRejection(value: unknown): VideoBadcaseRejection | null {
  if (!isRecord(value)) return null
  return { code: typeof value.code === 'number' ? value.code : 0, message: str(value.message) }
}

/**
 * 拒绝原因给人看的话。**只按 code 翻译,不匹配文案** —— 上游的 message 会变语言、会改措辞。
 * 40002 是唯一一个有固定含义、且用户能据此行动(切池)的码。
 */
function rejectionOf(value: unknown): VideoBadcaseRejection | null {
  const r = parseRejection(value)
  if (!r) return null
  if (r.code === BADCASE_CODE_TASK_NOT_FOUND) return { code: r.code, message: MSG_TASK_NOT_FOUND }
  return r
}

function parseAttachments(value: unknown): VideoBadcaseAttachment[] {
  if (!Array.isArray(value)) return []
  const out: VideoBadcaseAttachment[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const url = str(item.url)
    if (!isHttpsUrl(url)) continue
    out.push({ type: str(item.type), url, mimeType: str(item.mime_type), name: str(item.name) })
  }
  return out
}

function parseRecord(item: Record<string, unknown>): VideoBadcaseRecord {
  const note = isRecord(item.solution_note) ? item.solution_note : null
  return {
    badcaseTypes: Array.isArray(item.badcase_type)
      ? item.badcase_type.filter((t): t is string => typeof t === 'string')
      : [],
    feedback: str(item.feedback),
    problemLabel: str(item.problem_label),
    status: str(item.status),
    submitTime: str(item.submit_time),
    solution: note ? { text: str(note.text), attachments: parseAttachments(note.attachments) } : null,
  }
}

interface ParsedEnvelope {
  accepted: Record<string, unknown>[]
  rejected: unknown[]
}

/** body 是网关的 `{accepted, rejected}` 形状才返回,否则 null(交给按状态码说人话)。 */
function parseEnvelope(json: Record<string, unknown> | null): ParsedEnvelope | null {
  if (!json) return null
  if (!Array.isArray(json.accepted) && !Array.isArray(json.rejected)) return null
  return {
    accepted: Array.isArray(json.accepted) ? json.accepted.filter(isRecord) : [],
    rejected: Array.isArray(json.rejected) ? json.rejected : [],
  }
}

/** 整个批次因上游异常失败 —— 网关把它标成 50200。不是「这个任务有问题」,是「现在查不了」。 */
function upstreamFailureIn(envelope: ParsedEnvelope): boolean {
  return envelope.rejected.some((r) => parseRejection(r)?.code === BADCASE_CODE_UPSTREAM_ERROR)
}

/** 网关错误信封里 `type` 与 `code` 都可能带有用信息(没渠道时 type=new_api_error、code=model_not_found)。 */
function errorCodesOf(json: Record<string, unknown> | null): string[] {
  const err = isRecord(json?.error) ? json.error : null
  return err ? [str(err.type), str(err.code)].filter(Boolean) : []
}

function errorMessageOf(json: Record<string, unknown> | null): string {
  const err = isRecord(json?.error) ? json.error : null
  return err ? str(err.message) : ''
}

/** 回包不是 `{accepted, rejected}` 时,按状态码给一句人话。 */
function failureFromStatus(status: number, json: Record<string, unknown> | null): VideoBadcaseFailure {
  const codes = errorCodesOf(json)
  const message = errorMessageOf(json)
  if (status === 401) {
    return failure('UNAUTHORIZED', '登录状态已失效或令牌无效，请重新登录后再试。')
  }
  // 没有可用渠道 / 令牌白名单不含 seedance-badcase:这是网关侧还没给这个账号开通,用户自己解决不了。
  // 404 同理:老版本网关根本没有这两个路由。
  if (
    status === 403 ||
    status === 404 ||
    codes.includes('model_not_found') ||
    (status === 503 && /seedance-badcase|no available channel/i.test(message))
  ) {
    return failure('CHANNEL_UNAVAILABLE', '网关暂未对当前账号开通「效果问题反馈」，请联系管理员。')
  }
  if (status === 400 || status === 422) {
    return failure('INVALID_REQUEST', '填写内容不符合要求，请检查后重试。')
  }
  if (status === 429) return failure('UPSTREAM_ERROR', '请求过于频繁，请稍后再试。')
  if (status >= 500) return failure('UPSTREAM_ERROR', MSG_UPSTREAM)
  return failure('BAD_RESPONSE', `网关返回了无法识别的结果（HTTP ${status}）。`)
}

// ---------------------------------------------------------------------------

export function createVideoBadcaseClient(options: VideoBadcaseClientOptions): VideoBadcaseClient {
  const baseUrl = (options.baseUrl ?? MIAU_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? VIDEO_BADCASE_TIMEOUT_MS
  const { fetchImpl } = options

  /** 发请求并读 body;只在「没到网关回包那一层」时返回 failure。 */
  async function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> | null } | VideoBadcaseFailure> {
    const auth = options.authHeaders()
    if (!auth) return failure('PLATFORM_NOT_READY', MSG_PLATFORM_NOT_READY)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
      })
      let json: Record<string, unknown> | null = null
      try {
        const parsed: unknown = await res.json()
        json = isRecord(parsed) ? parsed : null
      } catch {
        json = null
      }
      return { status: res.status, json }
    } catch {
      // 我们自己掐断的换成人话;其余(DNS / 断网 / TLS)一律「连不上」,不把底层错误串露给用户。
      if (controller.signal.aborted) return failure('NETWORK', '请求超时，请稍后再试。')
      return failure('NETWORK', '连不上网关，请检查网络后重试。')
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async report(rawInput) {
      const checked = validateReportInput(rawInput)
      if (!checked.ok) return checked
      const input = checked.value

      const res = await post(VIDEO_BADCASE_REPORT_PATH, {
        task_id: input.taskId,
        feedback: input.feedback,
        ...(input.badcaseTypes.length > 0 ? { badcase_type: input.badcaseTypes } : {}),
        ...(input.contactInfo ? { contact_info: input.contactInfo } : {}),
      })
      if ('ok' in res) return res

      const envelope = parseEnvelope(res.json)
      if (!envelope) return failureFromStatus(res.status, res.json)

      const accepted = envelope.accepted.find((a) => str(a.task_id) === input.taskId) ?? envelope.accepted[0]
      if (accepted) {
        return { ok: true, outcome: 'accepted', caseId: str(accepted.case_id) || null }
      }
      if (upstreamFailureIn(envelope)) return failure('UPSTREAM_ERROR', MSG_UPSTREAM)
      const rejection = rejectionOf(envelope.rejected[0])
      if (rejection) return { ok: true, outcome: 'rejected', rejection }
      // 既没受理也没拒绝:不能当成功,否则用户以为交上去了。
      return failure('BAD_RESPONSE', '网关没有给出受理结果，请稍后点「刷新状态」确认是否已提交。')
    },

    async query(rawTaskId) {
      const checked = validateQueryTaskId(rawTaskId)
      if (!checked.ok) return checked
      const taskId = checked.value

      const res = await post(VIDEO_BADCASE_QUERY_PATH, { task_id: taskId })
      if ('ok' in res) return res

      const envelope = parseEnvelope(res.json)
      if (!envelope) return failureFromStatus(res.status, res.json)

      const item = envelope.accepted.find((a) => str(a.task_id) === taskId) ?? envelope.accepted[0]
      if (item) return { ok: true, record: parseRecord(item), rejection: null }
      // 没记录。上游不可用(50200)必须与「确实没有记录」分开:前者让用户去重试,
      // 后者才该把表单摆出来 —— 把 50200 当成「没记录」会让人对着一份可能已提交过的任务再交一次。
      if (upstreamFailureIn(envelope)) return failure('UPSTREAM_ERROR', MSG_UPSTREAM)
      return { ok: true, record: null, rejection: rejectionOf(envelope.rejected[0]) }
    },
  }
}
