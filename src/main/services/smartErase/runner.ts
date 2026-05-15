import { uploadStream, getPresignedUrl, cancelUpload } from '../tencent/cosClient'
import { getMpsClient } from '../tencent/mpsClient'
import { getCredentials } from '../tencent/credentials'
import type { EraseConfig, EraseTaskDetailSnapshot } from '../../../types/smartErase'

// Re-export so existing callers (and unit tests) keep working without
// importing from `types/`. The canonical shape lives in types/smartErase.ts
// so renderer + main share one declaration.
export type { EraseTaskDetailSnapshot }

const SEVEN_DAYS_S = 7 * 24 * 60 * 60
const SEVEN_DAYS_MS = SEVEN_DAYS_S * 1000

// Historical poll-timeout knobs. Production code no longer enforces a
// deadline — the runtime loop in `runProcessAndPoll` polls until terminal
// status or user cancel, matching user feedback "我不需要超时失败" (2026-05-15).
// These constants remain only for `calculatePollDeadline`, which is kept
// exported for back-compat with existing unit tests (Tests 11/12/16).
const POLL_TIMEOUT_FLOOR_MS = 60 * 60 * 1000          // 60 minutes
const POLL_DURATION_MULTIPLIER = 4                    // poll budget = max(floor, duration * 4)

const POLL_INITIAL_MS = 5_000
const POLL_BACKOFF_FACTOR = 1.4
const POLL_CAP_MS = 60_000

export interface EraseJobInput {
  taskId: string
  filePath: string
  filename: string
  durationSeconds: number
  posterDataUrl: string
  config: EraseConfig
}

export interface EraseJobOutput {
  videoUrl: string
  videoExpiresAt: number
  outputCosKey: string
  inputCosKey: string
  posterDataUrl: string
  mpsTaskId: string
}

export interface RunnerProgressPatch {
  stage: 'uploading' | 'submitting' | 'processing'
  uploadProgress?: number
  mpsTaskId?: string
  /** Real MPS progress reported by Tencent (0–100). Absent until first poll. */
  mpsProgress?: number
  /** Latest curated task detail snapshot; refreshed on every poll. */
  taskDetail?: EraseTaskDetailSnapshot
}

export interface RunnerEvents {
  onProgress?: (patch: RunnerProgressPatch) => void
}

// Phase-split inputs/outputs (added in Task 6 to support dual-queue composer
// without duplicating ~80 lines of upload/poll logic). The monolithic
// runEraseJob below remains exported for tests + any single-shot callers.
export interface UploadPhaseInput {
  taskId: string
  filePath: string
  filename: string
}
export interface UploadPhaseOutput {
  inputCosKey: string
}
export interface ProcessPhaseInput {
  taskId: string
  filename: string
  durationSeconds: number
  config: EraseConfig
  inputCosKey: string
}
export interface ProcessPhaseOutput {
  videoUrl: string
  videoExpiresAt: number
  outputCosKey: string
  mpsTaskId: string
}

function makeError(code: string, message: string, stage: string): Error {
  const err: any = new Error(message)
  err.code = code
  err.stage = stage
  return err
}

/**
 * @deprecated As of 2026-05-15, `runProcessAndPoll` no longer enforces a
 * finite poll deadline — user feedback was that long uploads / MPS queue
 * backups should not turn into POLL_TIMEOUT failures. The function is
 * preserved here only because external callers and existing unit tests
 * (runner.test.ts Tests 11/12/16) still exercise its math; new code
 * should not call it.
 *
 * Pure: total time we'd wait for MPS to finish, given the source video
 * length. Floor = 60min so a 5s clip still has reasonable headroom;
 * multiplier = 4 matches Tencent's empirical "smart-erase processes at
 * ~0.25× realtime" guidance. Non-finite / negative `durationSeconds`
 * falls back to the floor.
 */
export function calculatePollDeadline(durationSeconds: number, nowMs: number): number {
  const safe = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0
  const dynamicMs = safe * POLL_DURATION_MULTIPLIER * 1000
  return nowMs + Math.max(POLL_TIMEOUT_FLOOR_MS, dynamicMs)
}

/**
 * Curate a `DescribeTaskDetail` response down to the fields the UI cares
 * about. Pure + exported so the renderer-side detail panel can be unit
 * tested against the same shape we transmit over IPC. `taskResp` is
 * typed loosely (`any`) because the Tencent SDK's union types span many
 * task types and would force a noisy cast at every call site.
 */
