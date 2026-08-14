/**
 * 万相 3.0（`wan3.0-video`）的请求组包 —— provider 分派的四处之一。
 *
 * 上游是 DashScope 的 video-synthesis，经 Miau 网关（`/v1/video/generations`）。
 * 与 Seedance 那条 Ark 风格的 `content[]` 完全不同：媒体走 `metadata.input.media[]`，
 * 参数走 `metadata.parameters`。
 *
 * ## 与参考实现的两处刻意不同
 *
 * 1. **不复制能力上限。** 参考实现里另有一份 `WAN3_CAPS = { maxImages: 10, ... }`；
 *    我们直接读 `capabilitiesFor('wan3')`。同一个数字写两遍，早晚会有一处忘了改
 *    —— 这个仓库为「散在五处」的能力数字已经付过一次学费。
 * 2. **分辨率大小写在这里转换。** 内部一律小写（`'720p'`），UI 和校验都按这个
 *    口径；只有上行的这一刻转成官方要的 `'720P'`。不让大小写差异漏进 UI。
 *
 * ## 顺序即编号
 *
 * 与 Seedance 的 `buildContent` 同一条铁律：提示词里的「图片1 / 视频1」指的是
 * media[] 里的第 N 个，不是某个 id。所以 **文档 / 网页链接一律追加到末尾** ——
 * 它们不该把图/视频的序号挤位。
 *
 * ## ⚠️ 与人像库彻底无关（调用方必须遵守）
 *
 * 万相**只认公网 https 直链**，它不知道 Seedance 素材库/人像库的存在。所以这条
 * 链路上三件事一件都不能做：
 *
 *   1. **不发 `asset://`**。那是 Seedance 素材库的引用形态，万相收到只会 400。
 *      本模块的 `requireHttpUrl` 会在组包时就拦下来，不让它出门。
 *   2. **不跑 `verifyContentAssetReferences`**。那是校验 `asset://` 在 Seedance
 *      站点里是否存在，对万相既无意义又要 Seedance 凭据。
 *   3. **不跑 `importImagesToPortraitLibrary`**。提交后把参考图登记进 Seedance
 *      人像库是 Seedance 那条路的行为；万相的素材不该流进别家的库，而且那次调用
 *      需要 Seedance 的 apiKey/apiSecret，用户可能压根没配。
 *
 * 换句话说：**万相不要人像库兜底**。素材到这里必须已经是 COS/OSS 直链 —— 这一点
 * `materialTransfer` 与预传本来就保证了；走到这里还不是 https，说明上游漏了，
 * 报错比蒙混过去好。
 */

import { capabilitiesFor } from '../../../types/seedance'
import type { VideoModelAlias } from '../../../types/seedance'
import type { VideoWorkbenchMode } from '../../../types/videoModes'
import type { Wan3DocumentOrLink } from '../../../shared/wan3Document'
import { WAN3_UPSTREAM_MODEL_ID } from './region'

/**
 * 这个模型的提交链路要不要走 Seedance 素材库 / 人像库？
 *
 * 提交路径上挂着两件 Seedance 专属的事，**对万相一件都不能做**：
 *
 *   - `verifyContentAssetReferences`：校验 `asset://` 在 Seedance 站点存在。万相
 *     的素材里不可能有 `asset://`（组包时就拒了），而这次调用还要 Seedance 的
 *     apiKey/apiSecret —— 只配了 Miau 密钥的用户会拿着空凭据去打别人家接口。
 *   - `importImagesToPortraitLibrary`：提交后把参考图登记进人像库。万相的素材
 *     不该流进 Seedance 的库。
 *
 * 抽成谓词而不是在两个提交入口各写一个 `if`：入口有两个（工作台 UI 与 MCP
 * agent），每处两件事就是四个分支，第三个 provider 来了再翻倍，而「万相不要
 * 人像库兜底」这条保证会散在四处靠人记。这里是唯一出处。
 */
