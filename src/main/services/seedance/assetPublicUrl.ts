/**
 * 「只收公网链接」的渠道(能力表 `assetRefs: 'public-url'`,目前是 Roneyun-cn)的素材规则。
 *
 * 用户的决定(2026-11-17):这条渠道「不需要管人像库…切换的时候就别发人像库 id,只发公网 url」。
 * 所以与火山方舟那条路相反:
 *
 *   - **不登记**:提交前不把参考素材送进素材库、不改写成 `asset://`;
 *   - **不核验**:不去素材库查卡上的 id 在不在当前计费池;
 *   - **换回去**:卡上已经是 `asset://<id>` 的素材(从人像库选的、在火山渠道下用过的)在提交前
 *     换回它的公网地址;换不出来就拦下并说清楚,**一个 id 都不发出去**。
 *
 * 换回去而不是直接报错:用户把一张做好的卡从火山切到这条渠道是最常见的用法,卡上的素材多半
 * 已经是 `asset://`。让他把素材全删了重传,等于这条渠道对老卡不可用。
 *
 * ## 公网地址从哪来(按顺序)
 *
 * 1. **本机绑定表反查**(`portraitLibrary/ensureAsset.lookupAssetSourceUrl`):这个 id 当初就是
 *    拿一条公网 URL 登记的,那条 URL 原样在盘上。不发请求、与计费方式无关 —— 自填 Key 也能用。
 * 2. **素材库详情**(`getAsset`):在别的设备 / 网页版入库的素材本机没有绑定,按 id 向平台素材库
 *    取一次,用它的 `cosUrl`(后端转存的永久链)→ `URL`(登记时的源地址)。只有平台余额且已选
 *    计费池时才有这一步(自填 Key 没有登录态,问不了)。
 *
 * 这个文件只有纯函数,依赖都从参数进来,不碰 electron,单测直接喂假数据。
 */

import { capabilitiesFor } from '../../../types/seedance'
import type { VideoModelAlias } from '../../../types/seedance'
import type { PlatformAsset } from '../portraitLibrary/platformAssets'
import { applyAssetRewrites } from './assetRefRewrite'
import type { SeedanceContentItem } from './types'

const ASSET_SCHEME = 'asset://'

export type AssetMediaKind = 'image' | 'video' | 'audio'

type AssetUrlFields = Pick<PlatformAsset, 'cosUrl' | 'URL' | 'PreviewUrl'>

const HTTP_URL = /^https?:\/\//i

/** 来路不明的值(绑定表 / 素材库详情的字段)是不是一条公网地址;是的话顺带收窄成 string。 */
function isPublicUrl(value: unknown): value is string {
  return typeof value === 'string' && HTTP_URL.test(value.trim())
}

/** content 条目里的媒体地址与种类;文本条目返回 null。 */
function mediaOf(item: SeedanceContentItem): { kind: AssetMediaKind; url: string } | null {
  if (item.type === 'image_url') return { kind: 'image', url: item.image_url.url }
  if (item.type === 'video_url') return { kind: 'video', url: item.video_url.url }
  if (item.type === 'audio_url') return { kind: 'audio', url: item.audio_url.url }
  return null
}

/**
 * 素材库详情里哪条地址可以当公网链接发出去。
 *
 * `cosUrl` 在前:它是后端转存的永久链;`URL` 是登记时的源地址,可能是带签名、会过期的链接
 * (此刻仍可下载,所以排第二而不是不用)。
 *
 * `PreviewUrl` **只给图片用**:图片的预览就是图本身(缩略或原图),而视频 / 音频的预览多半是
 * 一张封面 —— 拿它顶上去,发出去的是「一张图冒充参考视频」,上游照收、成片不对、不报错。
 */
export function pickPublicAssetUrl(asset: AssetUrlFields, kind: AssetMediaKind): string | null {
  const candidates = [asset.cosUrl, asset.URL, ...(kind === 'image' ? [asset.PreviewUrl] : [])]
  for (const candidate of candidates) {
    if (isPublicUrl(candidate)) return candidate.trim()
  }
  return null
}

export function unresolvedAssetRefsMessage(assetIds: readonly string[], channelLabel: string): string {
  return (
    `${channelLabel} 渠道只收公网链接,不认人像库素材的编号;` +
    `下面这些素材换不出公网地址:${assetIds.map((id) => `${ASSET_SCHEME}${id}`).join('、')}。` +
    '请在卡片上删掉它们,改传本地文件或图片 / 视频 / 音频链接后再生成;' +
    '或者把模型换回火山方舟渠道(那边可以直接用人像库素材)。本次未提交,没有扣费。'
  )
}

