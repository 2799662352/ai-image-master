/**
 * cosThumb — derive a Tencent Cloud 数据万象 (CI) thumbnail URL from a COS object URL.
 *
 * Generated-image chat bubbles must NOT load the full-resolution image into an
 * 80px box (a 4000×3000 PNG decodes to ~48 MB RGBA — the dominant per-image
 * memory cost behind the concurrent-generation OOM). When the artifact lives on
 * COS we let 数据万象 return a few-KB resized WebP via `imageMogr2` URL params,
 * so the renderer fetches a thumbnail instead of decoding the original.
 *
 * Only COS URLs are rewritten. Local paths, `data:`/`blob:` URLs and arbitrary
 * non-COS http URLs are returned untouched — `imageMogr2` only works on objects
 * served by COS/CI, and silently appending it to other hosts would break them.
 *
 * The lightbox / full view deliberately keeps the bare original URL (no params)
 * so it always shows the uncompressed image.
 *
 * 实测(2026-09-15,image-master 桶,直连与经代理两条路都测):
 *  - 13.4 MB PNG → `512x512>` WebP 22 KB / `1024x1024>` 88 KB,冷 ~0.8 s、热 ~0.25 s,
 *    8 并发全 200 无限流;结果带 `server: tencent-ci` + `cache-control: max-age=2592000`
 *    (万象侧缓存 30 天,浏览器也照缓存)。HEAD 同样 200,可当预检。
 *  - **写错操作名不报错**:`imageMogr2/bogusop/1` 返回 200 + 12 MB 重编码 PNG,
 *    带不带 ignore-error 都一样 —— 参数串必须是这里的常量,别在调用点手拼。
 *  - **对非图片对象也 200 原样回整个文件**(.yml 测得):对 .mp4 加 imageMogr2 =
 *    下载整段视频,所以下面按扩展名把非图片 key 挡掉。
 *  - `thumbnail/20000x20000` 不带 `>` 会真放大到 3 MB、耗时 14 s;`>`(shrink-only)
 *    不能丢。官方限制:原图 ≤ 32 MB、宽高 ≤ 30000、总像素 ≤ 2.5 亿;结果宽高 ≤ 9999。
 *  - 预签名 URL 追加 imageMogr2 需要把参数签进 `q-url-param-list`;我们只对自有
 *    public-read 桶的裸 URL 追加,带 `?` 的直出签名链接一律不动。
 */

/** Default longest-edge size for bubble thumbnails (retina-safe for ~80px boxes). */
const DEFAULT_THUMB_SIZE = 512

/**
 * 数据万象只认图片;对其它对象它不报错而是原样吐回整个文件。按 key 的扩展名把
 * 非图片挡在外面 —— 没有扩展名的 key(少见)按图片放行,交给 ignore-error。
 */
const NON_IMAGE_KEY = /\.(mp4|webm|mov|m4v|mkv|avi|mp3|wav|m4a|aac|ogg|flac|pdf|zip|json|ya?ml|txt|md|csv|bin)$/i

function isImageObjectKey(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0]
  return !NON_IMAGE_KEY.test(path)
}

/**
 * Same detection as `hooks/useHistoryData.isCosUrl`: a Tencent COS bucket URL is
 * `https://<bucket>.cos.<region>.myqcloud.com/...`.
 */
export function isCosUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.includes('.cos.') && url.includes('.myqcloud.com')
}

/**
 * Append 数据万象 thumbnail params to a COS URL. No-op for non-COS sources or
 * URLs that already carry a query string (avoid double-processing / clobbering).
 *
 * `512x512>` = fit-inside, shrink-only (never upscale); `>` is percent-encoded
 * as `%3E` for query safety. `ignore-error/1` makes CI return the original when
 * a particular object can't be processed (e.g. unsupported format) instead of
 * erroring out to a broken image.
 */
