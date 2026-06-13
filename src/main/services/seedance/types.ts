// Seedance（火山方舟 Ark 任务协议）视频生成 —— 主进程侧类型。
// 三端共享的任务状态类型在 src/types/seedance.ts，这里 re-export 并补充
// 仅主进程需要的请求体/输入类型。
// 上游文档：seedance-openapi-ark-2026-06-12.md；设计稿：
// docs/superpowers/specs/2026-06-12-seedance-video-mcp-design.md

import type { SeedanceModelAlias } from '../../../types/seedance'

export type {
  SeedanceTaskStatus,
  SeedancePersistence,
  SeedanceModelAlias,
  SeedanceTaskState,
  SeedanceTaskUpdate,
  SeedanceKeyState,
} from '../../../types/seedance'

export const SEEDANCE_MODEL_IDS: Record<SeedanceModelAlias, string> = {
  '2.0': 'doubao-seedance-2-0-260128',
  '2.0-fast': 'doubao-seedance-2-0-fast-260128',
}

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
  /** @deprecated 单数别名，buildContent 会并入 referenceVideos。 */
  referenceVideo?: string
  /** @deprecated 单数别名，buildContent 会并入 referenceAudios。 */
  referenceAudio?: string
}
