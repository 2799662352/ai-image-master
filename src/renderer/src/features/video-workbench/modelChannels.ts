// 视频工作台「渠道 → 模型」两级选择器的数据:叫法、分组、每个模型的一行说明。
//
// 全是纯函数,不碰 React / store —— 选择器(VideoModelPicker)只负责画,这里负责「画什么」。
// 分组与说明都从能力表(`types/seedance`)现算:加一个模型只要在能力表里登记渠道,
// 它就会出现在对应的那一栏,这里不用再手写一份清单。

import type { SeedanceModelAlias, VideoBillingSource, VideoModelChannel } from '../../../../types/seedance'
import {
  VIDEO_MODEL_CHANNELS,
  capabilitiesFor,
  resolutionsFor,
  videoModelChannelLabel,
} from '../../../../types/seedance'

/**
 * 模型的完整叫法(选择器按钮、4K 确认框等**离开了渠道上下文**的地方用)。
 *
 * 火山方舟的几档保持原来的叫法不带渠道名 —— 它们是老卡片上一直显示的字,改了反而像换了模型。
 * 第二条渠道上的同名模型带上渠道名,否则「Seedance 2.0 满血」在界面上有两个、分不清。
 */
export const MODEL_LABELS: Record<SeedanceModelAlias, string> = {
  '2.5': 'Seedance 2.5',
  '2.5-flash': 'Seedance 2.5 Flash',
  '2.0': 'Seedance 2.0 满血',
  '2.0-fast': 'Seedance 2.0 Fast',
  '2.0-mini': 'Seedance 2.0 Mini(最省)',
  'cn-seedance-2.5': 'Seedance 2.5 · Roneyun-cn',
  'cn-seedance-2.0': 'Seedance 2.0 满血 · Roneyun-cn',
  'cn-seedance-2.0-fast': 'Seedance 2.0 Fast · Roneyun-cn',
  'cn-seedance-2.0-mini': 'Seedance 2.0 Mini(最省) · Roneyun-cn',
  wan3: '万相 3.0',
  'wan3-prime': '万相 3.0 Prime',
  // 可灵走腾讯云 VOD,经 Miau 网关(渠道类型 76):4.0 文生 / 首帧 / 首尾帧,Omni 多参考图 + 参考视频。
  kling4: '可灵 4.0',
  'kling4-omni': '可灵 4.0 Omni',
  // 深度捕捉没有工作台模式,不会出现在选择器里;这里只为穷尽性(编译期保证新别名不漏标签)。
  depth: '深度捕捉',
}

/** 认不出的别名(旧存档 / 手改的数据)原样显示别名,不显示成空白。 */
export function modelLabel(alias: SeedanceModelAlias): string {
  return MODEL_LABELS[alias] ?? String(alias)
}

/**
 * 选择器右栏里的叫法:渠道已经写在左栏和标题上了,行里不再重复一遍。
 * 只去掉**结尾**恰好是本渠道名的那一段,别的一个字不动。
 */
export function modelNameInChannel(alias: SeedanceModelAlias): string {
  const full = modelLabel(alias)
  const channelLabel = videoModelChannelLabel(alias)
  const suffix = channelLabel ? ` · ${channelLabel}` : ''
  return suffix && full.endsWith(suffix) ? full.slice(0, -suffix.length) : full
}

export interface VideoModelChannelGroup {
  id: VideoModelChannel
  label: string
  caption: string
  models: SeedanceModelAlias[]
}

/**
 * 把可选模型按渠道分组。
 *
 * - 渠道顺序 = `VIDEO_MODEL_CHANNELS` 的顺序;组内顺序 = 传入的顺序(即能力表键序)。
 * - 一个模型都没有的渠道不出现(不画空栏)。
 * - 渠道不在选择器清单里的模型(`other`,如深度捕捉)不出现 —— 它本来也不在可选模型里。
 */
export function groupModelsByChannel(models: readonly SeedanceModelAlias[]): VideoModelChannelGroup[] {
  const groups: VideoModelChannelGroup[] = []
  for (const channel of VIDEO_MODEL_CHANNELS) {
    const members = models.filter((alias) => capabilitiesFor(alias)?.channel === channel.id)
    if (members.length > 0) groups.push({ ...channel, models: members })
  }
  return groups
}

/** 当前模型在哪个渠道分组里;不在任何分组(旧存档里的别名)返回 null。 */
export function channelGroupOf(
  groups: readonly VideoModelChannelGroup[],
  alias: SeedanceModelAlias,
): VideoModelChannelGroup | null {
  return groups.find((group) => group.models.includes(alias)) ?? null
}

/**
 * 选择器里每个模型下面那一行小字:时长区间、最高分辨率、素材上限、几个要紧的差异。
 *
 * 全部读能力表 —— 手写的说明会在能力表改了之后继续说旧话。分辨率按**当前计费来源**算
 * (2.5 的 1080p / 4k 只有平台余额有),和卡片上分辨率下拉看到的是同一份。
 */
export function modelHint(alias: SeedanceModelAlias, billing: VideoBillingSource): string {
  const caps = capabilitiesFor(alias)
  if (!caps) return ''
  const resolutions = resolutionsFor(alias, billing)
  const top = resolutions[resolutions.length - 1]
  const parts: string[] = [`${caps.duration.min}–${caps.duration.max} 秒`]
  if (top) parts.push(`最高 ${top}`)
  // 「参考素材」只对开了参考模式的模型成立:可灵 4.0 的 `maxImages: 2` 是首帧 + 尾帧的名额,
  // 说成「参考 2 图」是错的。
  const takesReferences = caps.modes.includes('reference_images') || caps.modes.includes('multimodal_ref')
  if (takesReferences) {
    const materials = [
      caps.maxImages > 0 ? `${caps.maxImages} 图` : '',
      caps.maxVideos > 0 ? `${caps.maxVideos} 视频` : '',
      caps.maxAudios > 0 ? `${caps.maxAudios} 音频` : '',
    ].filter(Boolean)
    if (materials.length > 0) parts.push(`参考 ${materials.join(' / ')}`)
  } else {
    parts.push('只收首帧 / 尾帧')
  }
  if (caps.taskModes.length > 0) parts.push('可编辑 / 延长')
  if (caps.draft) parts.push('样片')
  if (caps.multiShot) parts.push('分镜')
  if (caps.documentSlot) parts.push('文档 / 链接')
  return parts.join(' · ')
}
