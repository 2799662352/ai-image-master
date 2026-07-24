// src/main/services/tencent/types.ts

export interface Credentials {
  secretId: string
  secretKey: string
  bucket: string
  region: string
}

export interface CredentialState {
  hasCredentials: boolean
  /**
   * 'sts' = 用户没填永久密钥,媒体功能(分镜切图/智能去字幕)走 SCF 云函数
   * 的 scope=media 临时票据(免密钥通道,见 tencent/stsCredentials.ts)。
   */
  credentialSource: 'store' | 'memory' | 'env' | 'builtin' | 'sts' | 'none'
  secretIdMasked?: string
  bucket?: string
  region?: string
}

export interface JobLifecycleEvents<TInput, TOutput> {
  onProgress?: (job: TInput, patch: { stage: string; progress: number; meta?: any }) => void
  onFinished?: (job: TInput, result: TOutput) => void
  onFailed?: (job: TInput, error: { code: string; message: string; stage: string }) => void
}

export type JobRunner<TInput, TOutput> = (
  job: TInput,
  signal: AbortSignal,
  events: JobLifecycleEvents<TInput, TOutput>,
) => Promise<TOutput>

export interface JobQueueOptions<TInput, TOutput> {
  name: string
  maxConcurrent: number
  runner: JobRunner<TInput, TOutput>
  events: JobLifecycleEvents<TInput, TOutput>
  getJobId: (job: TInput) => string
}
