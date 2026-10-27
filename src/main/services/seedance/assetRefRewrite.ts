/**
 * 提交前「直传 URL → asset://」改写的纯函数部分。
 *
 * 上游对**直传**的 https 图片 / 视频都做真人检测(`InputImageSensitiveContentDetected` /
 * `InputVideoSensitiveContentDetected.PrivacyInformation`),整次生成直接被拒;而登记进
 * 素材库(人像库)后的 `asset://` 引用不走这道检测 —— 图片一侧 2026-08-31 已实测。
 * 视频原先漏在外面:`materializeAssetRefs` 只挑 `image_url`,用户上传的参考视频照样
 * 裸 URL 直传,于是同一张脸在图里能过、在视频里就 400(2026-09-22 用户在视频工作台撞到)。
 *
 * 这里把「挑哪些项去登记」和「登记完怎么回填」抽成不依赖 electron 的纯函数,
 * 两条库分支(vvdance 素材库 / 平台库)共用,也好单测。
 *
 * 音频也收(用户 2026-09-22 拍板「音频也一并加入」):真人检测不针对音频,这一项不是为了
 * 过审,而是让三种参考素材走同一条路 —— 登记后成为可复用的 `asset://` 锚点(同一段 BGM /
 * 配音跨镜复用不必再传),提交侧也只剩一种引用形态。音频被拒的那类错误是版权
 * (`input_copyright`),入库救不了,这一点不变。
 */
import type { SeedanceContentItem } from './types'

export type DirectMediaKind = 'image' | 'video' | 'audio'

export interface DirectMediaRef {
  kind: DirectMediaKind
  /** 原始 URL(https 或 data:),也是回填时的查找键。 */
  url: string
  role?: string
}

const isAssetRef = (url: string): boolean => url.startsWith('asset://')

/** content 里还没变成 `asset://` 的图片 / 视频 / 音频项,按出现顺序、同 URL 去重。 */
export function collectDirectMediaRefs(content: readonly SeedanceContentItem[]): DirectMediaRef[] {
  const out: DirectMediaRef[] = []
  const seen = new Set<string>()
  for (const item of content) {
    let ref: DirectMediaRef | null = null
    if (item.type === 'image_url' && !isAssetRef(item.image_url.url)) {
      ref = { kind: 'image', url: item.image_url.url, ...(item.role ? { role: item.role } : {}) }
    } else if (item.type === 'video_url' && !isAssetRef(item.video_url.url)) {
      ref = { kind: 'video', url: item.video_url.url, ...(item.role ? { role: item.role } : {}) }
    } else if (item.type === 'audio_url' && !isAssetRef(item.audio_url.url)) {
      ref = { kind: 'audio', url: item.audio_url.url, ...(item.role ? { role: item.role } : {}) }
    }
    if (!ref || seen.has(ref.url)) continue
    seen.add(ref.url)
    out.push(ref)
  }
  return out
}

/**
 * 逐项回填,**保持数组顺序**:上游按 content[] 的下标解析提示词里的「图片1 / 视频1 /
 * 音频1」,顺序一乱,生成的内容就跟用户想的不是一回事,而且不报任何错。没登记上的项原样保留。
 */
export function applyAssetRewrites(
  content: readonly SeedanceContentItem[],
  rewrites: ReadonlyMap<string, string>,
): SeedanceContentItem[] {
  if (rewrites.size === 0) return [...content]
  return content.map((item) => {
    if (item.type === 'image_url') {
      const ref = rewrites.get(item.image_url.url)
      return ref ? { ...item, image_url: { ...item.image_url, url: ref } } : item
    }
    if (item.type === 'video_url') {
      const ref = rewrites.get(item.video_url.url)
      return ref ? { ...item, video_url: { ...item.video_url, url: ref } } : item
    }
    if (item.type === 'audio_url') {
      const ref = rewrites.get(item.audio_url.url)
      return ref ? { ...item, audio_url: { ...item.audio_url, url: ref } } : item
    }
    return item
  })
}

const DEFAULT_ROLE: Readonly<Record<DirectMediaKind, string>> = {
  image: 'reference_image',
  video: 'reference_video',
  audio: 'reference_audio',
}

/** 素材库里的展示名:沿用图片一侧的 `视频参考-<role>-<ts>` 约定,视频 / 音频用同一套。 */
export function libraryAssetName(ref: DirectMediaRef): string {
  return `视频参考-${ref.role ?? DEFAULT_ROLE[ref.kind]}-${Date.now()}`
}
