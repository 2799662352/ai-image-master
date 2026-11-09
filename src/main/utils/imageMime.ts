/**
 * 生成图落盘 / 上传时的类型判定(纯函数,可单测;`index.ts` 引 electron 没法直接测)。
 *
 * 为什么要认 GIF / SVG:GPT Image 2.6 官转能出 GIF 动图与 SVG 矢量图,而 apiyi 回的是一条
 * **没有扩展名**的 URL(形如 `…/response_images/17137/2026/11/09/241`),响应头也不一定带
 * 对的 `Content-Type`。只靠「头 → URL 后缀 → png」这条链,SVG 会被当成 `.png` 落盘并以
 * `image/png` 上传 —— 浏览器对标成 png 的 SVG 不渲染,历史里就是一张裂图。所以头不可信时
 * 要看文件头字节。
 */

import fsp from 'node:fs/promises'

/** mime → 落盘后缀;认不出 = `bin`(与旧行为一致)。 */
export function mimeTypeToExtension(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png'
    case 'image/jpeg': case 'image/jpg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/svg+xml': return 'svg'
    case 'image/avif': return 'avif'
    case 'image/heic': return 'heic'
    default: return 'bin'
  }
}

/** URL 路径后缀 → mime(去掉查询串);认不出 = `fallback`。 */
export function mimeFromUrl(url: string, fallback = 'image/png'): string {
  const lower = url.split('?')[0]?.toLowerCase() ?? ''
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.avif')) return 'image/avif'
  return fallback
}

/** 嗅探需要的字节数:SVG 的 `<svg` 可能在 XML 声明 / 注释 / DOCTYPE 之后。 */
export const IMAGE_SNIFF_BYTES = 1024

/**
 * 按文件头认图片类型:png / jpeg / gif / webp / svg;认不出 = null。
 * SVG 是文本:跳过 BOM 与空白后以 `<svg` 开头,或以 `<?xml` 开头且前 1 KB 内出现 `<svg`。
 */
export function sniffImageMime(head: Uint8Array): string | null {
  const b = head
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return 'image/gif'
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp'
  }
  // 文本探测:只解码前 IMAGE_SNIFF_BYTES,去掉 UTF-8 BOM 与前导空白。
  const text = Buffer.from(b.subarray(0, IMAGE_SNIFF_BYTES)).toString('utf8').replace(/^\uFEFF/, '').trimStart()
  if (/^<svg[\s>]/i.test(text)) return 'image/svg+xml'
  if (/^<\?xml[\s\S]*?<svg[\s>]/i.test(text)) return 'image/svg+xml'
  return null
}

/** 读文件前 `IMAGE_SNIFF_BYTES` 字节(流式落盘后的嗅探用);读不了 = 空,等于「认不出」。 */
export async function readImageHead(filePath: string): Promise<Uint8Array> {
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(filePath, 'r')
    const buf = Buffer.alloc(IMAGE_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buf, 0, IMAGE_SNIFF_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return new Uint8Array(0)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * 抓回一张远端图之后,定它的最终 mime。
 *
 * - 响应头是 `image/*` → 信头(与旧行为一致,GIF / WebP 照常被头纠正);
 * - 头缺失 / `application/octet-stream` / 非图片 → 看文件头字节,认得出就用,认不出保持 `current`
 *   (调用方按 hint 或 URL 后缀猜的那个)。
 */
export function resolveFetchedImageMime(
  headerContentType: string | undefined,
  current: string,
  head: Uint8Array,
): string {
  const actual = headerContentType?.split(';')[0]?.trim().toLowerCase()
  if (actual && actual.startsWith('image/')) return actual
  return sniffImageMime(head) ?? current
}
