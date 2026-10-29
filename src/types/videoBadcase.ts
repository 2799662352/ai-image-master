/**
 * 视频「效果问题反馈」(火山方舟 Case 平台,Seedance 2.x)的跨进程契约。
 *
 * 主进程(`main/services/videoBadcase`)发请求、解析网关回包,渲染层(工作台任务详情里的
 * 「效果反馈」面板)只认这里的形状。放在 `types/` 而不是某一侧,是因为这几样东西两边都要:
 * 问题类型枚举(主进程校验入参、渲染层出选项)、字数上限(同上)、IPC 回包的判别联合。
 *
 * 网关契约(new-api #188 / #189,网页版 sora-ui #300 / #301 已落地):
 *
 *   POST {base}/video/badcase/report   { task_id, feedback, badcase_type?, contact_info? }
 *   POST {base}/video/badcase/query    { task_id }
 *
 * `task_id` 是网关签发的公开任务号(`task_…`),不是上游的 `cgt-…`;网关自己校验任务归属并翻译。
 * 两个接口都不扣费,走虚拟模型 `seedance-badcase`(缺省,不用传)。
 */

import type { VideoBillingSource, VideoModelAlias } from './seedance'

/**
 * 火山 Case 平台允许的 BadcaseType(官方文档枚举,与 new-api `volcbadcase.BadcaseTypes`、
 * 网页版 `VIDEO_BADCASE_TYPE_OPTIONS` 同一份)。value 逐字相同,网关按它校验,写错一个字母就 400。
 */
export const VIDEO_BADCASE_TYPES = [
  { value: 'character_id_drift', label: '角色形象漂移' },
  { value: 'subtitle_generation_error', label: '字幕生成错误' },
  { value: 'logo_watermark_generated', label: '生成了 Logo / 水印' },
  { value: 'style_drift', label: '风格漂移' },
  { value: 'regular_flickering', label: '规律性闪烁' },
  { value: 'extended_video_joint_jump', label: '视频延长衔接跳变' },
  { value: 'duplicate_character_appearance', label: '角色重复出现' },
  { value: 'audio_end_noise', label: '音频结尾杂音' },
  { value: 'chinese_pronunciation_error', label: '中文发音错误' },
  { value: 'voice_tone_reference_error', label: '音色参考错误' },
  { value: 'other', label: '其他' },
] as const

export type VideoBadcaseType = (typeof VIDEO_BADCASE_TYPES)[number]['value']

export function isVideoBadcaseType(value: unknown): value is VideoBadcaseType {
  return typeof value === 'string' && VIDEO_BADCASE_TYPES.some((t) => t.value === value)
}

/** 网关按字符(rune)数卡,不是字节;超了直接 400。 */
export const VIDEO_BADCASE_FEEDBACK_MAX_CHARS = 5000
export const VIDEO_BADCASE_CONTACT_MAX_CHARS = 255

/**
 * 能走火山 Case 平台的模型:Seedance 2.x 全家。万相(阿里)、可灵(腾讯 VOD)的任务网关会回
 * 「不是火山 Seedance 任务」,所以入口干脆不给。
 *
 * 显式列出而不是靠能力表的 `provider`:`provider` 说的是请求组包形状(vvdance / miau),
 * 不等于「上游是火山」;将来新增的 vvdance 模型是不是火山 2.x 要人看过再放进来。
 */
export const VIDEO_BADCASE_MODELS: readonly VideoModelAlias[] = ['2.0', '2.0-fast', '2.0-mini', '2.5']

/** 网关签发的公开任务号前缀。自填 Key 直连时 taskId 是供应商那边的 `cgt-…`,网关不认。 */
const GATEWAY_TASK_ID_PREFIX = 'task_'

export interface VideoBadcaseEligibilityInput {
  /** 这一轮任务的状态。历史版本只在生成成功那一刻存档,调用方传 `'succeeded'`。 */
  status: string
  /** 计费来源。历史版本没存,传 `undefined`:靠任务号前缀判断。 */
  billing?: VideoBillingSource
  model: VideoModelAlias
  taskId?: string
}

/**
 * 这一轮任务要不要给「效果反馈」入口。
 *
 * 只是「尽量不展示一定会被拒的入口」的乐观判断,最终以网关受理为准(与网页版
 * `canReportVolcBadcaseV1` 同一口径):
 *   - 只有已完成的任务(没出片谈不上效果问题);
 *   - 只有 Seedance 2.x;
 *   - 只有走网关的任务 —— 自填 Key 直连的任务号不是 `task_…`,且那条路根本没经过我们的网关,
 *     上报进不了 Case 平台账号;`billing` 明确是 `own-key` 直接拒,没记录(旧卡 / 历史版本)
 *     就看任务号是不是网关签发的形状。
 */
export function canReportVideoBadcase(input: VideoBadcaseEligibilityInput): boolean {
  if (input.status !== 'succeeded') return false
  if (input.billing === 'own-key') return false
  if (!VIDEO_BADCASE_MODELS.includes(input.model)) return false
  const taskId = (input.taskId ?? '').trim()
  return taskId.startsWith(GATEWAY_TASK_ID_PREFIX) && taskId.length > GATEWAY_TASK_ID_PREFIX.length
}

// ---------------------------------------------------------------------------
// IPC 回包

export interface VideoBadcaseAttachment {
  type: string
  /** 只收 https —— 来自上游的链接要渲染成可点的 <a>,`javascript:` / `http:` 一律丢。 */
  url: string
  mimeType: string
  name: string
}

export interface VideoBadcaseRecord {
  badcaseTypes: string[]
  feedback: string
  problemLabel: string
  /** `processing` = 处理中;`done` = 已处理。其余值原样给,面板按中性色显示。 */
  status: string
  submitTime: string
  /** 只有上游给了处理方案才有;`null` = 暂无。 */
  solution: { text: string; attachments: VideoBadcaseAttachment[] } | null
}

/** Case 平台 / 网关对单个任务的拒绝。`code` 40002 = 任务不存在或不属于当前账号。 */
export interface VideoBadcaseRejection {
  code: number
  message: string
}

export type VideoBadcaseErrorCode =
  /** 没有平台凭据(没登录 / 没选计费池)。 */
  | 'PLATFORM_NOT_READY'
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  /** 网关没给这个账号开 `seedance-badcase`(缺 VolcBadcase 渠道,或令牌白名单拦了)。 */
  | 'CHANNEL_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'NETWORK'
  | 'BAD_RESPONSE'

/** 整个请求没成(没到「受理 / 拒绝」那一层)。`message` 已经是给人看的中文。 */
export interface VideoBadcaseFailure {
  ok: false
  code: VideoBadcaseErrorCode
  message: string
}

export interface VideoBadcaseReportInput {
  taskId: string
  feedback: string
  badcaseTypes: string[]
  contactInfo?: string
}

export type VideoBadcaseReportResult =
  | { ok: true; outcome: 'accepted'; caseId: string | null }
  | { ok: true; outcome: 'rejected'; rejection: VideoBadcaseRejection }
  | VideoBadcaseFailure

export type VideoBadcaseQueryResult =
  /** `record: null` = 这个任务还没有反馈记录(`rejection` 是网关 / 上游给的原因,可为空)。 */
  | { ok: true; record: VideoBadcaseRecord | null; rejection: VideoBadcaseRejection | null }
  | VideoBadcaseFailure