export interface PublicUrlSources {
  /** 本机绑定表反查:这个 id 是拿哪条公网 URL 登记的。查不到回 null。同步、不发请求。 */
  lookupSourceUrl: (assetId: string) => string | null
  /**
   * 向平台素材库按 id 取详情。**没有就不传**(自填 Key、或平台余额但没选计费池)——
   * 那时只靠本机绑定表。抛错按「取不到」处理。
   */
  fetchAsset?: (assetId: string) => Promise<AssetUrlFields>
  /** 报错里渠道的叫法。 */
  channelLabel: string
}

/**
 * 把 content 里的 `asset://<id>` 全部换成公网地址,**保持数组顺序**(上游按下标解析提示词里的
 * 「图片1 / 视频1」)。没有 `asset://` 时原样返回同一个数组。
 *
 * 有任何一个换不出来就抛(中文、列出是哪几个、说明怎么办),不做「能换几个换几个」:
 * 剩下的 id 发出去上游不认,任务要么创建失败、要么少一份参考素材还照常扣费。
 */
export async function replaceAssetRefsWithPublicUrls(
  content: SeedanceContentItem[],
  sources: PublicUrlSources,
): Promise<SeedanceContentItem[]> {
  // id → 种类。同一个 id 在卡上出现几次,种类也只可能是一种(它是同一份素材)。
  const kinds = new Map<string, AssetMediaKind>()
  for (const item of content) {
    const media = mediaOf(item)
    if (!media || !media.url.startsWith(ASSET_SCHEME)) continue
    const id = media.url.slice(ASSET_SCHEME.length)
    if (!kinds.has(id)) kinds.set(id, media.kind)
  }
  if (kinds.size === 0) return content

  const rewrites = new Map<string, string>()
  const unresolved: string[] = []
  await Promise.all(
    [...kinds].map(async ([id, kind]) => {
      const local = sources.lookupSourceUrl(id)
      if (isPublicUrl(local)) {
        rewrites.set(`${ASSET_SCHEME}${id}`, local.trim())
        return
      }
      if (sources.fetchAsset) {
        try {
          const url = pickPublicAssetUrl(await sources.fetchAsset(id), kind)
          if (url) {
            rewrites.set(`${ASSET_SCHEME}${id}`, url)
            return
          }
        } catch (e) {
          console.warn('[seedance] asset → public url lookup failed:', id, e)
        }
      }
      unresolved.push(id)
    }),
  )
  if (unresolved.length > 0) {
    // 按卡上出现的顺序报,用户对照卡片好找(并发完成的顺序不稳定)。
    const ordered = [...kinds.keys()].filter((id) => unresolved.includes(id))
    throw new Error(unresolvedAssetRefsMessage(ordered, sources.channelLabel))
  }
  return applyAssetRewrites(content, rewrites)
}

/**
 * 发出去之前的最后一道:只收公网链接的渠道,content 里**每一条**媒体地址都必须是 http(s)。
 *
 * 正常链路上面两步已经保证了这一点(本地文件 / data: 在 `buildContent` 里中转成 COS 链接,
 * `asset://` 在 `replaceAssetRefsWithPublicUrls` 里换掉)。这里是给「以后有人加了第三个提交入口、
 * 忘了走那两步」留的:宁可在本机响亮地拦下,也不把一个人像库 id 或一段 base64 发给不认它的上游。
 * 其它渠道(火山认 `asset://` 与内联;万相 / 可灵有各自的组包层把关)不受影响。
 */
export function assertPublicUrlMediaOnly(
  model: VideoModelAlias | undefined,
  content: readonly SeedanceContentItem[],
): void {
  if (capabilitiesFor(model ?? '2.0')?.assetRefs !== 'public-url') return
  const offenders: string[] = []
  for (const item of content) {
    const media = mediaOf(item)
    // (这里用正则而不是上面的类型守卫:`media.url` 本来就是 string,守卫的「否」分支会把它收窄成 never。)
    if (!media || HTTP_URL.test(media.url.trim())) continue
    // 只报是哪一类,不把整条地址(可能是几 MB 的 data:)塞进错误信息。
    offenders.push(media.url.startsWith(ASSET_SCHEME) ? media.url : `${media.url.slice(0, 24)}…`)
  }
  if (offenders.length > 0) {
    throw new Error(
      `这条渠道只收公网链接,但这次提交里还有不是公网链接的素材:${offenders.join('、')}。` +
        '本次未提交,没有扣费;请重试,仍然出现请反馈给开发者。',
    )
  }
}
