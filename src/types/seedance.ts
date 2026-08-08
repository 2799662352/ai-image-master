// Seedance 视频生成 —— main / preload / renderer 三端共享类型。
// 主进程实现细节见 src/main/services/seedance/。

/**
 * 上游任务状态（Ark 协议原样）。`cancelled` 由 DELETE 接口在 queued 阶段产生，
 * 我们也用它表示 running 阶段的本地放弃（上游不支持取消 running，见下）。
 */
export type SeedanceTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * 取消结果。`billed` 是这个类型存在的全部理由 —— 上游文档（「取消或删除视频
 * 生成任务」）规定 DELETE 只对 `queued` 生效（转 cancelled，不计费），对
 * `running` **不支持**。所以 running 阶段的取消只能是本地放弃：视频照样生成、
 * 照样扣余额。把这个差别一路带到 UI，按钮才能如实写「取消」还是「放弃结果
 * （仍会计费）」，而不是让用户误以为省了钱。
 */
export interface SeedanceCancelResult {
  /** 是否真的把这个任务停下了（本地层面）。未知 taskId / 已终态时为 false。 */
  ok: boolean
  /** 上游是否仍会为这次生成计费。running 阶段、或 DELETE 失败无法确认时为 true。 */
  billed: boolean
  /** 人话解释（no-op 原因、或上游 DELETE 的失败详情）。 */
  reason?: string
}

/** 落盘 bookkeeping 阶段 —— 与任务成功与否解耦。 */
export type SeedancePersistence = 'idle' | 'running' | 'done' | 'failed'

/** 对外暴露的友好模型名（mini = 最便宜档,仅 480p/720p）。 */
export type SeedanceModelAlias = '2.0' | '2.0-fast' | '2.0-mini' | '2.5'

/**
 * 2.5 独有的任务模式（文档 4.9）。两者都**必须带视频参考**、比例被上游强制
 * `adaptive`;`edit` 另外锁死 `durationSeconds: -1`。
 */
export type SeedanceTaskMode = 'edit' | 'extend'

export interface SeedanceModelCapabilities {
  /** 固定秒数区间；`-1`（智能时长）任何模型都额外允许。 */
  duration: { min: number; max: number }
  /** 上游接受的 `resolution` 白名单。 */
  resolutions: readonly string[]
  maxImages: number
  maxVideos: number
  maxAudios: number
  /** 三类素材加总的上限（文档只给了 2.5 的口径）。 */
  maxMaterialsTotal: number
  /** 空数组 = 该模型没有 edit/extend。 */
  taskModes: readonly SeedanceTaskMode[]
  /** 传 `subtitleEraseEnabled=true` 是否被接受（否则上游 400）。 */
  subtitleErase: boolean
  /** 是否允许「只有音频、没有图/视频」的参考组合。 */
  audioOnlyReference: boolean
}

/**
 * 各模型的上游约束 —— 「9/3/3」「4-15」这类数字的**唯一**出处。
 *
 * 此前它们散在 videoTools / videoWorkbenchTools / modes / cardSpec 至少五处,
 * 加一个模型就要同时改五处、漏一处就是运行时 400。数字出自 vvdance 开发文档
 * (版本 2026-08-08) 第 2.2.1（4k 归属）、2.3（时长区间）、2.4（擦字幕归属）、
 * 4.9（2.5 的素材上限与 taskMode）节。
 */
export const SEEDANCE_MODEL_CAPABILITIES: Record<
  SeedanceModelAlias,
  SeedanceModelCapabilities
> = {
  '2.0': {
    duration: { min: 4, max: 15 },
    resolutions: ['480p', '720p', '1080p', '4k'],
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    maxMaterialsTotal: 15,
    taskModes: [],
    subtitleErase: true,
    audioOnlyReference: false,
  },
  '2.0-fast': {
    duration: { min: 4, max: 15 },
    // 1080p 只配 2.0 —— 这条不是文档写的（文档只点名 4k 归 2.0 独占），是
    // videoTools 早先就立着的实战规则，收编进表时原样保留，不擅自放宽。
    resolutions: ['480p', '720p'],
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    maxMaterialsTotal: 15,
    taskModes: [],
    subtitleErase: true,
    audioOnlyReference: false,
  },
  '2.0-mini': {
    duration: { min: 4, max: 15 },
    resolutions: ['480p', '720p'],
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    maxMaterialsTotal: 15,
    taskModes: [],
    subtitleErase: false,
    audioOnlyReference: false,
  },
  '2.5': {
    duration: { min: 4, max: 30 },
    resolutions: ['480p', '720p'],
    maxImages: 30,
    maxVideos: 10,
    maxAudios: 10,
    maxMaterialsTotal: 50,
    taskModes: ['edit', 'extend'],
    subtitleErase: false,
    audioOnlyReference: true,
  },
}

export function capabilitiesFor(alias: SeedanceModelAlias): SeedanceModelCapabilities {
  return SEEDANCE_MODEL_CAPABILITIES[alias]
}

export interface SeedanceRequestShape {
  duration?: number
  resolution?: string
  taskMode?: SeedanceTaskMode
  images?: number
  videos?: number
  audios?: number
  subtitleErase?: boolean
}

/**
 * 提交前把请求按模型能力核一遍,返回人话错误（空数组 = 放行）。
 *
 * 存在的理由是「别等上游 400 才知道」：4k 配 2.5、30 秒配 2.0、edit 不带视频,
 * 这几种都会被上游拒,但错误回到用户面前时已经隔了一次网络往返和一张失败卡片。
 */
