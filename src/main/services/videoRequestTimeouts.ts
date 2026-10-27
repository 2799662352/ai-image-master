/**
 * 视频类任务接口的客户端超时，四个客户端（网关 Seedance / 万相 / 高清 mediaKit /
 * vvdance ARK）共用，别各写各的 30 秒。
 *
 * ## 为什么提交和查询要分开
 *
 * 原先四处都是一个 30 秒，注释里的假设是「创建和查询都是轻量 JSON，正常 2 秒内」。
 * 查询确实如此；提交不是——多张参考图 + 全能参考时，网关要**同步**做预扣、转发上游，
 * 上游要把每张图拉下来校验之后才吐任务 ID，再叠一层用户本机的代理链路，30 秒会被
 * 真实请求打满（2026-09-02 实测：3 图 Seedance 2.5 提交被客户端掐断）。
 *
 * ## 提交超时不是普通失败
 *
 * 客户端掐断连接，网关**不会跟着取消**：它很可能已经受理并预扣，任务在上游照跑，
 * 跑成了就按成功结算——而用户这边看到的是「失败」。`submitRetry` 也刻意不重发
 * 这种失败（分不清上游是否已受理，重发会跑出两份、扣两次）。所以提交超时的文案
 * 必须把这个风险说出来，指引用户去核对明细，而不是像别的错误一样只说「失败了」。
 */

/**
 * 提交（创建任务）。放宽到五分钟：宁可多等，也别把一个已经在跑的任务判成失败。
 *
 * 为什么是"单次请求等五分钟"而不是"超时后指数退避重发"：视频提交在网关侧**还没有**
 * 客户端幂等键（v1 直连路径的 `PublicTaskID` 由网关生成），重发就是第二个任务、
 * 第二次扣费。等网关接受 `Idempotency-Key` 之后，这里换成「超时 → 按键退避查回 →
 * 查不到再同键安全重发」，总预算仍以本常量为上限。
 */
export const VIDEO_CREATE_TIMEOUT_MS = 300_000

/** 查询任务状态。轻量 JSON，轮询循环会容忍单次超时并在下一轮重试。 */
export const VIDEO_QUERY_TIMEOUT_MS = 30_000

export type VideoRequestPhase = 'create' | 'query'

/** 按阶段取超时。写成函数而不是让调用方自己挑常量，四处就不会有一处挑错。 */
export function videoRequestTimeoutMs(phase: VideoRequestPhase): number {
  return phase === 'create' ? VIDEO_CREATE_TIMEOUT_MS : VIDEO_QUERY_TIMEOUT_MS
}

/**
 * 超时后抛给上层的人话。`Error.message` 会被原样贴到工作台卡片上，Node 的
 * `This operation was aborted` 用户看不懂，也不知道钱去哪了。
 */
export function videoRequestTimeoutMessage(phase: VideoRequestPhase, timeoutMs: number): string {
  const duration = formatDuration(timeoutMs)
  if (phase === 'query') {
    return `查询任务状态超过 ${duration}未响应，稍后自动重试。`
  }
  return (
    `提交超过 ${duration}未得到网关响应，已中断。`
    + '任务可能已被网关受理并计费——请到「使用明细」核对这个时间点是否有扣费；'
    + '若已扣费，稍后刷新历史记录，结果可能已经生成。'
  )
}

/** 整分钟说"分钟",其余说"秒"——「300 秒」没人心算,「5 分钟」一眼懂。 */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`
}

/**
 * 把「我们自己掐断的请求」认出来。`fetch` 在 `AbortController.abort()` 后抛的是
 * `AbortError`（Node/undici 与 Electron `net.fetch` 都是），`signal.aborted` 是最可靠
 * 的判据；`name === 'AbortError'` 兜第二层，防某些 fetch 实现不把 signal 挂到错误上。
 */
export function isAbortedByTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
