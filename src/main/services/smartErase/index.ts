import { JobQueue } from '../tencent/jobQueue'
import { getCredentialState, setCredentials } from '../tencent/credentials'
import { deleteObjects } from '../tencent/cosClient'
import { transferUrlToHistoryBucket } from '../tencent/historyBucketTransfer'
import {
  runUpload,
  runProcessAndPoll,
  type UploadPhaseInput,
  type UploadPhaseOutput,
  type ProcessPhaseInput,
  type ProcessPhaseOutput,
} from './runner'
// posterGen and probe replaced by renderer-side HTML5 <video>+<canvas>
import { trackForReaping } from './reaper'
import { DEFAULT_ERASE_CONFIG } from '../../../types/smartErase'
import type {
  EraseConfig,
  EraseSubmitPayload,
  EraseProgressEvent,
  EraseFinishedEvent,
  EraseFailedEvent,
} from '../../../types/smartErase'
import type { BrowserWindow } from 'electron'

const MAX_UPLOAD_CONCURRENT = 3
const MAX_INFLIGHT = 40

// ─── Window plumbing ───────────────────────────────────────────────────────

let mainWindowRef: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  mainWindowRef = win
}

function safeSend(channel: string, data: unknown): void {
  if (
    mainWindowRef &&
    !mainWindowRef.isDestroyed() &&
    !mainWindowRef.webContents.isDestroyed()
  ) {
    mainWindowRef.webContents.send(channel, data)
  }
}

// ─── Default config ────────────────────────────────────────────────────────

let defaultConfig: EraseConfig = { ...DEFAULT_ERASE_CONFIG }

// ─── Task registry ─────────────────────────────────────────────────────────
// Single source of truth bridging the two queues; carries posterDataUrl and
// mpsTaskId across phases so cancel-during-processing can route to the reaper.

interface TaskMeta {
  payload: EraseSubmitPayload
  posterDataUrl: string
  config: EraseConfig
  inputCosKey?: string
  mpsTaskId?: string
  phase: 'queued-upload' | 'uploading' | 'queued-process' | 'processing' | 'done' | 'failed' | 'cancelled'
}

const taskRegistry = new Map<string, TaskMeta>()

// ─── Queues ────────────────────────────────────────────────────────────────

const uploadQueue = new JobQueue<UploadPhaseInput, UploadPhaseOutput>({
  name: 'smart-erase-upload',
  maxConcurrent: MAX_UPLOAD_CONCURRENT,
  runner: async (job, signal) => {
    const meta = taskRegistry.get(job.taskId)
    if (meta) meta.phase = 'uploading'
    safeSend('erase:progress', {
      taskId: job.taskId,
      status: 'uploading',
    } satisfies EraseProgressEvent)

    return runUpload(job, signal, {
      onProgress: (p) => {
        safeSend('erase:progress', {
          taskId: job.taskId,
          status: 'uploading',
          uploadProgress: p.uploadProgress,
        } satisfies EraseProgressEvent)
      },
    })
  },
  events: {
    onFinished: (job, result) => {
      const meta = taskRegistry.get(job.taskId)
      if (!meta) return
      meta.inputCosKey = result.inputCosKey
      // Defensive: if cancelled in the brief window between upload finish
      // and process enqueue, do not hand off.
      if (meta.phase === 'cancelled') return
      meta.phase = 'queued-process'
      safeSend('erase:progress', {
        taskId: job.taskId,
        status: 'queued-process',
      } satisfies EraseProgressEvent)
      processQueue
        .enqueue({
          taskId: job.taskId,
          filename: meta.payload.filename,
          durationSeconds: meta.payload.durationSeconds,
          config: meta.config,
          inputCosKey: result.inputCosKey,
        })
        .catch(() => {
          // Failure already routed through processQueue's onFailed handler
        })
    },
    onFailed: (job, err) => {
      const meta = taskRegistry.get(job.taskId)
      if (!meta) return
      const isCancel = err.code === 'TASK_CANCELLED'
      if (!isCancel) {
        // Surface the unwrapped error stack so TLS / DNS / proxy / cred
        // failures show up in the dev terminal — the IPC payload only
        // carries err.message, which strips the cause chain.
        console.error('[smart-erase] upload phase failed', {
          taskId: job.taskId,
          filename: meta.payload.filename,
          errCode: err?.code,
          errMessage: err?.message,
          innerCode: (err as any)?.error?.code ?? (err as any)?.cause?.code,
          innerMessage: (err as any)?.error?.message ?? (err as any)?.cause?.message,
          stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
        })
      }
      meta.phase = isCancel ? 'cancelled' : 'failed'
      if (isCancel) {
        safeSend('erase:progress', {
          taskId: job.taskId,
          status: 'cancelled',
        } satisfies EraseProgressEvent)
      } else {
        safeSend('erase:failed', {
          taskId: job.taskId,
          errorCode: err.code,
          errorMessage: err.message,
          stage: 'upload',
        } satisfies EraseFailedEvent)
      }
      taskRegistry.delete(job.taskId)
    },
  },
  getJobId: (job) => job.taskId,
})

