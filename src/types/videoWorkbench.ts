// 「生成视频」工作台（卷轴式并发视频任务卡片）—— main / preload / renderer 三端共享类型。
//
// 架构约定（对齐音频页「共享核心」模式 + Seedance 现有链路）：
// - 卡片状态的单一真相源在渲染端 zustand store（useVideoWorkbenchStore），
//   IndexedDB 持久化草稿与结果元数据；
// - 生成走主进程既有 SeedanceTaskManager（video-workbench:submit IPC 复用
//   generate_video 的 buildContent / 人像库导入 / 提交 / 轮询 / 落盘链路），
//   进度经既有 `seedance:task-update` 广播回渲染端（source: 'workbench'）；
// - MCP 工具（video_workbench_*）经 agent:tool-request 路由到渲染端
//   AgentToolExecutor，直接操作同一个 zustand store —— 人与 AI 操作同一页面。

import type { SeedanceModelAlias, SeedancePersistence, SeedanceTaskStatus } from './seedance'

/**
 * 生成模式（移植自 soraui 旧工作台 VolcengineArkVideoMode）：
 * 文生视频 / 首帧 / 首尾帧 / 参考图 / 全能参考(多模态) / 编辑视频 / 延长视频。
 * 模式决定素材上限与提交时的 role 语义（首帧/尾帧 vs reference_*）。
 */
export type VideoWorkbenchMode =
  | 'text2video'
  | 'first_frame'
  | 'first_last_frame'
  | 'reference_images'
  | 'multimodal_ref'
  | 'edit_video'
  | 'extend_video'

/** 工作台卡片可编辑的视频规格（Seedance 支持的参数面）。 */
export interface VideoWorkbenchSpec {
  prompt: string
  model: SeedanceModelAlias
  resolution: '480p' | '720p' | '1080p'
  ratio: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  /** 视频时长（秒，4–15;-1 = 智能时长,模型自动决定,文档 8.1）。 */
  duration: number
  generateAudio: boolean
  /** 生成模式（缺省 multimodal_ref 全能参考,与旧卡片行为一致）。 */
  mode: VideoWorkbenchMode
  /** 随机种子（0–4294967295;undefined=随机）。仅 Seedance 2.0。 */
  seed?: number
  /** 联网搜索增强（上游 tools: [{type:'web_search'}]）。仅 Seedance 2.0。 */
  webSearch: boolean
  /** 参考图（≤9）：data: URL / 本地路径 / https / asset://。 */
  referenceImages: VideoWorkbenchMaterial[]
  /** 参考视频（≤3，总时长 ≤15s）。 */
  referenceVideos: VideoWorkbenchMaterial[]
  /** 参考音频（≤3，总时长 ≤15s）。 */
  referenceAudios: VideoWorkbenchMaterial[]
}

/** 参考素材条目（展示名 + 可提交源）。 */
export interface VideoWorkbenchMaterial {
  /** 展示名（文件名 / 素材名）。 */
  name: string
  /** 可提交上游的源：data: URL / 本地绝对路径 / https URL / asset://assetId。 */
  src: string
  /**
   * 展示用预览地址（asset:// 源无法直接渲染,人像库回填时带上游 previewUrl;
   * 其余源缺省用 src 本身展示）。
   */
  previewUrl?: string
}

/**
 * 卡片状态机：
 *   draft（可编辑）→ preparing（素材上送/创建任务中）→ queued/running（上游渲染）
 *   → succeeded / failed / cancelled（终态；failed 与 cancelled 都可重试回 preparing）。
 */
export type VideoWorkbenchCardStatus =
  | 'draft'
  | 'preparing'
  | SeedanceTaskStatus

/**
 * 工作台「页」(board / 工作区):每页一套独立的卡片集合,页签在顶部工具栏切换。
 * IndexedDB `boards` object store 持久化;老数据(无 boards)迁移进第一页。
 */
export interface VideoWorkbenchBoard {
  id: string
  name: string
  /** 页签排序(小在左)。 */
  order: number
  createdAt: number
}