export function summarizeTaskDetail(taskResp: any, nowMs: number = Date.now()): EraseTaskDetailSnapshot {
  const wf = taskResp?.WorkflowTask
  const result = wf?.SmartEraseTaskResult
  const progressRaw = Number(result?.Progress)
  const progress = Number.isFinite(progressRaw)
    ? Math.max(0, Math.min(100, Math.round(progressRaw)))
    : undefined
  const path: string | undefined = typeof result?.Output?.Path === 'string'
    ? result.Output.Path
    : undefined
  return {
    workflowStatus: typeof taskResp?.Status === 'string' ? taskResp.Status : undefined,
    smartEraseStatus: typeof result?.Status === 'string' ? result.Status : undefined,
    progress,
    workflowErrCode: typeof wf?.ErrCode === 'number' ? wf.ErrCode : undefined,
    workflowMessage: typeof wf?.Message === 'string' ? wf.Message : undefined,
    errCodeExt: typeof result?.ErrCodeExt === 'string' && result.ErrCodeExt ? result.ErrCodeExt : undefined,
    message: typeof result?.Message === 'string' && result.Message ? result.Message : undefined,
    beginProcessTime: typeof result?.BeginProcessTime === 'string' ? result.BeginProcessTime : undefined,
    finishTime: typeof result?.FinishTime === 'string' ? result.FinishTime : undefined,
    outputPath: path,
    fetchedAt: nowMs,
  }
}

export function pollIntervalMs(attempt: number): number {
  return Math.min(
    POLL_CAP_MS,
    Math.round(POLL_INITIAL_MS * Math.pow(POLL_BACKOFF_FACTOR, attempt - 1)),
  )
}

function isTemplateNotFoundError(err: any): boolean {
  const code: string = String(err?.code ?? '')
  // Tencent SDK rejection codes for missing/invalid template definitions:
  // - InvalidParameterValue.Definition  (most common)
  // - InvalidParameter.Definition       (older variant)
  // - ResourceNotFound.Template/Definition (rare; defensive)
  return code.includes('Definition') || code.includes('Template')
}

/**
 * Phase 1 (upload only). The shared cosClient API doesn't natively accept
 * AbortSignal — it exposes cancelUpload(cosTaskId) and surfaces the cosTaskId
 * via onTaskReady. We bridge the two so external aborts during the multipart
 * upload propagate cleanly.
 *
 * Caller is responsible for the post-upload signal.aborted check (see
 * runEraseJob below). runUpload itself does NOT throw on abort-after-resolve
 * because the dual-queue composer (Task 6) needs to hand off to the next
 * queue regardless and let that queue's runner observe the abort.
 */
export async function runUpload(
  job: UploadPhaseInput,
  signal: AbortSignal,
  events: { onProgress?: (p: { stage: 'uploading'; uploadProgress?: number }) => void } = {},
): Promise<UploadPhaseOutput> {
  const inputCosKey = `smart-erase/${job.taskId}/input/${job.filename}`

  let cosTaskId: string | null = null
  const onAbortDuringUpload = () => {
    if (cosTaskId) cancelUpload(cosTaskId)
  }
  signal.addEventListener('abort', onAbortDuringUpload)

  events.onProgress?.({ stage: 'uploading' })
  try {
    await uploadStream({
      key: inputCosKey,
      filePath: job.filePath,
      onTaskReady: (id: string) => { cosTaskId = id },
      onProgress: (info: any) => {
        // cos-nodejs-sdk-v5 emits info.percent as a 0-1 fraction; the public
        // EraseTask.uploadProgress contract is 0-100 integer (see types/
        // smartErase.ts:35 + EraseQueue.tsx renders it as `${value}%`).
        // Convert at the source so every consumer sees the canonical scale.
        const raw = Number(info?.percent)
        const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw * 100))) : undefined
        events.onProgress?.({ stage: 'uploading', uploadProgress: pct })
      },
    })
  } finally {
    signal.removeEventListener('abort', onAbortDuringUpload)
  }

  return { inputCosKey }
}

/**
 * Phase 2+3 (submit ProcessMedia + poll DescribeTaskDetail). Pre-condition:
 * the input is already uploaded to inputCosKey.
 */
