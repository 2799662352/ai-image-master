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
