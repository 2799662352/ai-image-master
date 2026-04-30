import { uploadStream, getPresignedUrl, cancelUpload } from '../tencent/cosClient'
import { getMpsClient } from '../tencent/mpsClient'
import { getCredentials } from '../tencent/credentials'
import type { EraseConfig } from '../../../types/smartErase'

const SEVEN_DAYS_S = 7 * 24 * 60 * 60
const SEVEN_DAYS_MS = SEVEN_DAYS_S * 1000

const POLL_TIMEOUT_FLOOR_MS = 60 * 60 * 1000          // 60 minutes
const POLL_DURATION_MULTIPLIER = 4                    // poll budget = max(floor, duration * 4)

const POLL_INTERVAL_FAST_MS = 5_000                   // first 6 polls
const POLL_INTERVAL_MED_MS = 10_000                   // next 30 polls
const POLL_INTERVAL_SLOW_MS = 15_000                  // thereafter

const FAST_THRESHOLD = 6
const MED_THRESHOLD = 36

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
 * Pure: total time we'll wait for MPS to finish, given the source video length.
 * Floor = 60min so a 5s clip still has reasonable headroom; multiplier = 4
 * matches Tencent's empirical "smart-erase processes at ~0.25× realtime" guidance.
 *
 * Defensive: a non-finite or negative durationSeconds (probe failed and renderer
 * still submitted, or future-spec manual override) falls back to the floor
 * rather than producing NaN deadline (which would make `Date.now() < deadline`
 * permanently false and POLL_TIMEOUT immediately, shadowing the real failure).
 *
 * Exported for direct unit testing — see runner.test.ts tests 11+12+16.
 */
export function calculatePollDeadline(durationSeconds: number, nowMs: number): number {
  const safe = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0
  const dynamicMs = safe * POLL_DURATION_MULTIPLIER * 1000
  return nowMs + Math.max(POLL_TIMEOUT_FLOOR_MS, dynamicMs)
}

function pollIntervalMs(attempt: number): number {
  if (attempt <= FAST_THRESHOLD) return POLL_INTERVAL_FAST_MS
  if (attempt <= MED_THRESHOLD) return POLL_INTERVAL_MED_MS
  return POLL_INTERVAL_SLOW_MS
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
        events.onProgress?.({ stage: 'uploading', uploadProgress: info?.percent })
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

  const startedAt = Date.now()
  const deadline = calculatePollDeadline(job.durationSeconds, startedAt)
  let attempt = 0

  while (Date.now() < deadline) {
    if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled during poll', 'poll')

    attempt++
    const taskResp = await client.DescribeTaskDetail({ TaskId: mpsTaskId })

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

  throw makeError(
    'POLL_TIMEOUT',
    `MPS task ${mpsTaskId} did not finish within ${Math.round((deadline - startedAt) / 60000)} minutes`,
    'poll',
  )
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
