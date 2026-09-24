// Seedance 2.5 Draft 样片模式 · 工作台规则(与 sora-ui `utils/seedanceDraft.ts` 同口径)。
//
// 样片:480p 预览,按普通 480p 计费;满意后在卡上「生成 1080P 成片」—— 方舟沿用样片的
// 提示词、参考素材、seed、比例、时长与音频开关,只能出 1080p。样片从创建起 7 天内有效。
// 桌面端只在平台余额(经网关)开放,见 types/seedance 的 supportsSeedanceDraft。

import {
  SEEDANCE_DRAFT_FINAL_RESOLUTION,
  SEEDANCE_DRAFT_RESOLUTION,
  seedanceDraftExpired,
  supportsSeedanceDraft,
} from '../../../../types/seedance'
import type { VideoBillingSource } from '../../../../types/seedance'
import type { VideoWorkbenchCard, VideoWorkbenchSpec } from '../../../../types/videoWorkbench'

/** 这张卡这次提交会不会出样片:开关开着 + 模型是 2.5。换到别的模型时开关保留但不生效。 */
export function effectiveDraft(spec: Pick<VideoWorkbenchSpec, 'draft' | 'model'>): boolean {
  return spec.draft === true && supportsSeedanceDraft(spec.model)
}

/** 实际发给上游的分辨率:样片固定 480p,其余照卡片设置。 */
export function submitResolution(
  spec: Pick<VideoWorkbenchSpec, 'draft' | 'model' | 'resolution'>,
): VideoWorkbenchSpec['resolution'] {
  return effectiveDraft(spec) ? SEEDANCE_DRAFT_RESOLUTION : spec.resolution
}

/**
 * 这一轮**实际出片**的分辨率(计费估算 / 展示用):样片 480p、成片 1080p,其余照卡片设置。
 * 与 submitResolution 的区别:这里看的是已经提交的那一轮,不是开关现在的状态。
 */
export function runResolution(
  card: Pick<VideoWorkbenchCard, 'draftRun' | 'fromDraftTaskId' | 'resolution'>,
): VideoWorkbenchSpec['resolution'] {
  if (card.fromDraftTaskId) return SEEDANCE_DRAFT_FINAL_RESOLUTION
  if (card.draftRun) return SEEDANCE_DRAFT_RESOLUTION
  return card.resolution
}

/** 样片模式能不能打开;不能时给出原因(开关置灰 + 提示)。 */
export function draftToggleAvailability(
  model: VideoWorkbenchSpec['model'],
  billing: VideoBillingSource,
): { available: boolean; reason?: string } {
  if (!supportsSeedanceDraft(model)) return { available: false, reason: '样片模式只有 Seedance 2.5 支持' }
  if (billing !== 'platform') return { available: false, reason: '样片模式只在平台余额下可用' }
  return { available: true }
}

export type DraftFinalAvailability =
  | { show: false }
  | { show: true; enabled: true }
  | { show: true; enabled: false; reason: string }

/**
 * 卡上「生成 1080P 成片」按钮:只在这一轮是**成功的样片**时出现;超过 7 天或当前
 * 不是平台余额时置灰并说明原因(网关只认同一账号、同一计费池里生成的样片)。
 */
export function draftFinalAvailability(
  card: Pick<VideoWorkbenchCard, 'draftRun' | 'status' | 'taskId' | 'startedAt'>,
  billing: VideoBillingSource,
  now: number = Date.now(),
): DraftFinalAvailability {
  if (!card.draftRun || card.status !== 'succeeded' || !card.taskId) return { show: false }
  if (seedanceDraftExpired(card.startedAt, now)) {
    return { show: true, enabled: false, reason: '样片已超过 7 天有效期,请重新生成样片' }
  }
  if (billing !== 'platform') {
    return { show: true, enabled: false, reason: '成片只在平台余额下可用,请切回生成样片时用的计费池' }
  }
  return { show: true, enabled: true }
}
