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

export interface EraseSubmitPayload {
  filePath: string                // absolute local path from webUtils.getPathForFile
  filename: string
  fileSize: number
  durationSeconds: number         // from renderer <video> metadata
  posterDataUrl?: string          // renderer-generated thumbnail via <canvas>
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