export async function runProcessAndPoll(
  job: ProcessPhaseInput,
  signal: AbortSignal,
  events: { onProgress?: (p: { stage: 'submitting' | 'processing'; mpsTaskId?: string }) => void } = {},
): Promise<ProcessPhaseOutput> {
  events.onProgress?.({ stage: 'submitting' })
  const creds = getCredentials()
  const client = getMpsClient()

  let mpsTaskId: string
  try {
    const resp = await client.ProcessMedia({
      InputInfo: {
        Type: 'COS',
        CosInputInfo: { Bucket: creds.bucket, Region: creds.region, Object: '/' + job.inputCosKey },
      },
      OutputStorage: {
        Type: 'COS',
        CosOutputStorage: { Bucket: creds.bucket, Region: creds.region },
      },
      OutputDir: `/smart-erase/${job.taskId}/output/`,
      // SmartEraseTask is a TOP-LEVEL sibling of MediaProcessTask in
      // ProcessMediaRequest (per mps_models.d.ts:9436). NOT nested,
      // NOT a *Set array. Single object, single Definition.
      SmartEraseTask: { Definition: job.config.definitionId },
    })
    mpsTaskId = resp.TaskId
  } catch (err: any) {
    if (isTemplateNotFoundError(err)) {
      throw makeError(
        'TEMPLATE_NOT_FOUND',
        `MPS template ${job.config.definitionId} not found: ${err.message ?? err}`,
        'submit',
      )
    }
    throw makeError('MPS_SUBMIT_FAILED', err?.message ?? String(err), 'submit')
  }

  events.onProgress?.({ stage: 'processing', mpsTaskId })

  let attempt = 0

  // Infinite poll loop. The only exits are:
  //   1. signal.aborted     → TASK_CANCELLED  (user pressed × in the queue)
  //   2. result.Status='SUCCESS' → return cleanly
  //   3. result.Status='FAIL' / wf.ErrCode !== 0 → MPS_TASK_FAILED / MPS_SOURCE_ERROR
  //   4. Other terminal states surfaced as UNKNOWN_ERROR
  //
  // We previously enforced a `max(60min, duration×4)` deadline that fired
  // POLL_TIMEOUT — but for short clips it forced 60min ceiling regardless,
  // which the user said was wrong (2026-05-15 feedback: "我不需要超时失败").
  // Tencent's task table will show the real status as long as it's pending,
  // and the user can always cancel manually if something is truly stuck.
  while (true) {
    if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled during poll', 'poll')

    attempt++
    const taskResp = await client.DescribeTaskDetail({ TaskId: mpsTaskId })
    const detail = summarizeTaskDetail(taskResp)

    // Always emit the latest detail snapshot so the renderer's "查看详情"
    // panel and progress bar see fresh data on every poll — including
    // during WAITING (no SmartEraseTaskResult yet but parent Status is set).
    events.onProgress?.({
      stage: 'processing',
      mpsTaskId,
      mpsProgress: detail.progress,
      taskDetail: detail,
    })

    const topStatus = taskResp?.Status
    if (topStatus === 'WAITING' || topStatus === 'PROCESSING') {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs(attempt)))
      continue
    }
    if (topStatus !== 'FINISH') {
      throw makeError('UNKNOWN_ERROR', `Unexpected resp.Status=${topStatus}`, 'poll')
    }

    const wf = taskResp?.WorkflowTask
    if (!wf) throw makeError('OUTPUT_NOT_FOUND', 'FINISH but no WorkflowTask', 'poll')

    if (typeof wf.ErrCode === 'number' && wf.ErrCode !== 0) {
      throw makeError('MPS_SOURCE_ERROR', `${wf.ErrCode}: ${wf.Message ?? ''}`, 'poll')
    }

    const result = wf.SmartEraseTaskResult
    if (!result) throw makeError('OUTPUT_NOT_FOUND', 'FINISH but no SmartEraseTaskResult', 'poll')

    if (result.Status === 'PROCESSING') {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs(attempt)))
      continue
    }
    if (result.Status === 'FAIL') {
      throw makeError('MPS_TASK_FAILED', `${result.ErrCodeExt ?? ''}: ${result.Message ?? ''}`, 'poll')
    }
    if (result.Status === 'SUCCESS') {
      const path: string | undefined = result.Output?.Path
      if (!path) throw makeError('OUTPUT_NOT_FOUND', 'SUCCESS but no Output.Path', 'output')
      const outputCosKey = path.replace(/^\/+/, '')
      const videoUrl = await getPresignedUrl({ key: outputCosKey, expireSeconds: SEVEN_DAYS_S })
      return {
        videoUrl,
        videoExpiresAt: Date.now() + SEVEN_DAYS_MS,
        outputCosKey,
        mpsTaskId,
      }
    }

    throw makeError('UNKNOWN_ERROR', `Unexpected SmartEraseTaskResult.Status=${result.Status}`, 'poll')
  }
}

/**
 * Single-shot orchestrator. Composer (Task 6) does NOT use this — it calls
 * runUpload + runProcessAndPoll separately to enable the dual-queue
 * architecture. Kept for unit-testability and as a documentation of the
 * full flow.
 */
export async function runEraseJob(
  job: EraseJobInput,
  signal: AbortSignal,
  events: RunnerEvents = {},
): Promise<EraseJobOutput> {
  const { inputCosKey } = await runUpload(
    { taskId: job.taskId, filePath: job.filePath, filename: job.filename },
    signal,
    events as any,
  )

  if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled after upload', 'upload')

  const result = await runProcessAndPoll(
    {
      taskId: job.taskId,
      filename: job.filename,
      durationSeconds: job.durationSeconds,
      config: job.config,
      inputCosKey,
    },
    signal,
    events as any,
  )

  return {
    ...result,
    inputCosKey,
    posterDataUrl: job.posterDataUrl,
  }
}
