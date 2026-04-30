// src/main/services/storyboardSplit/index.ts

import { JobQueue } from '../tencent/jobQueue'
import {
  getCredentials,
  getCredentialState,
  setCredentials,
} from '../tencent/credentials'
import { deleteObjects } from '../tencent/cosClient'
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

const queue = new JobQueue<ImageJobInput, ImageJobOutput>({
  name: 'storyboard-split',
  maxConcurrent: MAX_CONCURRENT,
  runner: runImageJob,
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
  const creds = getCredentials()
  if (!creds.secretId || !creds.secretKey) {
    return { success: false, error: '未配置腾讯云密钥', errorCode: 'NO_CREDENTIALS' }
  }

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
