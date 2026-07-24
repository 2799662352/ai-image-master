// src/main/services/storyboardSplit/runner.ts

import { uploadBuffer, getPresignedUrl } from '../tencent/cosClient'
import { getMpsClient } from '../tencent/mpsClient'
import { getMediaAuth } from '../tencent/mediaAuth'
import type { JobLifecycleEvents } from '../tencent/types'
import type { SplitConfig, SplitResult } from '../../../types/storyboardSplit'

const SEVEN_DAYS_S = 7 * 24 * 60 * 60

export interface ImageJobInput {
  taskId: string
  buffer: Buffer
  filename: string
  config: SplitConfig
}

export interface ImageJobOutput {
  results: SplitResult[]
  rows: number
  cols: number
  inputCosKey: string
  mpsTaskId: string
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

function inferGrid(total: number): { rows: number; cols: number } {
  if (total <= 1) return { rows: 1, cols: 1 }
  const cols = Math.ceil(Math.sqrt(total))
  const rows = Math.ceil(total / cols)
  return { rows, cols }
}

function makeError(code: string, message: string, stage: string): Error {
  const err: any = new Error(message)
  err.code = code
  err.stage = stage
  return err
}

export async function submitProcessImage(
  presignedUrl: string,
  config: SplitConfig,
  outputDir: string,
): Promise<string> {
  // 永久密钥优先,未配置时走 STS 免密钥通道(桶/区域随票据下发)。
  const auth = await getMediaAuth()
  const client = await getMpsClient()

  const stdExtInfo: Record<string, any> = {
    StoryboardConfig: { ModelSamplingAuraFlow: config.modelSamplingAuraFlow },
  }
  if (config.processIndex !== undefined) {
    stdExtInfo.StoryboardConfig.ProcessIndex = config.processIndex
  }

  const resp = await client.ProcessImage({
    InputInfo: { Type: 'URL', UrlInputInfo: { Url: presignedUrl } },
    OutputStorage: { Type: 'COS', CosOutputStorage: { Bucket: auth.bucket, Region: auth.region } },
    OutputDir: outputDir,
    ScheduleId: config.scheduleId,
    StdExtInfo: JSON.stringify(stdExtInfo),
  })

  return resp.TaskId
}

export async function pollImageUntilFinish(
  taskId: string,
  signal: AbortSignal,
  onProgress: (attempt: number, maxAttempts: number) => void,
  maxDurationMs = 10 * 60 * 1000,
): Promise<{ results: SplitResult[]; rows: number; cols: number }> {
  const deadline = Date.now() + maxDurationMs
  let attempt = 0
  const estimatedAttempts = 120

  while (Date.now() < deadline) {
    if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled', 'poll')

    // 每轮重新取 client:STS 模式下票据到期时 getMpsClient 自动重建。
    const client = await getMpsClient()
    const resp = await client.DescribeImageTaskDetail({ TaskId: taskId })
    attempt++
    onProgress(attempt, estimatedAttempts)

    if (resp.Status === 'FINISH') {
      if (resp.ErrCode && resp.ErrCode !== 0) {
        throw makeError(String(resp.ErrCode), resp.ErrMsg || `MPS error: ${resp.ErrCode}`, 'poll')
      }
      const resultSet = resp.ImageProcessTaskResultSet || []
      const results: SplitResult[] = await Promise.all(
        resultSet.map(async (r: any, idx: number) => {
          const cosPath = (r.Output?.Path || '').replace(/^\//, '')
          const url = await getPresignedUrl({ key: cosPath, expireSeconds: SEVEN_DAYS_S })
          return { index: idx, url, cosPath, expiresAt: Date.now() + SEVEN_DAYS_S * 1000 }
        }),
      )
      const { rows, cols } = inferGrid(results.length)
      return { results, rows, cols }
    }

    if (resp.Status === 'FAIL' || (resp.ErrCode && resp.ErrCode !== 0)) {
      throw makeError(
        String(resp.ErrCode || 'MPS_TASK_FAILED'),
        resp.ErrMsg || resp.Message || `MPS task failed: ${resp.Status}`,
        'poll',
      )
    }

    const interval = attempt <= 10 ? 2000 : attempt <= 30 ? 3000 : 5000
    await new Promise((r) => setTimeout(r, interval))
  }

  throw makeError('POLL_TIMEOUT', `轮询超时，MPS 任务未在 ${Math.round(maxDurationMs / 60000)} 分钟内完成`, 'poll')
}

export async function runImageJob(
  job: ImageJobInput,
  signal: AbortSignal,
  events: JobLifecycleEvents<ImageJobInput, ImageJobOutput>,
): Promise<ImageJobOutput> {
  const ext = job.filename.split('.').pop()?.toLowerCase() || 'jpg'
  const cosKey = `storyboard-split/${job.taskId}/input.${ext}`

  events.onProgress?.(job, { stage: 'uploading-cos', progress: 5 })
  await uploadBuffer({
    key: cosKey,
    body: job.buffer,
    contentType: CONTENT_TYPE_MAP[ext] || 'image/jpeg',
  })

  if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled after upload', 'upload')

  events.onProgress?.(job, { stage: 'uploading-cos', progress: 30 })
  events.onProgress?.(job, { stage: 'submitting-mps', progress: 35 })

  const inputUrl = await getPresignedUrl({ key: cosKey, expireSeconds: 86400 })
  const outputDir = `/storyboard-split/${job.taskId}/output/`
  const mpsTaskId = await submitProcessImage(inputUrl, job.config, outputDir)

  events.onProgress?.(job, { stage: 'polling-mps', progress: 40, meta: { mpsTaskId } })
  const { results, rows, cols } = await pollImageUntilFinish(
    mpsTaskId,
    signal,
    (attempt, max) => {
      const progress = 40 + Math.round((attempt / max) * 50)
      events.onProgress?.(job, { stage: 'polling-mps', progress })
    },
  )

  return { results, rows, cols, inputCosKey: cosKey, mpsTaskId }
}