/** 一张工作台任务卡片（渲染端真相源 + IndexedDB 持久化形状）。 */
export interface VideoWorkbenchCard extends VideoWorkbenchSpec {
  id: string
  /** 所属「页」id;老数据缺省,hydrate 时迁入第一页。 */
  boardId?: string
  /** 页内卷轴排序（小在上,按页独立计数）。 */
  order: number
  status: VideoWorkbenchCardStatus
  createdAt: number
  updatedAt: number
  /** 提交时渲染端生成，贯穿 seedance:task-update 广播做卡片对齐。 */
  clientId?: string
  /**
   * 本轮提交的开始时间。UI 的「已耗时」必须用它 —— 早先用 updatedAt 做起点，
   * 而每条进度广播都会 bump updatedAt，秒表因此每次广播归零。重新生成时重置。
   */
  startedAt?: number
  /**
   * 用户请求了取消，但 taskId 还没回来（preparing 阶段）。submit 一 resolve 就
   * 立刻对拿到的 taskId 发取消 —— 那一刻任务几乎必然还在 queued，属于能真省钱
   * 的窗口，所以这个意图值得记住而不是让用户白点一次。
   */
  cancelRequested?: boolean
  /** createTask 成功后的上游任务 id（可用 check_video_task 续轮询）。 */
  taskId?: string
  /** succeeded 时上游临时结果地址（有效期未知，兜底播放源）。 */
  videoUrl?: string
  /** 落盘后的本地 mp4 绝对路径（权威结果）。 */
  localPath?: string
  /** COS 永久 https URL（跨设备/清理后仍可播）。 */
  remoteUrl?: string
  persistence?: SeedancePersistence
  error?: string
  /** succeeded 时上游回传的实际种子（含随机 seed 的最终值,填回可复现）。 */
  actualSeed?: number
  /** succeeded 时上游回传的 usage.completion_tokens（计费口径）。 */
  completionTokens?: number
  /** 该任务的成功结果已写入「历史记录」(防重:重载/重复广播不再入库)。 */
  historyRecorded?: boolean
}

/** MCP / IPC 写入卡片时的字段集（全部可选，缺省用默认值）。 */
export interface VideoWorkbenchCardInput {
  prompt?: string
  model?: SeedanceModelAlias
  resolution?: '480p' | '720p' | '1080p'
  ratio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  duration?: number
  generateAudio?: boolean
  mode?: VideoWorkbenchMode
  /** 随机种子;传 null 表示清除（恢复随机）。 */
  seed?: number | null
  webSearch?: boolean
  /**
   * 字符串源（本地路径 / https / asset:// / data:，会包成 Material），
   * 或已解析好的 Material 对象（MCP 写入侧给 asset:// 引用带 previewUrl）。
   */
  referenceImages?: Array<string | VideoWorkbenchMaterial>
  referenceVideos?: Array<string | VideoWorkbenchMaterial>
  referenceAudios?: Array<string | VideoWorkbenchMaterial>
}

// ---------------------------------------------------------------------------
// 看板 JSON IR（声明式整体读写）
//
// 存在的理由:store 有 13 个用户可做的改动,细粒度 MCP 工具只接得出一部分,
// 而「把这三页重新编排一遍」这类请求逐卡调用既费轮次又没有可审阅的中间态。
// IR 让 agent 一次导出、离线想清楚、一次写回。
//
// 三条硬纪律,决定了下面每个字段的取舍:
//
// 1. **IR 只装意图,不装结果。** status/taskId/localPath/remoteUrl/actualSeed
//    这些是生成的产物,不是用户的编排意图。它们只作 `result` 只读注解随导出
//    带出(给 agent 看),apply 一律忽略 —— 否则 agent 一次回写就能把真实
//    任务状态改成幻觉值。
//
// 2. **`revision` 是乐观并发令牌,只跟意图变更走。** 这个工作台的卖点是人与
//    AI 改同一份 store,所以「agent 三十秒前读的看板」必然会过期。apply 必须
//    回带导出时的 revision,对不上就拒绝而不是覆盖。关键取舍:生成进度回流
//    (applyTaskUpdate)**不** bump revision —— 否则一个跑着的任务会让每次
//    apply 都撞冲突,这个功能就废了。
//
// 3. **数组下标就是 order。** 卡片 order 在库里是按页稠密的(reorderBoard
//    每次重排都压实成 0..n-1),所以 IR 里不需要 order 字段,`cards` 的数组
//    顺序即是页内卷轴顺序,`boards` 的数组顺序即是页签顺序。
// ---------------------------------------------------------------------------

/** 当前 IR 格式版本(不认识的版本 apply 直接拒绝,不做尽力而为的猜测)。 */
export const WORKBENCH_IR_VERSION = 1

/**
 * IR 里的参考素材。只有 name + src —— `previewUrl` 是 asset:// 素材的展示
 * 派生物,apply 时由人像库重新解析,不该让 agent 手搓也不该占导出体积。
 */
export interface WorkbenchIRMaterial {
  name: string
  /** data: URL / 本地绝对路径 / https URL / asset://assetId。 */
  src: string
}

/**
 * 卡片的生成结果,只读注解。导出时带上让 agent 知道哪张卡已经出片、哪张失败了;
 * apply 时整块忽略。
 */
export interface WorkbenchIRCardResult {
  status: VideoWorkbenchCardStatus
  taskId?: string
  error?: string
  localPath?: string
  remoteUrl?: string
}