export function usesSeedanceAssetLibrary(model: VideoModelAlias | undefined): boolean {
  return capabilitiesFor(model ?? '2.0').provider === 'vvdance'
}

/** 业务校验失败。调用方应转成用户可读的错误，而不是 500。 */
export class Wan3RequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Wan3RequestError'
  }
}

export type Wan3MediaType =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'
  | 'file'
  | 'link'

export interface Wan3MediaItem {
  type: Wan3MediaType
  url: string
}

// 槽位的类型与分类逻辑在 `shared/wan3Document`：渲染层的输入框要按后缀即时判断
// 显示成「文档」还是「链接」，主进程只负责把它追加进 media[]。同一个形状只此一份。
export type { Wan3DocumentOrLink } from '../../../shared/wan3Document'

/** 官方接受的画幅。`adaptive` = 跟随首帧/参考。 */
export const WAN3_ALLOWED_RATIOS: readonly string[] = [
  'adaptive',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
] as const

/** 首帧 / 首尾帧模式 —— 与文档、参考视频、参考音频互斥。 */
const FRAME_MODES: ReadonlySet<VideoWorkbenchMode> = new Set(['first_frame', 'first_last_frame'])

/**
 * 只放行公网 http(s)。
 *
 * DashScope 认不了我们这边的任何本地形态，`data:` 更是直接超长。到这一步素材
 * 应该都已经被 `materialTransfer` / 预传换成 COS 直链了 —— 走到这里还不是 https
 * 说明上游那步漏了，宁可拦下来报错，也不要发出去等一个语焉不详的 400。
 */
export function isAllowedWan3MediaUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function requireHttpUrl(raw: unknown, label: string): string {
  if (isAllowedWan3MediaUrl(raw)) return raw.trim()
  // `asset://` 单独给一句人话:它是 Seedance 素材库/人像库的引用形态,用户是从
  // 素材选择器里挑出来的,看到「必须是 http(s) 地址」只会一头雾水。
  if (typeof raw === 'string' && raw.trim().startsWith('asset://')) {
    throw new Wan3RequestError(`万相 3.0 不支持人像库素材（${label}），请改用本地文件或图片链接`)
  }
  throw new Wan3RequestError(`${label}必须是公网 http(s) 地址`)
}

/** 无值返回 undefined；非法直接抛。三个 normalize 都是这个约定。 */
export function normalizeWan3Duration(duration: number | undefined): number | undefined {
  if (duration === undefined || duration === null) return undefined
  const n = Number(duration)
  if (!Number.isFinite(n)) throw new Wan3RequestError('时长无效')
  if (n === -1) return -1
  const { min, max } = capabilitiesFor('wan3').duration
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Wan3RequestError(`时长须为 ${min}–${max} 秒整数，或 -1（智能时长）`)
  }
  return n
}

/** 内部小写 → 官方大写。空值返回 undefined。 */
export function normalizeWan3Resolution(resolution: string | undefined): string | undefined {
  if (typeof resolution !== 'string' || !resolution.trim()) return undefined
  const lower = resolution.trim().toLowerCase()
  if (!capabilitiesFor('wan3').resolutions.includes(lower)) {
    throw new Wan3RequestError(
      `万相 3.0 仅支持 ${capabilitiesFor('wan3').resolutions.join(' / ')}，收到 ${resolution}`,
    )
  }
  return lower.toUpperCase()
}

export function normalizeWan3Ratio(ratio: string | undefined): string | undefined {
  if (typeof ratio !== 'string' || !ratio.trim()) return undefined
  const trimmed = ratio.trim()
  if (!WAN3_ALLOWED_RATIOS.includes(trimmed)) {
    throw new Wan3RequestError(`万相 3.0 不支持画幅 ${trimmed}，可用：${WAN3_ALLOWED_RATIOS.join(' / ')}`)
  }
  return trimmed
}

