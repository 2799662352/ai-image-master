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
  /**
   * 转存到历史桶（COS）后的永久 https URL。这是聊天气泡 / 历史记录的
   * 持久来源 —— 不会因上游代理地址过期、也不会因本地文件被清理而失效。
   */
  remoteUrl?: string
  persistence: SeedancePersistence
  /** failed 时的上游错误（code: message）。 */
  error?: string
  /**
   * 渲染端用的「气泡身份」。generate_video 在真正 createTask 之前先用一个临时
   * clientId 广播一张「准备中」卡片；createTask 成功后真实任务的每条广播都带
   * 同一个 clientId，渲染端据此复用同一张卡片（见 SeedanceTaskListener）。
   * 缺省时（手动 MCP 调用等）渲染端回退用 taskId。
   */
  clientId?: string
  /**
   * 客户端合成相位（仅 `announcePreparing` 的预备卡片设置；上游真实任务的
   * 每条广播都不带）。用来把「createTask 之前的素材准备阶段」与上游 `queued`
   * 区分开：渲染端见到 `preparing` 显示「正在准备素材…」，而真实 `queued`
   * 仍显示「排队中」。不进入 `SeedanceTaskStatus`（那是 Ark 上游状态原样）。
   */
  phase?: 'preparing'
  /**
   * 任务来源。`workbench` = 「生成视频」工作台页提交（渲染端工作台卡片自行
   * 消费 `seedance:task-update`，SeedanceTaskListener 跳过它们，不产生聊天
   * 气泡/聊天历史）。缺省 = 聊天/MCP `generate_video` 链路，行为不变。
   */
  source?: 'workbench'
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

/**
 * 人像库「本地叠加层」—— 上游素材接口只有 列表/导入,没有改名/删除/分组。
 * 这层在主进程持久化(单一真相源),按 assetId 索引,渲染端 UI 与 MCP agent
 * 共享同一份。删除=隐藏(软删除,可恢复)。
 */
export interface AssetOverlayEntry {
  /** 自定义显示名(覆盖上游 name)。 */
  name?: string
  /** 所属用户自定义分组名;未分组为 undefined。 */
  group?: string
  /** 软删除/隐藏标记。 */
  hidden?: boolean
}

export interface PortraitOverlayState {
  /** assetId → 叠加项。 */
  entries: Record<string, AssetOverlayEntry>
  /** 已知的用户自定义分组名(有序,含空分组)。 */
  groups: string[]
}

/** 叠加层变更指令(IPC / MCP 共用)。 */
export type PortraitOverlayMutation =
  | { op: 'rename'; assetId: string; name: string }
  | { op: 'moveToGroup'; assetIds: string[]; group?: string }
  | { op: 'setHidden'; assetIds: string[]; hidden: boolean }
  | { op: 'addGroup'; name: string }
  | { op: 'removeGroup'; name: string }

/** 素材额度摘要（列表 summary 与 GET /local-assets/capacity 同形）。 */
export interface SeedanceAssetCapacity {
  used: number
  limit: number
  remaining: number
}

export interface SeedanceAssetListResult {
  items: SeedanceAssetItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  summary?: SeedanceAssetCapacity
}

/** 批量删除返回里的单条删除确认（文档 4.2.4）。 */
export interface SeedanceAssetDeleteItem {
  assetId: string
  name: string
  deletedAt: string
}

/** DELETE /local-assets 的返回（文档 4.2.4）。 */
export interface SeedanceAssetDeleteResult {
  deletedCount: number
  items: SeedanceAssetDeleteItem[]
  summary?: SeedanceAssetCapacity
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
