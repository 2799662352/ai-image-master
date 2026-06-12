// Seedance 视频生成 —— main / preload / renderer 三端共享类型。
// 主进程实现细节见 src/main/services/seedance/。

/** 上游任务状态（Ark 协议原样）。 */
export type SeedanceTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'

/** 落盘 bookkeeping 阶段 —— 与任务成功与否解耦。 */
export type SeedancePersistence = 'idle' | 'running' | 'done' | 'failed'

/** 对外暴露的友好模型名。 */
export type SeedanceModelAlias = '2.0' | '2.0-fast'

/** 任务快照（也是 `seedance:task-update` IPC 的载荷）。 */
export interface SeedanceTaskState {
  taskId: string
  /** 发起请求的 db thread id（气泡路由 / 落盘目录），可缺省。 */
  threadId?: string
  prompt: string
  model: SeedanceModelAlias
  resolution: string
  ratio: string
  duration: number
  status: SeedanceTaskStatus
  createdAt: number
  updatedAt: number
  /** succeeded 时上游返回的结果代理地址（有效期未知，仅作兜底）。 */
  videoUrl?: string
  /** 落盘后的本地 mp4 绝对路径（权威结果位置）。 */
  localPath?: string
  persistence: SeedancePersistence
  /** failed 时的上游错误（code: message）。 */
  error?: string
}

export type SeedanceTaskUpdate = SeedanceTaskState

/** 设置页展示用的 Key 状态（绝不回传明文 Key）。 */
export interface SeedanceKeyState {
  hasKey: boolean
  /** 形如 `sk-1a****`。 */
  keyMasked?: string
  source: 'store' | 'env' | 'none'
  /** 素材库（人像库）接口需要 API Secret 做 HMAC 签名。 */
  hasSecret: boolean
  secretMasked?: string
}

// ==================== 素材库（人像库） ====================
// 上游 /api/open/v1/local-assets 协议；图片可标记 image_people（人像）。

export type SeedanceAssetKind = 'image' | 'video' | 'audio'

/** 列表接口的 kind 过滤项（上游原样）。 */
export type SeedanceAssetKindFilter =
  | 'all'
  | 'image_people'
  | 'image_environment'
  | 'video'
  | 'audio'
  | 'text'

export interface SeedanceAssetItem {
  id: string
  kind: SeedanceAssetKind | string
  imageCategory?: 'image_people' | 'image_environment'
  name: string
  /** 后台缩略图预览地址（仅展示用）。 */
  previewUrl?: string
  sourceUrl?: string
  /** 完整 `asset://...`，创建任务时直接引用。 */
  assetUrl: string
  assetId: string
  mimeType?: string
  sizeBytes?: number
  status?: string
  createdAt?: string
  updatedAt?: string
}

export interface SeedanceAssetListResult {
  items: SeedanceAssetItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  summary?: { used: number; limit: number; remaining: number }
}

export interface SeedanceAssetListQuery {
  page?: number
  pageSize?: number
  q?: string
  kind?: SeedanceAssetKindFilter
}

export interface SeedanceAssetImportInput {
  kind: SeedanceAssetKind
  /** 远程 https URL 或 data: URL。 */
  url: string
  name?: string
  mimeType?: string
  imageCategory?: 'image_people' | 'image_environment'
}

export interface SeedanceAssetImportResult {
  duplicated: boolean
  asset: SeedanceAssetItem
}