export interface Wan3ResolvedMedia {
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  imageUrls?: readonly string[]
  videoUrls?: readonly string[]
  audioUrls?: readonly string[]
}

/**
 * 模式 → `media[]`。素材 URL 必须是**已经解析好的** https 直链。
 *
 * 首帧 / 首尾帧是「用这张图当画面起点」，语义上排斥参考视频与参考音频；官方也
 * 不接受这种组合。与其发出去被拒，不如在这里说清楚。
 */
export function buildWan3ReferenceMedia(
  mode: VideoWorkbenchMode,
  resolved: Wan3ResolvedMedia,
): Wan3MediaItem[] {
  const caps = capabilitiesFor('wan3')
  const images = resolved.imageUrls ?? []
  const videos = resolved.videoUrls ?? []
  const audios = resolved.audioUrls ?? []

  if (!caps.modes.includes(mode)) {
    throw new Wan3RequestError(`万相 3.0 不支持「${mode}」模式`)
  }

  if (mode === 'text2video') {
    if (images.length || videos.length || audios.length || resolved.firstFrameUrl) {
      throw new Wan3RequestError('文生视频模式不携带任何素材')
    }
    return []
  }

  if (FRAME_MODES.has(mode)) {
    // 官方原文:「reference_xx / file / link 类型和 first_frame / last_frame 类型
    // **互斥**,不能在同一请求中混用」。混用时上游回的是
    //   "The two modes are mutually exclusive. Do not pass reference_xx and
    //    first_frame/last_frame at the same time."
    // 注意参考**图**也在互斥范围内 —— 早先只拦了视频/音频,图会被静默丢掉:
    // 请求照样发得出去、也照样出片,只是用户挂的那几张参考图根本没参与,
    // 而他不会收到任何提示。
    if (images.length || videos.length || audios.length) {
      throw new Wan3RequestError('首帧 / 首尾帧模式与参考图 / 参考视频 / 参考音频互斥，不能混用')
    }
    const first = resolved.firstFrameUrl
    if (!first) throw new Wan3RequestError('首帧模式需要一张首帧图')
    const media: Wan3MediaItem[] = [{ type: 'first_frame', url: requireHttpUrl(first, '首帧图') }]
    if (mode === 'first_last_frame') {
      if (!resolved.lastFrameUrl) throw new Wan3RequestError('首尾帧模式需要首帧与尾帧各一张图')
      media.push({ type: 'last_frame', url: requireHttpUrl(resolved.lastFrameUrl, '尾帧图') })
    }
    return media
  }

  // multimodal_ref
  if (images.length > caps.maxImages) {
    throw new Wan3RequestError(`参考图最多 ${caps.maxImages} 张，收到 ${images.length}`)
  }
  if (videos.length > caps.maxVideos) {
    throw new Wan3RequestError(`参考视频最多 ${caps.maxVideos} 段，收到 ${videos.length}`)
  }
  if (audios.length > caps.maxAudios) {
    throw new Wan3RequestError(`参考音频最多 ${caps.maxAudios} 段，收到 ${audios.length}`)
  }

  const media: Wan3MediaItem[] = []
  for (const url of images) media.push({ type: 'reference_image', url: requireHttpUrl(url, '参考图') })
  for (const url of videos) media.push({ type: 'reference_video', url: requireHttpUrl(url, '参考视频') })
  for (const url of audios) media.push({ type: 'reference_audio', url: requireHttpUrl(url, '参考音频') })
  return media
}

/**
 * 把文档 / 网页链接**追加到末尾**，并落实官方互斥。
 *
 * 追加而不是插入，是为了不挤掉「图片1 / 视频1」的序号 —— 提示词里的编号指的是
 * media[] 的位置。
 */
