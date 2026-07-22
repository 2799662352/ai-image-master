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

/** 工作台卡片可编辑的视频规格（Seedance 支持的参数面）。 */
export interface VideoWorkbenchSpec {
  prompt: string
  model: SeedanceModelAlias
  resolution: '480p' | '720p' | '1080p'
  ratio: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  /** 视频时长（秒，4–15）。 */
  duration: number
  generateAudio: boolean
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

/** 一张工作台任务卡片（渲染端真相源 + IndexedDB 持久化形状）。 */
export interface VideoWorkbenchCard extends VideoWorkbenchSpec {
  id: string
  /** 卷轴内排序（小在上）。 */
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
}

/** MCP / IPC 写入卡片时的字段集（全部可选，缺省用默认值）。 */
export interface VideoWorkbenchCardInput {
  prompt?: string
  model?: SeedanceModelAlias
  resolution?: '480p' | '720p' | '1080p'
  ratio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  duration?: number
  generateAudio?: boolean
  /** 字符串源（本地路径 / https / asset:// / data:），会包成 Material。 */
  referenceImages?: string[]
  referenceVideos?: string[]
  referenceAudios?: string[]
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
  referenceImages: string[]
  referenceVideos: string[]
  referenceAudios: string[]
}

/** `video-workbench:submit` 返回（成功 = 已创建上游任务，轮询在主进程后台跑）。 */
export type VideoWorkbenchSubmitResult =
  | { success: true; taskId: string }
  | { success: false; error: string }
