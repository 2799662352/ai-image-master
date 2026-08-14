// Seedance（火山方舟 Ark 任务协议）视频生成 —— 主进程侧类型。
// 三端共享的任务状态类型在 src/types/seedance.ts，这里 re-export 并补充
// 仅主进程需要的请求体/输入类型。
// 上游文档：seedance-openapi-ark-2026-06-12.md；设计稿：
// docs/superpowers/specs/2026-06-12-seedance-video-mcp-design.md

import type { SeedanceModelAlias, SeedanceTaskMode } from '../../../types/seedance'
import type { VideoWorkbenchMode } from '../../../types/videoModes'
import { SEEDANCE_MODEL_IDS_BY_REGION } from './region'

export type {
  SeedanceTaskStatus,
  SeedancePersistence,
  SeedanceModelAlias,
  SeedanceModelCapabilities,
  SeedanceRegion,
  SeedanceTaskMode,
  SeedanceTaskState,
  SeedanceTaskUpdate,
  SeedanceKeyState,
  SeedanceCancelResult,
} from '../../../types/seedance'

export {
  SEEDANCE_MODEL_CAPABILITIES,
  capabilitiesFor,
  validateSeedanceRequest,
} from '../../../types/seedance'

export {
  getSeedanceRegion,
  isSeedanceModelAvailable,
  listSeedanceModelAliases,
  resolveSeedanceModelId,
  SEEDANCE_CN_2_5_ENABLED,
  SEEDANCE_MODEL_IDS_BY_REGION,
} from './region'

/**
 * 默认（海外 GLOBAL）上游模型 ID。提交任务请用 `resolveSeedanceModelId(alias)`，
 * 以跟随设置页当前 region（cn → doubao-*）。
 */
export const SEEDANCE_MODEL_IDS: Record<SeedanceModelAlias, string> =
  SEEDANCE_MODEL_IDS_BY_REGION.global

/** 创建任务的 content[] 条目（仅建模我们会发出的形态）。 */
export type SeedanceContentItem =
  | { type: 'text'; text: string }
  | {
      type: 'image_url'
      role?: 'first_frame' | 'last_frame' | 'reference_image'
      image_url: { url: string }
      /** 引用素材库（人像库）条目时同时携带（文档 4.2.3 推荐写法）。 */
      assetId?: string
    }
  | { type: 'video_url'; role?: 'reference_video'; video_url: { url: string }; assetId?: string }
  | { type: 'audio_url'; role?: 'reference_audio'; audio_url: { url: string }; assetId?: string }

/** 发给上游创建接口的请求体。 */
export interface SeedanceCreateTaskBody {
  model: string
  content: SeedanceContentItem[]
  ratio: string
  resolution: string
  duration: number
  generate_audio: boolean
  /** 随机种子（soraui relay 同款字段;缺省=上游随机）。 */
  seed?: number
  /** 联网搜索增强（Seedance 2.0;soraui relay: webSearch → tools）。 */
  tools?: Array<{ type: 'web_search' }>
  /**
   * 编辑 / 延长已有视频（仅 Seedance 2.5，文档 4.9）。缺省时字段完全不出现
   * —— 2.0 家族的上游不认这个键。
   */
  taskMode?: SeedanceTaskMode
}

/** generate_video main handler 的入参（videoTools zod 校验后的形状）。 */
export interface CreateVideoTaskInput {
  prompt: string
  model?: SeedanceModelAlias
  resolution?: '480p' | '720p' | '1080p'
  ratio?: string
  duration?: number
  generateAudio?: boolean
  firstFrame?: string
  lastFrame?: string
  /** 全能参考模式：最多 9 张参考图（人物/风格一致性）。 */
  referenceImages?: string[]
  /** 全能参考模式：最多 3 段参考视频（运动/风格），总时长 ≤15s。 */
  referenceVideos?: string[]
  /** 全能参考模式：最多 3 段参考音频（对口型/音色），总时长 ≤15s。 */
  referenceAudios?: string[]
  /**
   * 编辑 / 延长已有视频（仅 2.5）。上游会强制 `adaptive` 比例并要求带视频参考，
   * `edit` 另外锁死 `duration: -1` —— 这些都在提交前由 validateSeedanceRequest 兜住。
   */
  taskMode?: SeedanceTaskMode
  /**
   * 卡片的原始模式（万相组包要用；Seedance 那条路已被摊平成 firstFrame/reference*）。
   * 缺省时由 `resolveVideoMode` 从素材形状兜底反推 —— 那是给 MCP agent 那条没有
   * 模式概念的路留的，工作台一律显式带。
   */
  mode?: VideoWorkbenchMode
  /** @deprecated 单数别名，buildContent 会并入 referenceVideos。 */
  referenceVideo?: string
  /** @deprecated 单数别名，buildContent 会并入 referenceAudios。 */
  referenceAudio?: string
  /** 随机种子（0–4294967295;缺省=上游随机）。 */
  seed?: number
  /** 联网搜索增强（上游 tools: [{type:'web_search'}]）。 */
  webSearch?: boolean
}
