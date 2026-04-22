export interface SplitConfig {
  scheduleId: number
  modelSamplingAuraFlow: number
  processIndex?: number
}

export const DEFAULT_SPLIT_CONFIG: SplitConfig = {
  scheduleId: 30050,
  modelSamplingAuraFlow: 0.1,
}

export type SplitTaskStatus =
  | 'pending'
  | 'queued'
  | 'uploading'
  | 'submitted'
  | 'processing'
  | 'finished'
  | 'failed'
  | 'cancelled'

export type SplitStage =
  | 'uploading-cos'
  | 'submitting-mps'
  | 'polling-mps'
  | 'done'

export interface SplitTask {
  id: string
  filename: string
  imageDataUrl: string
  thumbnailDataUrl?: string
  status: SplitTaskStatus
  progress: number
  stage?: SplitStage
  config: SplitConfig
  mpsTaskId?: string
  results?: SplitResult[]
  error?: string
  errorCode?: string
  createdAt: number
  finishedAt?: number
  readonly?: boolean
}

export interface SplitResult {
  index: number
  url: string
  cosPath: string
  expiresAt: number
}

export interface SplitHistoryItem {
  id: string
  filename: string
  thumbnailDataUrl: string
  config: SplitConfig
  results: SplitResult[]
  createdAt: number
  finishedAt: number
}

export interface CredentialState {
  hasCredentials: boolean
  credentialSource: 'env' | 'store' | 'builtin' | 'none'
  secretIdMasked?: string
  bucket?: string
  region?: string
}

export interface SplitSubmitPayload {
  taskId: string
  base64Data: string
  filename: string
  config: SplitConfig
}

export interface SplitProgressEvent {
  taskId: string
  status: SplitTaskStatus
  progress: number
  stage: SplitStage
}

export interface SplitFinishedEvent {
  taskId: string
  results: SplitResult[]
}

export interface SplitFailedEvent {
  taskId: string
  error: string
  errorCode?: string
}
