import { uploadOriginal, getPresignedUrl } from './cosClient'
import { submitProcessImage, pollUntilFinish } from './mpsClient'
import {
  getCredentials,
  getCredentialState,
  setCredentials,
  getDefaultConfig,
  setDefaultConfig,
} from './config'
import type {
  SplitConfig,
  SplitSubmitPayload,
  SplitProgressEvent,
  SplitFinishedEvent,
  SplitFailedEvent,
} from '../../../types/storyboardSplit'
import type { BrowserWindow } from 'electron'

const MAX_CONCURRENT = 4
const activeTasks = new Map<string, { abortSignal: { aborted: boolean } }>()
const queue: Array<{ payload: SplitSubmitPayload; resolve: () => void; reject: (err: any) => void }> = []

let mainWindowRef: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindowRef = win
}

function safeSend(channel: string, data: any) {
  if (mainWindowRef && !mainWindowRef.isDestroyed() && !mainWindowRef.webContents.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data)
  }
}

function sendProgress(data: SplitProgressEvent) {
  safeSend('storyboard-split:progress', data)
}

function sendFinished(data: SplitFinishedEvent) {
  safeSend('storyboard-split:finished', data)
}

function sendFailed(data: SplitFailedEvent) {
  safeSend('storyboard-split:failed', data)
}

function dequeue() {
  while (activeTasks.size < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()!
    runTask(item.payload).then(() => item.resolve()).catch((err) => item.reject(err))
  }
}

async function runTask(payload: SplitSubmitPayload): Promise<{ success: true; mpsTaskId: string }> {
  const abortSignal = { aborted: false }
  activeTasks.set(payload.taskId, { abortSignal })

  try {
    sendProgress({ taskId: payload.taskId, status: 'uploading', progress: 5, stage: 'uploading-cos' })

    const base64 = payload.base64Data.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(base64, 'base64')
    const ext = payload.filename.split('.').pop()?.toLowerCase() || 'jpg'

    const cosKey = await uploadOriginal(payload.taskId, buffer, ext)
    sendProgress({ taskId: payload.taskId, status: 'uploading', progress: 30, stage: 'uploading-cos' })

    if (abortSignal.aborted) throw new Error('Task cancelled')

    sendProgress({ taskId: payload.taskId, status: 'submitted', progress: 35, stage: 'submitting-mps' })
    const inputUrl = await getPresignedUrl(cosKey, 86400)
    const outputDir = `/storyboard-split/${payload.taskId}/output/`
    const mpsTaskId = await submitProcessImage(inputUrl, payload.config, outputDir)
    sendProgress({ taskId: payload.taskId, status: 'processing', progress: 40, stage: 'polling-mps' })

    const results = await pollUntilFinish(
      mpsTaskId,
      (attempt, max) => {
        const progress = 40 + Math.round((attempt / max) * 50)
        sendProgress({ taskId: payload.taskId, status: 'processing', progress, stage: 'polling-mps' })
      },
      abortSignal
    )

    sendFinished({ taskId: payload.taskId, results })
    return { success: true, mpsTaskId }
  } catch (err: any) {
    const errorCode = err.code || ''
    sendFailed({ taskId: payload.taskId, error: err.message, errorCode })
    throw err
  } finally {
    activeTasks.delete(payload.taskId)
    dequeue()
  }
}

export async function submitSplit(payload: SplitSubmitPayload) {
  const creds = getCredentials()
  if (!creds.secretId || !creds.secretKey) {
    return { success: false, error: '未配置腾讯云密钥', errorCode: 'NO_CREDENTIALS' }
  }

  try {
    if (activeTasks.size >= MAX_CONCURRENT) {
      sendProgress({ taskId: payload.taskId, status: 'queued', progress: 0, stage: 'uploading-cos' })
      await new Promise<void>((resolve, reject) => {
        queue.push({ payload, resolve, reject })
      })
    } else {
      await runTask(payload)
    }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message, errorCode: err.code || '' }
  }
}

export function cancelTask(taskId: string) {
  const task = activeTasks.get(taskId)
  if (task) {
    task.abortSignal.aborted = true
    activeTasks.delete(taskId)
  }
  const queueIdx = queue.findIndex((q) => q.payload.taskId === taskId)
  if (queueIdx >= 0) {
    const [removed] = queue.splice(queueIdx, 1)
    removed.reject(new Error('Task cancelled'))
  }
  return { success: true }
}

export function cancelAllActiveTasks() {
  for (const [, task] of activeTasks) {
    task.abortSignal.aborted = true
  }
  activeTasks.clear()
  queue.length = 0
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
