export interface EraseConfig {
  mode: 'definition'              // ScheduleId deferred to Phase 2
  definitionId: number            // default 303 = 系统预设·去字幕-至尊版
  autoCleanupRemoteAfterDays: number
}

export const DEFAULT_ERASE_CONFIG: EraseConfig = {
  mode: 'definition',
  definitionId: 303,
  autoCleanupRemoteAfterDays: 7,
}

/**
 * 「智能去字幕」页上的两个工具。
 *
 *  - `enhance`:视频高清(火山 MediaKit,经 Miau 网关,可用平台余额)。**默认。**
 *  - `erase`:去字幕(腾讯 MPS 模板 303,直连,用腾讯云密钥)。
 *
 * 两条路的上传、计费、上游都不同,只是共用同一个页面壳与队列。
 */
export type EraseTool = 'enhance' | 'erase'
export const DEFAULT_ERASE_TOOL: EraseTool = 'enhance'

export interface EraseSubmitPayload {
  filePath: string                // absolute local path from webUtils.getPathForFile
  filename: string
  fileSize: number
  durationSeconds: number         // from renderer <video> metadata
  posterDataUrl?: string          // renderer-generated thumbnail via <canvas>
  /** 缺省按 `DEFAULT_ERASE_TOOL`(渲染层总会显式带,这里只是让类型与老调用方兼容)。 */
  tool?: EraseTool
  /**
   * 高清那条路的计费意向(与视频工作台同一对字面量)。只对 `enhance` 有意义;
   * 去字幕走腾讯云密钥,与平台余额无关。缺省由主进程按手上有没有影子 token 判。
   */
  billing?: 'platform' | 'own-key'
}

export interface EraseProbeResult {
  filePath: string
  filename: string
  fileSize: number
  durationSeconds: number
  warning?: 'FILE_PATH_UNAVAILABLE' | 'FILE_NOT_LOCAL' | 'PROBE_FAILED' | string
}

/**
 * Curated snapshot of the latest Tencent DescribeTaskDetail response.
 * Surfaced so the renderer can show a "查看详情" panel matching what the
 * Tencent MPS console shows, without forwarding the whole SDK payload.
 *
 * Kept in sync with `EraseTaskDetailSnapshot` in
 * src/main/services/smartErase/runner.ts — that file owns the
 * canonical shape and the `summarizeTaskDetail` curator. We re-declare
 * it here (instead of importing across the main/renderer boundary) so
 * the renderer tree doesn't need to resolve main-process imports.
 */
export interface EraseTaskDetailSnapshot {
  workflowStatus?: string
  smartEraseStatus?: string
  progress?: number
  workflowErrCode?: number
  workflowMessage?: string
  errCodeExt?: string
  message?: string
  beginProcessTime?: string
  finishTime?: string
  outputPath?: string
  fetchedAt: number
}

export interface EraseTask {
  id: string
  filename: string
  fileSize: number
  durationSeconds: number
  status: 'queued-upload' | 'uploading' | 'queued-process' | 'submitting' | 'processing' | 'finished' | 'failed' | 'cancelled'
  uploadProgress?: number         // 0-100
  mpsTaskId?: string
  startedAt: number
  finishedAt?: number
  errorCode?: string
  errorMessage?: string
  processingStartedAt?: number   // ms; set by renderer when status → 'processing'
  /** Real MPS progress from `SmartEraseTaskResult.Progress` (0-100). */
  mpsProgress?: number
  /** Latest curated task-detail snapshot for the "查看详情" panel. */
  taskDetail?: EraseTaskDetailSnapshot
}

export interface EraseHistoryItem {
  id: string
  filename: string
  fileSize: number
  durationSeconds: number
  videoUrl: string                // COS presigned, 7 days
  videoExpiresAt: number
  posterDataUrl: string           // local ffmpeg base64 jpeg, ~10 KB; never expires
  outputCosKey: string
  inputCosKey: string
  originalFilePath: string        // for side-by-side compare; may not exist anymore — UI handles missing gracefully
  createdAt: number
  mpsTaskId?: string
  finishedAt?: number
  /** 这条结果是高清还是去字幕。老记录没有这个字段 —— 那时只有去字幕。 */
  tool?: EraseTool
}

export interface EraseProgressEvent {
  taskId: string
  status: EraseTask['status']
  uploadProgress?: number
  mpsTaskId?: string
  /** Real MPS progress from Tencent; preferred over the renderer's exponential estimate. */
  mpsProgress?: number
  /** Latest task-detail snapshot, refreshed on every poll. */
  taskDetail?: EraseTaskDetailSnapshot
}

export interface EraseFinishedEvent {
  taskId: string
  videoUrl: string
  videoExpiresAt: number
  outputCosKey: string
  inputCosKey: string
}

export interface EraseFailedEvent {
  taskId: string
  errorCode: string               // SCREAMING_SNAKE_CASE; see spec §8
  errorMessage: string
  stage: 'probe' | 'upload' | 'submit' | 'poll' | 'output' | 'unknown'
}
