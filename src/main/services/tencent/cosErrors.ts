// COS 失败的解读 —— 纯函数,不碰 SDK、不碰凭证,所以能被直接单测。
//
// 存在的理由:cos-nodejs-sdk-v5 的失败**不是 Error 实例**,而是一个裸对象
// (`{ code, statusCode, error: { Code, Message }, headers }`)。调用方那句几乎
// 到处都在写的 `e instanceof Error ? e.message : String(e)` 会把它渲成
// `[object Object]` —— 上传失败的真实原因(票据拿不到 / AccessDenied / DNS /
// 超时)只剩主进程日志里有,用户在界面上一个字都看不到,也就无从判断该重试
// 还是该换个文件。视频工作台那句「file is 6.4MB and the COS relay upload
// failed ([object Object])」就是这么来的。

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
  const code = e?.code ?? e?.error?.Code ?? e?.error?.code
  const status = e?.statusCode
  // 内层才是 TLS / DNS / 代理故障的真实原因,SDK 外层只会给个笼统 code。
  const inner = e?.error?.Message ?? e?.error?.message ?? e?.cause?.message
  if (code) parts.push(String(code))
  if (status) parts.push(`HTTP ${status}`)
  for (const text of [e?.message, inner]) {
    const t = typeof text === 'string' ? text.trim() : ''
    if (t && !parts.includes(t)) parts.push(t)
  }
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
 * COS 失败是否值得重试 —— 网络层抖动 / 服务端 5xx 值得,鉴权与请求错误不值得
 * (票据过期、AccessDenied、Key 非法重试多少次都一样,只是把失败推迟)。
 */
export function isRetryableCosError(err: unknown): boolean {
  const e = err as any
  const status = Number(e?.statusCode)
  if (Number.isFinite(status) && status >= 400 && status < 500) return false
  if (Number.isFinite(status) && status >= 500) return true
  const codes = [e?.code, e?.error?.code, e?.cause?.code]
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.toUpperCase())
  if (codes.some((c) => TRANSIENT_NET_CODES.has(c))) return true
  const text = `${e?.message ?? ''} ${e?.error?.message ?? ''}`.toLowerCase()
  return /timeout|timed out|socket hang up|network|econn|etimedout|temporarily/.test(text)
}
