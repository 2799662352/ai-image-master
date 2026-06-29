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
 */

/** Default longest-edge size for bubble thumbnails (retina-safe for ~80px boxes). */
const DEFAULT_THUMB_SIZE = 512

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
  const edge = Math.max(1, Math.round(size))
  return `${url}?imageMogr2/thumbnail/${edge}x${edge}%3E/format/webp/quality/85/ignore-error/1` as T
}
