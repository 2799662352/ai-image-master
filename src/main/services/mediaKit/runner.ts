/**
 * 高清 / 去字幕 Pro 的两阶段执行器,给 `smartErase/index.ts` 的双队列用。
 *
 * 与 MPS 去字幕那条 runner 的分工一致(上传 / 提交+轮询两段,便于双队列拼装),
 * 但两段的内容都换了:
 *  - 上传不进 smart-erase 的媒体桶,而是走 `relayFileToCos` —— 视频工作台、视频理解
 *    共用的那个中转(流式分片、STS、带重试),拿回一个公网 https URL;
 *  - 处理不打 MPS,而是把 URL 交给 Miau 网关上的火山 MediaKit 工具。
 *
 * ## 为什么一定是 URL
 *
 * 上游要自己去拉视频,`data:` 拉不到。所以这里**没有** base64 路径可以退回 ——
 * 中转失败就是失败,如实报,不做「塞 base64 试试」。
 */

import { relayFileToCos } from '../tencent/mediaRelay'
import type { EnhanceOptions, MediaKitClient, MediaKitModel, MediaKitAuthHeaders } from './client'

const POLL_INITIAL_MS = 5_000
const POLL_BACKOFF_FACTOR = 1.4
const POLL_CAP_MS = 30_000

/**
 * 轮询期间允许的**连续**失败次数(成功一轮即清零)。
 *
 * 2026-09-01 对着测试网关跑一条 10 秒样片:60 轮里 502 了 9 次,全是瞬时的(下一轮
 * 就正常),而任务在上游一直好好跑着。一抖就报失败等于把一笔已经扣了的钱丢掉。
 */
export const MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES = 5

export function mediaKitPollIntervalMs(attempt: number): number {
  return Math.min(POLL_CAP_MS, Math.round(POLL_INITIAL_MS * Math.pow(POLL_BACKOFF_FACTOR, attempt - 1)))
}

function makeError(code: string, message: string, stage: string): Error {
  const err: any = new Error(message)
  err.code = code
  err.stage = stage
  return err
}

function mimeFor(filename: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase()
  switch (ext) {
    case 'mov':
      return 'video/quicktime'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'avi':
      return 'video/x-msvideo'
    default:
      return 'video/mp4'
  }
}

export interface MediaKitUploadInput {
  filePath: string
  filename: string
  fileSize: number
}

/** 阶段一:本地文件 → 公网 URL。 */
export async function runMediaKitUpload(
  job: MediaKitUploadInput,
  signal: AbortSignal,
  events: { onProgress?: (p: { stage: 'uploading' }) => void } = {},
): Promise<{ sourceUrl: string }> {
  if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled before upload', 'upload')
  events.onProgress?.({ stage: 'uploading' })
  // relayFileToCos 没有进度回调与取消口(它服务的是理解 / 工作台那些「传完就走」的
  // 场景)。这里的取舍是接受上传阶段不可中断、无百分比 —— 换来的是不另起一套
  // 上传实现。取消会在上传结束后的检查点生效。
  try {
    const sourceUrl = await relayFileToCos(job.filePath, mimeFor(job.filename), { fileSize: job.fileSize })
    return { sourceUrl }
  } catch (e) {
    throw makeError('RELAY_UPLOAD_FAILED', e instanceof Error ? e.message : String(e), 'upload')
  }
}

export interface MediaKitProcessInput {
  model: MediaKitModel
  sourceUrl: string
  options: EnhanceOptions
}

export interface MediaKitProcessProgress {
  stage: 'submitting' | 'processing'
  taskId?: string
  progress?: number
}

/** 阶段二:提交给网关并轮询到终态。返回上游给的结果 URL(临时链接,调用方负责转存)。 */
export async function runMediaKitProcessAndPoll(
  client: MediaKitClient,
  resolveAuth: () => MediaKitAuthHeaders,
  job: MediaKitProcessInput,
  signal: AbortSignal,
  events: { onProgress?: (p: MediaKitProcessProgress) => void } = {},
): Promise<{ videoUrl: string; taskId: string }> {
  events.onProgress?.({ stage: 'submitting' })

  let taskId: string
  try {
    ;({ id: taskId } = await client.submit(job.model, job.sourceUrl, job.options, resolveAuth()))
  } catch (e) {
    throw makeError('MEDIAKIT_SUBMIT_FAILED', e instanceof Error ? e.message : String(e), 'submit')
  }
  events.onProgress?.({ stage: 'processing', taskId })

  let attempt = 0
  let consecutiveFailures = 0
  // 不设总超时:实测一条 10 秒样片在上游跑了十几分钟。与去字幕 runner 同一条
  // 用户反馈(「我不需要超时失败」),用户想停可以自己取消。
  while (true) {
    if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled during poll', 'poll')
    attempt++
    await new Promise<void>((resolve) => setTimeout(resolve, mediaKitPollIntervalMs(attempt)))
    if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled during poll', 'poll')

    let result
    try {
      // 每轮现取鉴权头:用户中途切计费模式,下一轮就该记到新的归属上。
      result = await client.query(taskId, resolveAuth())
    } catch (e) {
      consecutiveFailures++
      const message = e instanceof Error ? e.message : String(e)
      if (consecutiveFailures >= MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES) {
        throw makeError('MEDIAKIT_POLL_FAILED', `连续 ${consecutiveFailures} 次查询任务状态失败：${message}`, 'poll')
      }
      console.warn(`[mediaKit] poll ${taskId} failed (${consecutiveFailures}/${MEDIAKIT_POLL_MAX_CONSECUTIVE_FAILURES}), retrying:`, message)
      continue
    }
    consecutiveFailures = 0
    events.onProgress?.({ stage: 'processing', taskId, progress: result.progress })

    if (result.status === 'queued' || result.status === 'running') continue
    if (result.status === 'succeeded') {
      if (!result.videoUrl) throw makeError('OUTPUT_NOT_FOUND', '任务完成但上游没有返回结果链接', 'output')
      return { videoUrl: result.videoUrl, taskId }
    }
    const detail = [result.error?.code, result.error?.message].filter(Boolean).join(': ')
    throw makeError(
      result.status === 'cancelled' ? 'TASK_CANCELLED' : 'MEDIAKIT_TASK_FAILED',
      detail || `上游任务${result.status === 'cancelled' ? '已取消' : '失败'}`,
      'poll',
    )
  }
}
