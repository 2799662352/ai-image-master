// 「生成视频」工作台 —— 生成模式能力矩阵。
//
// 移植自 soraui 旧工作台 `VOLCENGINE_ARK_VIDEO_MODES`（types/index.ts）:
// 每个模式限定三类素材的数量上限,提交时由 store 按模式把参考图拆成
// first_frame / last_frame 或保持 reference_image role(主进程 buildContent
// 只认 firstFrame/lastFrame/referenceImages 字段,role 由它派生)。

import type { VideoWorkbenchMode } from '../../../../types/videoWorkbench'

export interface WorkbenchModeSpec {
  value: VideoWorkbenchMode
  label: string
  description: string
  /** 参考图上限（首帧/首尾帧模式的图也算在内）。 */
  maxImages: number
  maxVideos: number
  maxAudios: number
}

export const WORKBENCH_MODES: readonly WorkbenchModeSpec[] = [
  { value: 'text2video', label: '文生视频', description: '纯文本描述生成视频,不携带任何素材', maxImages: 0, maxVideos: 0, maxAudios: 0 },
  { value: 'first_frame', label: '首帧', description: '以一张图为视频首帧(图生视频)', maxImages: 1, maxVideos: 0, maxAudios: 0 },
  { value: 'first_last_frame', label: '首尾帧', description: '指定首帧与尾帧,生成中间过渡', maxImages: 2, maxVideos: 0, maxAudios: 0 },
  { value: 'reference_images', label: '参考图', description: '最多 9 张参考图控制人物/风格一致性', maxImages: 9, maxVideos: 0, maxAudios: 0 },
  { value: 'multimodal_ref', label: '全能参考', description: '图 ≤9 + 视频 ≤3 + 音频 ≤3 多模态参考(推荐)', maxImages: 9, maxVideos: 3, maxAudios: 3 },
  { value: 'edit_video', label: '编辑视频', description: '基于参考视频做内容编辑,可配合图/音频', maxImages: 9, maxVideos: 3, maxAudios: 3 },
  { value: 'extend_video', label: '延长视频', description: '把已有视频向后延长(仅视频素材)', maxImages: 0, maxVideos: 3, maxAudios: 0 },
] as const

export const MODE_LABELS: Record<VideoWorkbenchMode, string> = Object.fromEntries(
  WORKBENCH_MODES.map((m) => [m.value, m.label]),
) as Record<VideoWorkbenchMode, string>

export function getModeSpec(mode: VideoWorkbenchMode): WorkbenchModeSpec {
  return WORKBENCH_MODES.find((m) => m.value === mode) ?? WORKBENCH_MODES[4]
}

/** 该模式下某类素材的数量上限（0 = 该类素材不可用）。 */
export function modeLimit(mode: VideoWorkbenchMode, kind: 'image' | 'video' | 'audio'): number {
  const spec = getModeSpec(mode)
  return kind === 'image' ? spec.maxImages : kind === 'video' ? spec.maxVideos : spec.maxAudios
}