const processQueue = new JobQueue<ProcessPhaseInput, ProcessPhaseOutput>({
  name: 'smart-erase-process',
  maxConcurrent: MAX_INFLIGHT,
  runner: async (job, signal) => {
    const meta = taskRegistry.get(job.taskId)
    if (meta) meta.phase = 'processing'
    const result = await runProcessAndPoll(job, signal, {
      onProgress: (p) => {
        if (meta && p.mpsTaskId) meta.mpsTaskId = p.mpsTaskId
        safeSend('erase:progress', {
          taskId: job.taskId,
          status: p.stage === 'submitting' ? 'submitting' : 'processing',
          mpsTaskId: p.mpsTaskId,
          // Real Tencent progress + the curated detail snapshot. Both
          // are optional — they're absent on the initial 'submitting'
          // emit (before any DescribeTaskDetail poll) and present on
          // every subsequent 'processing' emit. Renderer falls back to
          // the exponential estimate when mpsProgress is undefined.
          mpsProgress: p.mpsProgress,
          taskDetail: p.taskDetail,
        } satisfies EraseProgressEvent)
      },
    })

    // 转存历史桶(公开读)拿永久 URL —— 媒体桶里的签名 URL 在 STS 模式下
    // 只活到票据过期(≤30 分钟),转存后 videoExpiresAt=0 表示永不过期。
    // 转存失败不影响任务成功,退回签名 URL + 原过期时间。
    try {
      const permanentUrl = await transferUrlToHistoryBucket({
        sourceUrl: result.videoUrl,
        key: `image-history/smart-erase/${job.taskId}.mp4`,
        contentType: 'video/mp4',
      })
      return { ...result, videoUrl: permanentUrl, videoExpiresAt: 0 }
    } catch (err: any) {
      console.warn('[smart-erase] transfer to history bucket failed; falling back to presigned URL:', err?.message ?? err)
      return result
    }
  },
  events: {
    onFinished: (job, result) => {
      const meta = taskRegistry.get(job.taskId)
      if (!meta) return
      meta.phase = 'done'
      safeSend('erase:finished', {
        taskId: job.taskId,
        videoUrl: result.videoUrl,
        videoExpiresAt: result.videoExpiresAt,
        outputCosKey: result.outputCosKey,
        inputCosKey: meta.inputCosKey ?? '',
      } satisfies EraseFinishedEvent)
      taskRegistry.delete(job.taskId)
    },
    onFailed: (job, err) => {
      const meta = taskRegistry.get(job.taskId)
      if (!meta) return
      const isCancel = err.code === 'TASK_CANCELLED'
      if (!isCancel) {
        console.error('[smart-erase] process phase failed', {
          taskId: job.taskId,
          filename: meta.payload.filename,
          mpsTaskId: meta.mpsTaskId,
          errCode: err?.code,
          errMessage: err?.message,
          innerCode: (err as any)?.error?.code ?? (err as any)?.cause?.code,
          innerMessage: (err as any)?.error?.message ?? (err as any)?.cause?.message,
          stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
        })
      }
      // Cancel mid-processing: MPS task already submitted; route to reaper
      // for best-effort COS cleanup once MPS finishes.
      if (isCancel && meta.mpsTaskId && meta.inputCosKey) {
        trackForReaping(meta.mpsTaskId, meta.inputCosKey)
      }
      meta.phase = isCancel ? 'cancelled' : 'failed'
      if (isCancel) {
        safeSend('erase:progress', {
          taskId: job.taskId,
          status: 'cancelled',
        } satisfies EraseProgressEvent)
      } else {
        safeSend('erase:failed', {
          taskId: job.taskId,
          errorCode: err.code,
          errorMessage: err.message,
          stage: 'poll',
        } satisfies EraseFailedEvent)
      }
      taskRegistry.delete(job.taskId)
    },
  },
  getJobId: (job) => job.taskId,
})