export function validateSeedanceRequest(
  alias: SeedanceModelAlias,
  request: SeedanceRequestShape,
): string[] {
  const caps = capabilitiesFor(alias)
  const errors: string[] = []
  const { duration, resolution, taskMode } = request
  const images = request.images ?? 0
  const videos = request.videos ?? 0
  const audios = request.audios ?? 0

  if (taskMode && !caps.taskModes.includes(taskMode)) {
    errors.push(`模型 ${alias} 不支持 taskMode="${taskMode}"，仅 Seedance 2.5 支持 edit / extend`)
  } else if (taskMode) {
    // 两个模式都以视频为编辑对象，没有视频就无从编辑/延长。
    if (videos < 1) errors.push(`taskMode="${taskMode}" 必须至少带一段视频参考`)
    if (taskMode === 'edit' && duration !== undefined && duration !== -1) {
      errors.push('taskMode="edit" 的时长固定为 -1（智能时长），不能指定固定秒数')
    }
  }

  if (duration !== undefined && duration !== -1) {
    const { min, max } = caps.duration
    if (!Number.isInteger(duration) || duration < min || duration > max) {
      errors.push(`模型 ${alias} 的时长支持 ${min}-${max} 秒或 -1，收到 ${duration}`)
    }
  }

  if (resolution && !caps.resolutions.includes(resolution)) {
    errors.push(
      `模型 ${alias} 不支持分辨率 ${resolution}，可用：${caps.resolutions.join(' / ')}`,
    )
  }

  if (request.subtitleErase && !caps.subtitleErase) {
    errors.push(`模型 ${alias} 不支持擦除字幕（仅 2.0 与 2.0-fast 支持）`)
  }

  if (images > caps.maxImages) errors.push(`参考图最多 ${caps.maxImages} 张，收到 ${images}`)
  if (videos > caps.maxVideos) errors.push(`参考视频最多 ${caps.maxVideos} 段，收到 ${videos}`)
  if (audios > caps.maxAudios) errors.push(`参考音频最多 ${caps.maxAudios} 段，收到 ${audios}`)
  if (images + videos + audios > caps.maxMaterialsTotal) {
    errors.push(`素材总数最多 ${caps.maxMaterialsTotal} 个`)
  }

  return errors
}

/** VVDance 站点：海外 GLOBAL（默认）/ 国内。决定 Base URL 与上游模型 ID 前缀。 */
export type SeedanceRegion = 'global' | 'cn'

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
  /** succeeded 时上游回传的**实际使用**种子（含随机 seed 的最终值,可复现）。 */
  actualSeed?: number
  /** succeeded 时上游回传的 usage.completion_tokens（计费口径,文档 9.1）。 */
  completionTokens?: number
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
  /** 当前站点预设（env `SEEDANCE_BASE_URL` 可覆盖实际 Base，不改此字段）。 */
  region: SeedanceRegion
  /**
   * 当前站点**真正能提交**的模型档位，由主进程按 region + 灰度开关算出。
   *
   * 渲染端别自己枚举 `SEEDANCE_MODEL_CAPABILITIES` 的键去填下拉框：2.5 在国内站
   * 还挂着 `SEEDANCE_CN_2_5_ENABLED` 灰度，能力表里有不等于提交得上去。摆一个
   * 注定被上游拒的选项，比少摆一个更糟。
   */
  models: readonly SeedanceModelAlias[]
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
  /**
   * 本地记住的缩略图地址(导入时我们自己传给上游的那份 COS https 地址)。
   *
   * 上游只对**带字节**导入(data: URL)生成 `previewUrl`;走远程 URL 导入的素材
   * 它不去下载,`sizeBytes` 恒为 0、`previewUrl` 恒为 null(2026-08-03 实测)。
   * 而 >512KB 的文件必须走 COS —— 否则撞 `400 url is too long`。所以大图在
   * 人像库里永远没有上游预览图,只能靠这份自留地址显示。
   */
  thumbUrl?: string
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
  /**
   * 记住素材的本地缩略图地址。`assetIds` 通常同时带上游的行 id(`dla-…`)与
   * 真 assetId(`asset-…`):导入是异步的,返回那一刻往往只有行 id,而列表里
   * 两者都在 —— 两个键都存,页面按哪个查都命中。
   */
  | { op: 'setThumb'; assetIds: string[]; thumbUrl: string }

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
  /**
   * assetUrl 是否可用于创建任务的 `asset://` 引用。
   * 上游导入响应有时只回内部行 id(dla-xxx,不可引用,提交会 400
   * LOCAL_ASSET_NOT_FOUND)且 list 二次解析也可能找不到真 assetId——
   * 此时为 false,调用方应保留 https 直传而非替换成 asset:// 引用。
   * 主进程实现总会填;类型上可选是为了不破坏渲染层测试 mock。
   */
  referenceable?: boolean
}

// ==================== 官方素材库（文档 5） ====================
// GET /api/open/v1/official-materials —— 平台内置官方图片/视频/音频/虚拟人像。
// 只读列表,不写入开发者素材库;引用时直接用返回的 assetUrl（https）。

export interface SeedanceOfficialMaterialItem {
  id: string
  /** image / video / audio / virtual_portrait。 */
  kind: string
  name: string
  previewUrl?: string
  sourceUrl?: string
  /** 创建任务时直接作为素材 url（https,非 asset://）。 */
  assetUrl?: string
  assetId?: string | null
  mediaType?: string | null
  tab?: string | null
  category?: string | null
  description?: string | null
  gender?: string | null
  age?: number | null
  sourceKind?: string
}

export interface SeedanceOfficialMaterialsQuery {
  /** materials（普通官方素材,默认）或 avatars（虚拟人像）。 */
  library?: 'materials' | 'avatars'
  page?: number
  pageSize?: number
  q?: string
  kind?: string
  gender?: string
  country?: string
}

export interface SeedanceOfficialMaterialsResult {
  items: SeedanceOfficialMaterialItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
