/**
 * 生成图落盘 / 上传时的类型判定(纯函数,可单测;`index.ts` 引 electron 没法直接测)。
 *
 * 为什么要认 GIF / SVG:GPT Image 2.6 官转能出 GIF 动图与 SVG 矢量图,而 apiyi 回的是一条
 * **没有扩展名**的 URL(形如 `…/response_images/17137/2026/11/09/241`;后来也见过带 `.png`
 * 键的),响应头不一定带对的 `Content-Type`,甚至会把 GIF 标成 `image/png`。只靠「头 →
 * URL 后缀 → png」这条链,SVG / GIF 会被当成 `.png` 落盘并以 `image/png` 上传 —— 浏览器对
 * 标成 png 的 SVG 不渲染,历史里就是一张裂图;GIF 则落成 `.png`、缩略图 / 另存为都不对。
 * 所以以文件头字节为准,头只在字节认不出时才作数。
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
 * `attachments:save-from-url`(agent 出图落到 uploads)下载完字节后定最终 mime。
 *
 * `fromHeaderOrUrl` 是调用方按「响应头 → URL 后缀」得到的类型(两者都认不出 = null,
 * 视频也走这条)。**图片魔数优先**:apiyi 的 GIF 存在 `….png` 键下并回 `image/png`
 * (2026-11-09 实测),只信头就会落成 `<hash>.png`,播放器按静图处理;SVG 同理。
 * 字节认不出(视频、avif / heic 等嗅探表外的格式)→ 保持 `fromHeaderOrUrl`,
 * 它也是 null 就是 null —— 调用方照旧拒绝「不是图片 / 视频」的下载。
 */
export function resolveDownloadedMediaMime(fromHeaderOrUrl: string | null, head: Uint8Array): string | null {
  return sniffImageMime(head) ?? fromHeaderOrUrl
}

/**
 * 抓回一张远端图之后,定它的最终 mime。
 *
 * - 文件头字节认得出(png / jpeg / gif / webp / svg)→ **以字节为准**,不管响应头怎么说:
 *   apiyi 把 GIF 存在 `….png` 键下并回 `Content-Type: image/png`(2026-11-09 实测),
 *   魔数比服务器头可靠;
 * - 字节认不出(avif / heic 等嗅探表外的格式,或没给字节)→ 响应头是 `image/*` 就信头;
 * - 头也缺失 / `application/octet-stream` / 非图片 → 保持 `current`
 *   (调用方按 hint 或 URL 后缀猜的那个)。
 */
export function resolveFetchedImageMime(
  headerContentType: string | undefined,
  current: string,
  head: Uint8Array,
): string {
  const sniffed = sniffImageMime(head)
  if (sniffed) return sniffed
  const actual = headerContentType?.split(';')[0]?.trim().toLowerCase()
  if (actual && actual.startsWith('image/')) return actual
  return current
}
