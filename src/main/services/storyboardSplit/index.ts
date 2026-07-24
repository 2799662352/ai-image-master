// src/main/services/storyboardSplit/index.ts

import { JobQueue } from '../tencent/jobQueue'
import {
  getCredentialState,
  setCredentials,
} from '../tencent/credentials'
import { deleteObjects } from '../tencent/cosClient'
import { transferUrlToHistoryBucket } from '../tencent/historyBucketTransfer'
import { runImageJob } from './runner'
import type { ImageJobInput, ImageJobOutput } from './runner'
import type {
  SplitConfig,
  SplitSubmitPayload,
  SplitProgressEvent,
  SplitFinishedEvent,
  SplitFailedEvent,
} from '../../../types/storyboardSplit'
import { DEFAULT_SPLIT_CONFIG } from '../../../types/storyboardSplit'
import type { BrowserWindow } from 'electron'

const MAX_CONCURRENT = 4

let mainWindowRef: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindowRef = win
}

function safeSend(channel: string, data: any) {
  if (mainWindowRef && !mainWindowRef.isDestroyed() && !mainWindowRef.webContents.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data)
  }
}

let defaultConfig: SplitConfig = { ...DEFAULT_SPLIT_CONFIG }

export function getDefaultConfig(): SplitConfig {
  return { ...defaultConfig }
}

export function setDefaultConfig(config: SplitConfig): void {
  defaultConfig = { ...config }
}

/**
 * 每张切片从媒体桶转存到历史桶(公开读)拿永久 URL —— STS 免密钥模式下
 * 签名 URL 只活到票据过期(≤30 分钟),转存后 expiresAt=0 表示永不过期。
 * 单张失败退回该张的签名 URL,不影响任务成功。
 */
async function persistSplitResults(
  taskId: string,
  output: ImageJobOutput,
): Promise<ImageJobOutput> {
  const results = await Promise.all(
    output.results.map(async (r) => {
      try {
        const ext = (r.cosPath.split('.').pop() || 'jpg').toLowerCase()
        const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        const permanentUrl = await transferUrlToHistoryBucket({
          sourceUrl: r.url,
          key: `image-history/storyboard-split/${taskId}/${r.index + 1}.${ext}`,
          contentType,
        })
        return { ...r, url: permanentUrl, expiresAt: 0 }
      } catch (err: any) {
        console.warn(`[SplitService] transfer #${r.index} to history bucket failed; keeping presigned URL:`, err?.message ?? err)
        return r
      }
    }),
  )
  return { ...output, results }
}

const queue = new JobQueue<ImageJobInput, ImageJobOutput>({
  name: 'storyboard-split',
  maxConcurrent: MAX_CONCURRENT,
  runner: async (job, signal, events) => {
    const output = await runImageJob(job, signal, events)
    return persistSplitResults(job.taskId, output)
  },
  events: {
    onProgress: (job, patch) => {
      const progressEvent: SplitProgressEvent = {
        taskId: job.taskId,
        status: patch.stage === 'submitting-mps' ? 'submitted'
              : patch.stage === 'polling-mps' ? 'processing'
              : 'uploading',
        progress: patch.progress,
        stage: patch.stage as any,
      }
      safeSend('storyboard-split:progress', progressEvent)
    },
    onFinished: (job, result) => {
      const finishedEvent: SplitFinishedEvent = {
        taskId: job.taskId,
        results: result.results,
        inputCosKey: result.inputCosKey,
        rows: result.rows,
        cols: result.cols,
      }
      safeSend('storyboard-split:finished', finishedEvent)
    },
    onFailed: (job, error) => {
      const failedEvent: SplitFailedEvent = {
        taskId: job.taskId,
        error: error.message,
        errorCode: (error as any).code,
      }
      safeSend('storyboard-split:failed', failedEvent)
    },
  },
  getJobId: (job) => job.taskId,
})

export async function submitSplit(payload: SplitSubmitPayload) {
  // 不再要求永久密钥:未配置时 runner 侧 getMediaAuth() 自动走 SCF 云函数
  // 的 scope=media 免密钥临时票据。端点故障会以正常任务失败面呈现。
  const base64 = payload.base64Data.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')

  if (queue.getActiveCount() >= MAX_CONCURRENT) {
    safeSend('storyboard-split:progress', {
      taskId: payload.taskId,
      status: 'queued',
      progress: 0,
      stage: 'uploading-cos',
    } as SplitProgressEvent)
  }

  try {
    await queue.enqueue({
      taskId: payload.taskId,
      buffer,
      filename: payload.filename,
      config: payload.config,
    })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message, errorCode: err.code || '' }
  }
}

export function cancelTask(taskId: string) {
  queue.cancel(taskId)
  return { success: true }
}

export function cancelAllActiveTasks() {
  queue.cancelAll()
}

export function getConfig() {
  return {
    success: true,
    defaults: getDefaultConfig(),
    credentials: getCredentialState(),
  }
}

export function setCredentialsFromUI(creds: { secretId: string; secretKey: string; bucket: string; region: string }) {
  setCredentials(creds)
  return { success: true }
}

export function setDefaultsFromUI(config: SplitConfig) {
  setDefaultConfig(config)
  return { success: true }
}

export async function deleteRemoteObjects(cosPaths: string[]) {
  if (!cosPaths.length) return { success: true }
  try {
    await deleteObjects(cosPaths)
    return { success: true }
  } catch (err: any) {
    console.warn('[SplitService] COS delete failed:', err.message)
    return { success: false, error: err.message }
  }
}