export function mergeWan3DocumentOrLink(
  base: readonly Wan3MediaItem[],
  doc: Wan3DocumentOrLink | undefined | null,
  mode: VideoWorkbenchMode,
): Wan3MediaItem[] {
  if (!doc) return [...base]
  if (FRAME_MODES.has(mode)) {
    throw new Wan3RequestError('首帧 / 首尾帧模式不能同时使用文档或网页链接')
  }
  if (doc.type !== 'file' && doc.type !== 'link') {
    throw new Wan3RequestError('文档槽的类型必须是 file 或 link')
  }
  const url = requireHttpUrl(doc.url, doc.type === 'file' ? '文档' : '网页链接')
  // 只取 type + url —— displayName 是给界面看的，不上行。
  return [...base, { type: doc.type, url }]
}

export interface Wan3CreateBodyInput {
  prompt: string
  mode: VideoWorkbenchMode
  resolution?: string
  ratio?: string
  duration?: number
  generateAudio?: boolean
  documentOrLink?: Wan3DocumentOrLink | null
}

/**
 * 发给 **Miau 网关** `/v1/video/generations` 的请求体。
 *
 * ⚠️ 与官方文档的形状不同,别照着官方 curl 改这里。官方直连 DashScope 是:
 *
 * ```
 * POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/
 *      video-generation/video-synthesis
 * { "model", "input": { "prompt", "media" }, "parameters": {...} }
 * ```
 *
 * 而我们打的是 Miau(new-api)的 OpenAI 兼容端点,它把上游请求整个收在 `metadata`
 * 里反序列化 —— 所以是 `metadata.input.media` 而不是顶层 `input.media`。两者都
 * 「对」,取决于对端是谁。走网关的理由:密钥与 base URL 都已经在应用里了
 * (`apiKeys['qwen']`),直连还要用户另配一份百炼 API Key 和 WorkspaceId。
 */
export interface Wan3CreateTaskBody {
  model: string
  prompt: string
  seconds?: string
  size?: string
  metadata: {
    /** DashScope 结构。适配层把整个 metadata 反序列化成上游请求。 */
    input: { media: Wan3MediaItem[] }
    /**
     * 与 `input.media` 同内容的平铺副本。参考实现两处都写，用于兼容网关里既有的
     * 消费方；Go 侧对未知字段是忽略的，多写这一份不会有副作用，而少写可能让某条
     * 分支拿不到素材 —— 在一个我们无法本地实测的协议上，跟着已知可用的实现走。
     */
    media: Wan3MediaItem[]
    parameters: {
      prompt_extend: boolean
      audio: boolean
      resolution?: string
      ratio?: string
      duration?: number
    }
  }
}

export function buildWan3CreateBody(
  input: Wan3CreateBodyInput,
  resolved: Wan3ResolvedMedia,
): Wan3CreateTaskBody {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Wan3RequestError('提示词不能为空')

  const media = mergeWan3DocumentOrLink(
    buildWan3ReferenceMedia(input.mode, resolved),
    input.documentOrLink,
    input.mode,
  )

  const resolution = normalizeWan3Resolution(input.resolution)
  const ratio = normalizeWan3Ratio(input.ratio)
  const duration = normalizeWan3Duration(input.duration)

  return {
    model: WAN3_UPSTREAM_MODEL_ID,
    prompt,
    // 顶层 seconds/size 与 metadata.parameters 同时给：网关先读顶层做默认值，
    // metadata 合并在其后，`duration: -1` 因此能活着到上游（见网关 adaptor 的
    // 「默认 5 秒延后到 metadata 合并之后」）。
    ...(duration !== undefined ? { seconds: String(duration) } : {}),
    ...(resolution ? { size: resolution } : {}),
    metadata: {
      input: { media },
      media,
      parameters: {
        // 官方默认开启的提示词扩写。
        prompt_extend: true,
        // 官方默认有声；只有用户显式关掉才传 false。
        audio: input.generateAudio !== undefined ? Boolean(input.generateAudio) : true,
        ...(resolution ? { resolution } : {}),
        ...(ratio ? { ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
      },
    },
  }
}