export function appendCosThumb<T extends string | undefined>(
  url: T,
  size: number = DEFAULT_THUMB_SIZE,
): T {
  if (!url) return url
  if (!isCosUrl(url)) return url
  if (url.includes('?')) return url
  if (!isImageObjectKey(url)) return url
  const edge = Math.max(1, Math.round(size))
  return `${url}?imageMogr2/thumbnail/${edge}x${edge}%3E/format/webp/quality/85/ignore-error/1` as T
}

// ---------------------------------------------------------------------------
// 持久化缩略图(2026-09-15 起)
//
// 主进程上传 image-history 原图时带 `Pic-Operations`,万象把 512 / 1024 两档 WebP
// **存成桶里的独立对象**(见 main/services/tencent/cosThumbRules.ts,命名约定两边
// 必须一致)。读侧按约定反推出那个对象的 URL,放在候选链最前面:它是普通 COS GET,
// 不经万象在线处理;对象不存在(改动前上传的老图 / 老版本客户端上传的)就是一个
// 干脆的 404,候选链立刻换到实时 imageMogr2,不做原地重试。
// ---------------------------------------------------------------------------

/** 与主进程 `PERSISTED_THUMB_SIZES` 一致。 */
export const PERSISTED_THUMB_SIZES = [512, 1024] as const
export type PersistedThumbSize = (typeof PERSISTED_THUMB_SIZES)[number]

/**
 * 日期闸:只有这一天(含)之后上传的原图才去找持久化对象。桶里 2026-09-15 之前的
 * 18.9 万张原图都没有它,每张先吃一个 404 再回落实时 imageMogr2 是白花 200 ms。
 * 跑完 `scripts/backfill-image-thumbs.mjs` 回填历史后把这里往前挪(或设为 '' 全放开)。
 * 老版本客户端在此之后上传的图仍会 404 一次 —— 少数且逐日减少,可接受。
 */
export const PERSISTED_THUMBS_SINCE = '2026/09/15'

/** 只对我们自己按日期分目录的 image-history 原图键反推(`generateImageHistoryKey` 的形状)。 */
const IMAGE_HISTORY_ORIGINAL = /\/image-history\/(\d{4}\/\d{2}\/\d{2})\/[^/?#]+\.[a-z0-9]{2,5}$/i
const PERSISTED_THUMB_SUFFIX = /\.thumb(512|1024)\.webp$/i

/** 挑一档够用的持久化尺寸:要 ≤512 就拿 512,再大拿 1024(别把 1024 的图缩给 80px 气泡)。 */
export function pickPersistedThumbSize(size: number): PersistedThumbSize {
  return size <= 512 ? 512 : 1024
}

/**
 * `https://…/image-history/2026/09/15/abc.png` → `https://…/image-history/2026/09/15/abc.thumb512.webp`。
 * 不是我们桶里的 image-history 原图(签名直出链接、本地路径、别的目录、已经是缩略图)
 * 返回 undefined,调用方就不把它放进候选链。
 */
export function persistedCosThumbUrl(url: string | undefined, size: number = DEFAULT_THUMB_SIZE): string | undefined {
  if (!url || !isCosUrl(url) || url.includes('?') || url.includes('#')) return undefined
  const m = IMAGE_HISTORY_ORIGINAL.exec(url)
  if (!m || PERSISTED_THUMB_SUFFIX.test(url) || !isImageObjectKey(url)) return undefined
  // `YYYY/MM/DD` 零填充,字符串比较就是日期比较。
  if (PERSISTED_THUMBS_SINCE && m[1] < PERSISTED_THUMBS_SINCE) return undefined
  const dot = url.lastIndexOf('.')
  return `${url.slice(0, dot)}.thumb${pickPersistedThumbSize(size)}.webp`
}

/** 候选链里的持久化缩略图 URL —— 失败不原地重试,直接让位给实时 imageMogr2。 */
export function isPersistedCosThumbUrl(url: string): boolean {
  return isCosUrl(url) && !url.includes('?') && PERSISTED_THUMB_SUFFIX.test(url)
}
