// Seedance 任务的公共类型与「下载结果视频」。
//
// 这个文件原来是 vvdance 的 Ark 协议 HTTP 客户端(创建 / 查询 / 删除任务,走 vvdance 站点)。
// vvdance 直连已删除:现在 Seedance 一律经 Miau 网关提交(`seedanceGateway/client.ts`),
// 这里只剩两样**与上游无关**的东西 —— 轮询结果的类型形状,和把成片字节落盘的下载。

import { retryDownload } from './downloadRetry'
import { downloadVideoToDisk } from './videoDownload'
import type { SeedanceTaskStatus } from './types'

export interface SeedanceQueryResult {
  id: string
  status: SeedanceTaskStatus
  content?: { video_url?: string }
  usage?: { completion_tokens?: number; total_tokens?: number }
  /**
   * 按秒计费的 provider（万相）回传的实际出片秒数。与 `usage.completion_tokens`
   * 互斥 —— 单位和单价表都不同，合成一个字段就得再带一个「这是什么」的标记。
   */
  billedSeconds?: number
  /** 上游实际使用的随机种子（含随机 seed 的最终值,可复现）。 */
  seed?: number
  /**
   * 网关**之后那一跳**的任务号（火山 Ark `cgt-…` / DashScope uuid）。
   *
   * `id` 是网关签发的、只对我们这一侧有意义,找供应商对账他们不认它,认的是这个。
   * 第一轮轮询就有,不必等成片。
   */
  upstreamTaskId?: string
  error?: { code?: string; message?: string }
}

export interface SeedanceClient {
  /** 流式下载到 `destPath`,返回最终文件路径。落盘失败会抛错。 */
  downloadVideo: (videoUrl: string, destPath: string) => Promise<string>
}

/**
 * 单次视频 HTTP 请求的硬超时，按阶段取自 `videoRequestTimeouts`(提交 120s / 查询
 * 30s,理由见那边)。
 */
export { VIDEO_CREATE_TIMEOUT_MS, VIDEO_QUERY_TIMEOUT_MS } from '../videoRequestTimeouts'

export { SeedanceApiError } from './apiError'

export const seedanceClient: SeedanceClient = {
  async downloadVideo(videoUrl, destPath) {
    // 三次尝试、退避 3s / 6s 岔开。岔开是关键:原本两次尝试间隔为零,一次几秒的
    // 抖动会把它们一起吃掉,而这条路径没有第二轮 —— 落盘失败就意味着本地和 COS
    // 都没有副本,只剩会过期的上游地址。
    //
    // 这一层是**编排层**重试。传输层的重试只覆盖建连阶段,一旦响应流开始,传到
    // 800MB 时断线是兜不住的,所以必须在外面整个重来。每次重试都从零开始写 .part
    // (createWriteStream 默认 'w' 模式会截断上一次的残留),不会拼出坏文件。
    //
    // 具体的流式下载、空闲超时、字节数校验与原子落位都在 videoDownload.ts 里,
    // 包括为什么必须用 net.request 而非 net.fetch(中文响应头,见 #42244)。
    // 5 次 / 5s 起步翻倍 = 5+10+20+40，即时这一轮覆盖约 75 秒。
    // 原来是 3 次 / 3s(约 9 秒)—— 实测的失败是 ERR_CONNECTION_CLOSED，对端抖动
    // 常常几十秒才恢复，9 秒窗口正好整个落在抖动里。落盘失败的代价是本地和 COS
    // 都没副本、只剩一天后过期的上游地址，多等一分钟远比丢片划算。
    // 更长的窗口由 taskManager 的分钟级后台重试接手。
    return retryDownload(() => downloadVideoToDisk(videoUrl, destPath), {
      attempts: 5,
      delayMs: 5_000,
    })
  },
}
