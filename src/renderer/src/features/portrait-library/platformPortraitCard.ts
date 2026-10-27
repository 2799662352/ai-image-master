// 平台人像库(`window.electronAPI.portraitLibrary`)的展示层形状与判断。
//
// **纯函数,不碰 window、不发请求。** 打这条边界是为了让三条硬约束能被单点测到:
// 「Hidden 只在展示层过滤」「非 Active 不过滤只灰掉」这两条本质上是形状判断,
// 埋进组件里就只能靠渲染树间接观察 —— 而间接观察对变异不敏感。
//
// 上游 DTO(大写字段)的真源是 `src/types/portraitApi.ts`;这里只做单向的
// 「上游 → 卡片」映射,不反向构造 DTO。

import type {
  PortraitAsset,
  PortraitAssetType,
  PortraitRegisteredAsset,
} from '../../../../types/portraitApi'

export type PortraitCardKind = 'image' | 'video' | 'audio'

/** 终态只有 `Active` / `Failed`,其余(含缺省)都按处理中(portraitApi.ts:59)。 */
export type PortraitCardStatus = 'Active' | 'Failed' | 'Processing'

/**
 * 网格里的一张卡。
 *
 * 与 vvdance 的 `SeedanceAssetItem` **刻意保持形状独立**:两边的字段名、缺省语义、
 * 甚至「有没有异步处理态」都不同,硬凑一个共用类型只能取交集,而交集里恰好没有
 * `status` / `hidden` —— 那正是本次要做的两条硬约束所依赖的字段。
 */
export interface PortraitCard {
  /** React key 与多选字典的键。平台侧 `Id` 必非空(主进程 `hasId` 已过滤)。 */
  key: string
  assetId: string
  name: string
  kind: PortraitCardKind
  /** 网格缩略图;已按 COS 域名拼过尺寸参数。 */
  thumbUrl?: string
  /** 原图 / 原片地址(大图预览、`<video src>`)。 */
  mediaUrl?: string
  /** 引用形态。网关那条路正是靠它把素材递给上游(seedanceGateway/request.ts)。 */
  assetUrl: string
  status: PortraitCardStatus
  hidden: boolean
  /** 失败原因(上游给的),供 hover 提示用。 */
  failureMessage?: string
  createTime?: string
}

/**
 * 缩略图宽度。
 *
 * 网页版把原图 URL 直接塞 `<img>`,一张 40MB 的原图在网格里也要下满 40MB。
 * 400px 覆盖了目前最大的一档卡片(6 列布局下的两倍图),再大没有肉眼收益。
 */
const THUMB_WIDTH = 400

/**
 * 我方 COS 的公网域名形态:`<bucket>.cos.<region>.myqcloud.com`。
 *
 * **只在这类域名上拼 `imageMogr2`。** 数据万象是腾讯云自家的图片处理接口,
 * 上游 TOS 链、CDN 链、用户自带的图床都不认这个 query,拼上去直接 404 ——
 * 而 404 在网格里表现为一格占位图,用户只会以为「这张图坏了」。
 */
const COS_HOST_RE = /(^|\.)cos\.[a-z0-9-]+\.myqcloud\.com$/i

const MB = 1024 * 1024

/**
 * 与后端 `MEDIA_SIZE_LIMITS` 同口径(`platformAssets.ts:85-89`)。
 *
 * ⚠️ 网页版 `mediaLimits.ts` 写的是 200MB 视频,那是**错的**:50–200MB 的视频会在
 * 服务端 400,而用户是在把 200MB 传完之后才知道。
 *
 * 主进程也会拦一道(`FILE_TOO_LARGE`),这里再拦一次不是重复:主进程收到字节时
 * IPC 那次整份拷贝已经发生了 —— 一个 500MB 的误选会先复制 500MB 过进程边界再被拒。
 * 真正省事的闸必须在 `file.arrayBuffer()` **之前**。
 */
export const PLATFORM_UPLOAD_LIMITS: Record<PortraitAssetType, number> = {
  Image: 50 * MB,
  Video: 50 * MB,
  Audio: 15 * MB,
}

/** 与后端 `detectAssetType` 同口径:按 MIME 前缀,不看后缀。 */
export function platformAssetTypeOf(mimeType: string): PortraitAssetType {
  if (mimeType.startsWith('video/')) return 'Video'
  if (mimeType.startsWith('audio/')) return 'Audio'
  return 'Image'
}

