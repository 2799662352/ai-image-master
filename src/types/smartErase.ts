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
  durationSeconds: number         // from ffprobe
  // NOTE: no per-task config override; reads from useErasePersistStore.defaultConfig at submit time
}

export interface EraseProbeResult {
  filePath: string
  filename: string
  fileSize: number
  durationSeconds: number
  warning?: 'FILE_PATH_UNAVAILABLE' | 'FILE_NOT_LOCAL' | 'PROBE_FAILED'
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
}

export interface EraseProgressEvent {
  taskId: string
  status: EraseTask['status']
  uploadProgress?: number
  mpsTaskId?: string
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
