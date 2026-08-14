/**
 * `content[]` → 万相的素材槽。
 *
 * ## 为什么复用 content[]
 *
 * 素材的解析（本地文件读取、`asset://` 展开、COS 中转、万相专属的 `alwaysRelay`）
 * 全在 `buildContent` 里做完了。万相这条路再解析一遍就是第二份实现，两份必然
 * 各自漂移，而漂移的表现是「某类素材在这个模型下莫名其妙不生效」。
 *
 * `SeedanceContentItem` 的名字带 Seedance，但它实际上是我们内部「已解析素材」的
 * 通用表示：`role` 与万相的槽位一一对应。这里只做**搬运**，不做校验。
 *
 * ## 不在这里校验
 *
 * 非 https、超数量、模式互斥，一律留给 `buildWan3CreateBody` 那一层。在这里悄悄
 * 丢掉一条素材，用户会收到「首帧模式需要一张首帧图」这种驴唇不对马嘴的提示，
 * 而真实原因是那张图还是本地路径 —— 说人话的地方只能有一个。
 */

import type { VideoWorkbenchMode } from '../../../types/videoModes'
import type { SeedanceContentItem } from '../seedance/types'
import type { Wan3ResolvedMedia } from './request'

export function toWan3ResolvedMedia(content: readonly SeedanceContentItem[]): Wan3ResolvedMedia {
  let firstFrameUrl: string | undefined
  let lastFrameUrl: string | undefined
  const imageUrls: string[] = []
  const videoUrls: string[] = []
  const audioUrls: string[] = []

  for (const item of content) {
    switch (item.type) {
      case 'text':
        break
      case 'image_url':
        if (item.role === 'first_frame') firstFrameUrl = item.image_url.url
        else if (item.role === 'last_frame') lastFrameUrl = item.image_url.url
        // 无 role 按参考图 —— 与 Seedance 的默认语义一致。
        else imageUrls.push(item.image_url.url)
        break
      case 'video_url':
        videoUrls.push(item.video_url.url)
        break
      case 'audio_url':
        audioUrls.push(item.audio_url.url)
        break
    }
  }

  return {
    ...(firstFrameUrl ? { firstFrameUrl } : {}),
    ...(lastFrameUrl ? { lastFrameUrl } : {}),
    // 恒为数组:下游 buildWan3ReferenceMedia 直接读 .length。
    imageUrls,
    videoUrls,
    audioUrls,
  }
}

/**
 * 本次生成用哪个模式。
 *
 * 工作台一律显式带 `mode`，走第一行就返回。兜底反推只服务 **MCP agent 那条路**
 * （`generate_video` 工具没有模式概念，只有「给了哪些素材」）。
 *
 * 显式值绝不能被素材形状推翻：带参考视频的 `extend_video` 一旦被反推成
 * `multimodal_ref`，用户选的「延长视频」就变成了一次普通生成，而且不报任何错。
 */
export function resolveVideoMode(
  explicit: VideoWorkbenchMode | undefined,
  resolved: Wan3ResolvedMedia,
): VideoWorkbenchMode {
  if (explicit) return explicit
  // 只有尾帧没有首帧不算首尾帧：那样组包层会去抱怨尾帧，而真正缺的是首帧。
  if (resolved.firstFrameUrl) return resolved.lastFrameUrl ? 'first_last_frame' : 'first_frame'
  const hasRefs =
    (resolved.imageUrls?.length ?? 0) > 0 ||
    (resolved.videoUrls?.length ?? 0) > 0 ||
    (resolved.audioUrls?.length ?? 0) > 0 ||
    Boolean(resolved.lastFrameUrl)
  return hasRefs ? 'multimodal_ref' : 'text2video'
}