function kindOfAssetType(assetType: PortraitAssetType): PortraitCardKind {
  if (assetType === 'Video') return 'video'
  if (assetType === 'Audio') return 'audio'
  return 'image'
}

/**
 * 缩略图地址。拼不了尺寸参数时原样返回 —— 显示大图总比显示不出来强。
 *
 * 带 query 的一律不碰:那批多半是历史遗留的签名链,而 COS 签名覆盖了参数列表
 * (`q-url-param-list`),额外塞一个 `imageMogr2` 会让整条链 403。
 * 走 `upload → register` 入库的是永久链、无 query,正好落在能拼的那一支。
 */
export function thumbnailUrl(src: string | undefined, kind: PortraitCardKind): string | undefined {
  if (!src) return undefined
  if (kind !== 'image') return src
  if (src.includes('?') || src.includes('#')) return src
  let host: string
  try {
    host = new URL(src).hostname
  } catch {
    return src
  }
  if (!COS_HOST_RE.test(host)) return src
  return `${src}?imageMogr2/thumbnail/${THUMB_WIDTH}x`
}

function statusOf(raw: string | undefined): PortraitCardStatus {
  if (raw === 'Active') return 'Active'
  if (raw === 'Failed') return 'Failed'
  return 'Processing'
}

function toCard(a: PortraitAsset): PortraitCard {
  const assetType = ((): PortraitAssetType => {
    const t = (a.AssetType ?? '').toLowerCase()
    if (t === 'video') return 'Video'
    if (t === 'audio') return 'Audio'
    return 'Image'
  })()
  const kind = kindOfAssetType(assetType)
  const thumbSource = a.PreviewUrl || a.URL
  const mediaUrl = a.URL || a.cosUrl || a.PreviewUrl
  const failureMessage = a.Error?.Message
  return {
    key: a.Id,
    assetId: a.Id,
    name: a.Name || a.Id,
    kind,
    ...(thumbnailUrl(thumbSource, kind) === undefined
      ? {}
      : { thumbUrl: thumbnailUrl(thumbSource, kind) as string }),
    ...(mediaUrl ? { mediaUrl } : {}),
    assetUrl: `asset://${a.Id}`,
    status: statusOf(a.Status),
    hidden: a.Hidden === true,
    ...(failureMessage ? { failureMessage } : {}),
    ...(a.CreateTime ? { createTime: a.CreateTime } : {}),
  }
}

/**
 * 上游列表 → 卡片。
 *
 * 🚨 **这里不过滤任何东西 —— 既不过滤 `Hidden`,也不过滤非 `Active`。**
 *
 * `Hidden`:这个数组同时用于解析画布上已有引用的 `asset://`,在源头过滤会让那些
 * 节点直接失效(portraitApi.ts:69-75)。过滤在 `visibleCards`。
 *
 * 非 `Active`:过滤掉的后果是素材「上传完就不见了」,用户会重复上传,而**每重复
 * 一次都真实占用配额**。处置是灰掉 + 说清原因,见 `isCardSelectable` / `cardStatusBadge`。
 */
export function portraitCardsFromPlatform(items: PortraitAsset[]): PortraitCard[] {
  return items.map(toCard)
}

/**
 * `register` 的回包 → 立刻能显示的卡片。
 *
 * 回包里三个 URL 都是提交的那条永久 COS 链,所以缩略图**不必等 poll** 就有;
 * 缺的只是元数据,而 `Name` / `AssetType` / 上传时刻本来就在调用方手里。
 *
 * 状态刻意落 `Processing` 而不是合成一个 `Active`:回包里根本没有 `Status`
 * (portraitApi.ts:88-93),合成一个会让这张卡立刻可选,拿去生成撞 `ASSET_NOT_READY`。
 */
export function cardFromRegistered(
  registered: PortraitRegisteredAsset,
  local: { name: string; assetType: PortraitAssetType; createTime?: string },
): PortraitCard {
  return toCard({
    Id: registered.Id,
    Name: local.name,
    AssetType: local.assetType,
    PreviewUrl: registered.PreviewUrl,
    URL: registered.URL,
    cosUrl: registered.cosUrl,
    ...(local.createTime ? { CreateTime: local.createTime } : {}),
  })
}