/**
 * IR 里的一张卡:意图字段 + 身份。
 *
 * **规格字段全部可选,但语义是「声明」而不是「patch」** —— 省略某字段等于
 * 「该字段用默认值」,不是「沿用卡片原值」。所以改一张已有卡的正确做法是
 * export 拿到完整卡片、改想改的字段、原样带回其余字段;手搓一个只有
 * `{ id, prompt }` 的卡片会把它的分辨率/时长/参考图一起清成默认。
 *
 * 导出永远填满每个字段,round-trip 因此是安全的。
 */
export interface WorkbenchIRCard {
  /** 已有卡的 id。省略 = 新建一张。给了但库里没有 = 报错(而不是静默新建)。 */
  id?: string
  prompt?: string
  model?: SeedanceModelAlias
  resolution?: '480p' | '720p' | '1080p'
  ratio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  duration?: number
  generateAudio?: boolean
  mode?: VideoWorkbenchMode
  seed?: number
  webSearch?: boolean
  referenceImages?: WorkbenchIRMaterial[]
  referenceVideos?: WorkbenchIRMaterial[]
  referenceAudios?: WorkbenchIRMaterial[]
  /** 只读:导出时的生成结果,apply 忽略。 */
  result?: WorkbenchIRCardResult
}

/** IR 里的一页。数组顺序即页签顺序,`cards` 数组顺序即页内卷轴顺序。 */
export interface WorkbenchIRBoard {
  /** 已有页的 id。省略 = 新建一页。给了但库里没有 = 报错。 */
  id?: string
  name: string
  cards: WorkbenchIRCard[]
}

/** 整个工作台的声明式快照。 */
export interface WorkbenchIR {
  irVersion: number
  /** 导出时的意图版本号。apply 必须回带,用来发现丢失更新。 */
  revision: number
  /** 当前激活页(apply 时若能解析就切过去)。 */
  activeBoardId?: string
  boards: WorkbenchIRBoard[]
}

export interface WorkbenchApplyOptions {
  /**
   * `merge`(缺省):IR 里没提到的页和卡原样保留 —— 安全默认,agent 只改它
   * 关心的部分。`replace`:IR 未列出的页/卡删掉 —— 真正的「整体重排」,
   * 但会删用户的东西,所以要显式要。
   */
  mode?: 'merge' | 'replace'
  /** 跳过 revision 校验。明知会盖掉用户改动时的逃生门,默认不给。 */
  force?: boolean
}

/** 单项被跳过的原因(渲染中不可改规格、id 不存在等)。 */
export interface WorkbenchApplySkip {
  cardId?: string
  boardId?: string
  reason: string
}

export interface WorkbenchApplyResult {
  ok: boolean
  /** 版本冲突:agent 该重新导出再改。填了这个则什么都没写。 */
  conflict?: { expected: number; actual: number }
  boards: { created: string[]; renamed: string[]; removed: string[] }
  cards: {
    created: string[]
    updated: string[]
    /** 换了页或换了页内位置。 */
    moved: string[]
    removed: string[]
  }
  skipped: WorkbenchApplySkip[]
  /** apply 之后的新版本号(下一次 apply 该带这个)。 */
  revision: number
}

/** `video-workbench:submit` IPC 载荷（渲染端 → 主进程）。 */
export interface VideoWorkbenchSubmitPayload {
  /** 渲染端生成的 clientId，贯穿广播做卡片对齐。 */
  clientId: string
  prompt: string
  model: SeedanceModelAlias
  resolution: '480p' | '720p' | '1080p'
  ratio: string
  duration: number
  generateAudio: boolean
  /** 首帧图（图生视频/首尾帧模式,渲染端按 mode 从参考图拆出）。 */
  firstFrame?: string
  /** 尾帧图（首尾帧模式）。 */
  lastFrame?: string
  /** 随机种子（缺省=上游随机）。 */
  seed?: number
  /** 联网搜索增强。 */
  webSearch?: boolean
  referenceImages: string[]
  referenceVideos: string[]
  referenceAudios: string[]
}

/** `video-workbench:submit` 返回（成功 = 已创建上游任务，轮询在主进程后台跑）。 */
export type VideoWorkbenchSubmitResult =
  | { success: true; taskId: string }
  | { success: false; error: string }

/**
 * `video-workbench:reconcile` 单项载荷。重启后主进程任务表是空的，卡片把自己
 * 记住的 taskId 与重建任务状态所需的元数据送回去重新接管。
 */
export interface VideoWorkbenchReconcileItem {
  taskId: string
  clientId?: string
  prompt: string
  model: SeedanceModelAlias
  resolution: string
  ratio: string
  duration: number
  createdAt?: number
}

/**
 * 对账结果。`tracked` = 主进程仍在跟踪（没重启过，无需处理）；`adopted` = 已
 * 重新接管并恢复轮询；`unknown` = 上游查不到（过期/已删），卡片应落 failed。
 */
export interface VideoWorkbenchReconcileResult {
  taskId: string
  outcome: 'adopted' | 'tracked' | 'unknown'
  reason?: string
}
