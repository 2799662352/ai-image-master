// 「生成视频」工作台 —— 生成模式能力矩阵。
//
// 移植自 soraui 旧工作台 `VOLCENGINE_ARK_VIDEO_MODES`（types/index.ts）:
// 每个模式限定三类素材的数量上限,提交时由 store 按模式把参考图拆成
// first_frame / last_frame 或保持 reference_image role(主进程 buildContent
// 只认 firstFrame/lastFrame/referenceImages 字段,role 由它派生)。
//
// 上限有两个来源，别混为一谈：
//   - **模式语义**：首帧就是 1 张、首尾帧就是 2 张。换什么模型都不变。
//   - **模型能力**：「参考图 / 全能参考 / 编辑 / 延长」要的是「这个模型收几份」，
//     2.0 家族 9/3/3、2.5 是 30/10/10。这类写 `'model'`，运行时按卡片模型解析。
//
// 历史上这两者被拍平成同一列数字（全填 2.0 的 9/3/3），于是 2.5 接进来之后
// UI 仍然只肯收 9 张 —— 能力表改了，界面没跟上。用 `'model'` 哨兵把「跟模型走」
// 这件事写进类型里，下次再加档位就不会漏。

import type { SeedanceModelAlias } from '../../../../types/seedance'
import { capabilitiesFor } from '../../../../types/seedance'
import type { VideoWorkbenchMode } from '../../../../types/videoWorkbench'

/** 固定条数 = 模式语义写死；`'model'` = 跟随卡片模型的能力表。 */
export type ModeCap = number | 'model'

export interface WorkbenchModeSpec {
  value: VideoWorkbenchMode
  label: string
  description: string
  /** 参考图上限（首帧/首尾帧模式的图也算在内）。 */
  maxImages: ModeCap
  maxVideos: ModeCap
  maxAudios: ModeCap
}

export const WORKBENCH_MODES: readonly WorkbenchModeSpec[] = [
  { value: 'text2video', label: '文生视频', description: '纯文本描述生成视频,不携带任何素材', maxImages: 0, maxVideos: 0, maxAudios: 0 },
  { value: 'first_frame', label: '首帧', description: '以一张图为视频首帧(图生视频)', maxImages: 1, maxVideos: 0, maxAudios: 0 },
  { value: 'first_last_frame', label: '首尾帧', description: '指定首帧与尾帧,生成中间过渡', maxImages: 2, maxVideos: 0, maxAudios: 0 },
  { value: 'reference_images', label: '参考图', description: '多张参考图控制人物/风格一致性(张数上限跟随所选模型)', maxImages: 'model', maxVideos: 0, maxAudios: 0 },
  { value: 'multimodal_ref', label: '全能参考', description: '图 + 视频 + 音频多模态参考(推荐;各类上限跟随所选模型)', maxImages: 'model', maxVideos: 'model', maxAudios: 'model' },
  { value: 'edit_video', label: '编辑视频', description: '基于参考视频做内容编辑,可配合图/音频', maxImages: 'model', maxVideos: 'model', maxAudios: 'model' },
  { value: 'extend_video', label: '延长视频', description: '把已有视频向后延长(仅视频素材)', maxImages: 0, maxVideos: 'model', maxAudios: 0 },
] as const

export const MODE_LABELS: Record<VideoWorkbenchMode, string> = Object.fromEntries(
  WORKBENCH_MODES.map((m) => [m.value, m.label]),
) as Record<VideoWorkbenchMode, string>

export function getModeSpec(mode: VideoWorkbenchMode): WorkbenchModeSpec {
  return WORKBENCH_MODES.find((m) => m.value === mode) ?? WORKBENCH_MODES[4]
}

/**
 * 该模式 + 该模型下某类素材的数量上限（0 = 该类素材不可用）。
 *
 * `model` 省略时按 `'2.0'` 解析，与接 2.5 之前的行为一致 —— 调用方漏传不会
 * 悄悄放宽上限，只会退回保守值。
 */
export function modeLimit(
  mode: VideoWorkbenchMode,
  kind: 'image' | 'video' | 'audio',
  model: SeedanceModelAlias = '2.0',
): number {
  const spec = getModeSpec(mode)
  const cap = kind === 'image' ? spec.maxImages : kind === 'video' ? spec.maxVideos : spec.maxAudios
  if (cap !== 'model') return cap
  const caps = capabilitiesFor(model)
  return kind === 'image' ? caps.maxImages : kind === 'video' ? caps.maxVideos : caps.maxAudios
}