/** 展示层过滤。回收站视图与正常视图口径相反,两边都只看 `hidden` 这一个字段。 */
export function visibleCards(cards: PortraitCard[], opts: { trash: boolean }): PortraitCard[] {
  return cards.filter((c) => c.hidden === opts.trash)
}

/** 按 id 解析(含已移出素材库的)—— 画布节点靠这条路把 `asset://` 变回一张图。 */
export function findCardByAssetId(cards: PortraitCard[], assetId: string): PortraitCard | undefined {
  return cards.find((c) => c.assetId === assetId)
}

/** 只有终态 `Active` 能被选中送去生成。 */
export function isCardSelectable(card: PortraitCard): boolean {
  return card.status === 'Active'
}

export interface PortraitStatusBadge {
  text: string
  /** hover 提示;说清为什么不能用、以及下一步该干嘛。 */
  reason: string
  tone: 'pending' | 'failed'
}

/** `Active` 回 `null`:满屏「可用」等于没有信息,只有异常才值得占一个角标。 */
export function cardStatusBadge(card: PortraitCard): PortraitStatusBadge | null {
  if (card.status === 'Active') return null
  if (card.status === 'Failed') {
    // 「换一张」而不是「稍等」:这是上游的终态判决,再重试一万次也还是 Failed。
    const why = card.failureMessage ? `失败原因:${card.failureMessage}。` : '上游处理失败。'
    return { text: '失败', reason: `${why}换一张或重新导入`, tone: 'failed' }
  }
  return { text: '处理中', reason: '上游还在处理这条素材,处理完成后才能用于生成,请稍等', tone: 'pending' }
}

/**
 * 上传前的本地闸;返回 `null` 表示放行,否则是给用户看的拒绝理由。
 *
 * **只拦体积与「压根不是媒体」这两类。** 具体的编解码白名单(后端只放行 13 种 MIME)
 * 刻意不在这里抄一份 —— 那张表抄过来必然与后端各自漂移,而漂移的症状是客户端拒掉
 * 一个后端本来收的文件。体积不同:上限是稳定的、超限的代价(整份字节先过一次 IPC)
 * 又恰好只能在这里省下来。
 */
export function rejectUploadReason(file: { name: string; type: string; size: number }): string | null {
  const isMedia =
    file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/')
  if (!isMedia) {
    return `「${file.name}」不是图片 / 视频 / 音频,人像库收不了`
  }
  const assetType = platformAssetTypeOf(file.type)
  const limit = PLATFORM_UPLOAD_LIMITS[assetType]
  if (file.size > limit) {
    return `「${file.name}」超过 ${limit / MB}MB 上限(当前 ${(file.size / MB).toFixed(1)}MB)`
  }
  return null
}

/**
 * 按 error code 给下一步动作。
 *
 * **按 code 分支而不是照抄 message,是这个函数存在的理由**:几类错误要引导的动作
 * 完全不同(等一等 / 换文件 / 去登录 / 去选池),而用户看到一句「素材未就绪」
 * 并不知道该往哪儿点。未命中的 code 原样透出 message —— 漏掉一个新 code 时,
 * 原文比「什么都不说」强,至少还能报给客服。
 */
export function portraitErrorHint(code: string, message: string): string {
  switch (code) {
    case 'ASSET_NOT_READY':
      return '素材还在处理中,稍等几秒再试'
    case 'ASSET_FAILED':
      return '这条素材上游处理失败了,换一张或重新导入'
    case 'NOT_AUTHENTICATED':
    case 'NOT_LOGGED_IN':
      return '登录已失效,请重新登录后再试'
    case 'INVALID_POOL':
      return '请先在账号设置里选择一个计费池'
    case 'HTTP_403':
    case 'PROJECT_NOT_ALLOCATED':
      return '没有这个组织的素材权限,换一个组织后重试'
    // 这两条的 message 里带着确切的上限 / 类型,丢掉它等于让用户去猜;
    // 但光有事实没有动作又不够,所以是「原文 + 下一步」而不是二选一。
    case 'FILE_TOO_LARGE':
    case 'UNSUPPORTED_MEDIA_TYPE':
      return message ? `${message},请换一个文件` : '这个文件人像库收不了,请换一个文件'
    default:
      return message || `人像库请求失败(${code})`
  }
}