// ─── Public API ────────────────────────────────────────────────────────────

export function getActiveCount(): number {
  // Sum of in-flight tasks across both queues. Reaper-tracked tasks are
  // already cancelled from the user's perspective, so we don't include them.
  return uploadQueue.getActiveCount() +
         uploadQueue.getQueuedCount() +
         processQueue.getActiveCount() +
         processQueue.getQueuedCount()
}

export function getEraseConfig() {
  return {
    success: true,
    defaults: { ...defaultConfig },
    credentials: getCredentialState(),
  }
}

export function setEraseDefaultsFromUI(config: EraseConfig) {
  defaultConfig = { ...config }
  return { success: true }
}

export function setEraseCredentialsFromUI(creds: {
  secretId: string
  secretKey: string
  bucket: string
  region: string
}) {
  setCredentials(creds)
  return { success: true }
}

export async function submitErase(
  payload: EraseSubmitPayload,
): Promise<{ success: boolean; taskId?: string; posterDataUrl?: string; error?: string; errorCode?: string }> {
  // 不再要求永久密钥:未配置时 runner 侧 getMediaAuth() 自动走 SCF 云函数
  // 的 scope=media 免密钥临时票据。端点故障会以正常任务失败面呈现。
  const posterDataUrl = payload.posterDataUrl ?? ''

  const taskId = `erase-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  taskRegistry.set(taskId, {
    payload,
    posterDataUrl,
    config: { ...defaultConfig },
    phase: 'queued-upload',
  })

  safeSend('erase:progress', {
    taskId,
    status: 'queued-upload',
  } satisfies EraseProgressEvent)

  uploadQueue
    .enqueue({
      taskId,
      filePath: payload.filePath,
      filename: payload.filename,
    })
    .catch(() => {
      // Failure already routed through uploadQueue's onFailed handler
    })

  return { success: true, taskId, posterDataUrl }
}

export function cancelEraseTask(taskId: string): { success: boolean } {
  const meta = taskRegistry.get(taskId)
  if (!meta) return { success: false }
  meta.phase = 'cancelled'
  // Try both queues; whichever holds the task will fire the cancel.
  const cancelledFromUpload = uploadQueue.cancel(taskId)
  const cancelledFromProcess = processQueue.cancel(taskId)
  return { success: cancelledFromUpload || cancelledFromProcess }
}

export function cancelAllActiveSmartEraseTasks(): void {
  // Mark every active task as cancelled before issuing aborts, so each
  // queue's onFinished/onFailed sees the marker and skips hand-off.
  for (const meta of taskRegistry.values()) meta.phase = 'cancelled'
  uploadQueue.cancelAll()
  processQueue.cancelAll()
  // NOTE: we deliberately do NOT clear the reaper here — already-tracked
  // MPS tasks should still be cleaned up best-effort.
}

export async function deleteEraseRemoteObjects(
  cosKeys: string[],
): Promise<{ success: boolean; error?: string }> {
  if (!cosKeys.length) return { success: true }
  try {
    await deleteObjects(cosKeys)
    return { success: true }
  } catch (err: any) {
    console.warn('[smart-erase] COS delete failed:', err.message)
    return { success: false, error: err.message }
  }
}

// probeBatch removed — probing now handled in renderer via HTML5 <video>
