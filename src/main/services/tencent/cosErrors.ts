// COS 失败的解读 —— 纯函数,不碰 SDK、不碰凭证,所以能被直接单测。
//
// 存在的理由:cos-nodejs-sdk-v5 的失败**不是 Error 实例**,而是一个裸对象
// (`{ code, statusCode, error: { Code, Message }, headers }`)。调用方那句几乎
// 到处都在写的 `e instanceof Error ? e.message : String(e)` 会把它渲成
// `[object Object]` —— 上传失败的真实原因(票据拿不到 / AccessDenied / DNS /
// 超时)只剩主进程日志里有,用户在界面上一个字都看不到,也就无从判断该重试
// 还是该换个文件。视频工作台那句「file is 6.4MB and the COS relay upload
// failed ([object Object])」就是这么来的。

/**
 * 值得重试的 HTTP 状态码。口径对齐 @google-cloud/storage 的
 * `RETRYABLE_ERR_FN_DEFAULT`(408/429/500/502/503/504)——
 * **408 请求超时与 429 限流虽然是 4xx,但都是瞬时的**,按「4xx 一律终态」处理
 * 会把限流当成永久失败,那正是最该退一步再试的情形。
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

/** 值得重试的 Node 网络错误码(DNS / TLS / 连接被掐)。 */
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPROTO',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
])

/**
 * 把 COS 的错误信封压成一行可读文本,保证透出到界面的错误自带可诊断信息。
 * 无论传进来什么(裸对象 / Error / 字符串 / undefined),都不会退化成
 * `[object Object]`。
 */
export function describeCosError(err: unknown): string {
  if (err == null) return 'unknown COS error'
  if (typeof err === 'string') return err
  const e = err as any
  const parts: string[] = []
  const push = (value: unknown): void => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text && !parts.includes(text)) parts.push(text)
  }
  push(e?.code ?? e?.error?.Code)
  // 内层码才说明是 DNS 解析不了、TLS 被拦还是连接被掐 —— SDK 外层只会给一句
  // 笼统的 RequestError。而 DNS 故障常常**只有** error.code 没有 error.message,
  // 所以内层码必须单独取,不能等着从内层消息里读出来。
  push(e?.error?.code ?? e?.cause?.code)
  const status = e?.statusCode
  if (status) parts.push(`HTTP ${status}`)
  push(e?.message)
  push(e?.error?.Message ?? e?.error?.message ?? e?.cause?.message)
  const requestId = e?.headers?.['x-cos-request-id'] ?? e?.RequestId
  if (requestId) parts.push(`requestId=${requestId}`)
  if (parts.length > 0) return parts.join(' · ')
  // 兜底:至少别退化成 `[object Object]`。
  try {
    const json = JSON.stringify(err)
    if (json && json !== '{}') return json.slice(0, 300)
  } catch {
    /* 循环引用等,落到下面 */
  }
  return err instanceof Error ? err.message : 'unknown COS error'
}

/**
 * COS 失败是否值得重试 —— 瞬时故障(网络层抖动、服务端 5xx、限流、请求超时)
 * 值得,其余不值得:票据过期、AccessDenied、Key 非法重试多少次都一样,只是把
 * 失败推迟,还让用户多等几十秒才看到本来就确定的结论。
 *
 * 分类的形状照 AWS SDK 与 @google-cloud/storage 的做法:先看状态码白名单,再看
 * 底层网络错误码,最后才退到文案匹配(有些失败两者都没有,只剩一句人话)。
 */
export function isRetryableCosError(err: unknown): boolean {
  const e = err as any
  // 取票据失败自己已经重试过一轮了,但如果它判定是瞬时的,上传这层再给一次机会
  // 也值得 —— 批量出片时 STS 端点的抖动往往持续几秒,跨过它整批就都活了。
  // 按 name 而不是 instanceof 判断,是为了让本文件保持"不 import 任何东西"的纯函数。
  if (e?.name === 'StsCredentialError') return e.transient === true
  const status = Number(e?.statusCode)
  if (Number.isFinite(status) && status > 0) return RETRYABLE_STATUS.has(status)
  const codes = [e?.code, e?.error?.code, e?.cause?.code]
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.toUpperCase())
  if (codes.some((c) => TRANSIENT_NET_CODES.has(c))) return true
  const text = `${e?.message ?? ''} ${e?.error?.message ?? ''}`.toLowerCase()
  return /timeout|timed out|socket hang up|unexpected connection closure|network|econn|etimedout|temporarily/.test(
    text,
  )
}

/**
 * 这次 403 是不是"票据的问题"—— 是的话重签一张就能自愈,不必判死刑。
 *
 * 为什么值得单独一个判据:403 按状态码白名单是不可重试的,这本身没错(权限不够
 * 重试多少次都一样)。但我们这条链路上的 403 几乎只有一个来源 —— 票据没拿到或
 * 已过期,SDK 拿着空的/旧的凭据去签名。把它和真正的权限不足一起判死刑,等于让
 * 上传的重试预算在最常见的失败模式下完全失效。
 *
 * 桶和 Key 都是我们自己生成的,不存在用户可控的 ACL,所以认不出 code 的 403 也
 * 一并当票据问题处理 —— 代价是多重签一次,收益是不再有"AccessDenied 死路"。
 */
export function isStaleCredentialError(err: unknown): boolean {
  const e = err as any
  if (Number(e?.statusCode) !== 403) return false
  const code = String(e?.code ?? e?.error?.Code ?? e?.error?.code ?? '')
  if (!code) return true
  return /AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId|TokenExpired|InvalidToken|RequestTimeTooSkewed/i.test(
    code,
  )
}
