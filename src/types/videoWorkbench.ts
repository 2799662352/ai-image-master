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
 *   → succeeded / failed（终态；failed 可重试回 preparing）。
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
