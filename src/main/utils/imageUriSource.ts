/**
 * 「复制图片」「另存为」两个 IPC 的取字节入口:把渲染端递来的各种图片地址,
 * 统一成「本地路径」或「内存里的字节」。
 *
 * 为什么要有这一层 —— 之前 `shell:copy-image` / `shell:save-as` 都是
 * `uri.startsWith('file://') ? fileURLToPath(uri) : uri`,等于**只认 file:// 和裸路径**:
 *  - 渲染端自己生成的规范本地地址是 `local-file:///C:/…`(见 renderer `toRenderableUri`),
 *    原样当路径喂给 `copyFile` / `nativeImage.createFromPath` → ENOENT,
 *    返回 `{ success:false }`,而缩略图上的「下载」按钮不看返回值 —— **点了没反应**;
 *  - 生成图成品在 R2 / COS 上(https),同样当路径读 → 同样没反应;
 *  - 助手 markdown 里嵌的图、`data:` 图更没有入口。
 * 这和 openai/codex#33798(「下载按钮点了没有任何反应」)是同一类症状。
 *
 * 依赖(fetch / 平台)用注入,单测不用起 Electron、不用真联网。
 */
import { fileURLToPath } from 'node:url'
import { resolveOsPathFromRequest } from '../file-explorer/protocolHandler'

/** 远程图字节上限。比任何一张出图都大,又不至于让一个坏链接把内存吃满。 */
export const MAX_REMOTE_IMAGE_BYTES = 64 * 1024 * 1024

export type ImageSource =
  | { kind: 'path'; path: string }
  | { kind: 'http'; url: string }
  | { kind: 'data'; bytes: Buffer; mime: string }

export type ParseResult = { ok: true; source: ImageSource } | { ok: false; error: string }

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+)(?:;[a-z0-9=._-]+)*;base64,([\s\S]*)$/i

/** 只看形态,不碰磁盘 / 网络。 */
export function parseImageUri(uri: unknown, platform: NodeJS.Platform = process.platform): ParseResult {
  if (typeof uri !== 'string' || uri.length === 0) return { ok: false, error: '图片地址为空' }

  const data = DATA_IMAGE.exec(uri)
  if (data) {
    const bytes = Buffer.from(data[2], 'base64')
    if (bytes.length === 0) return { ok: false, error: 'data: 图片没有内容' }
    return { ok: true, source: { kind: 'data', bytes, mime: data[1].toLowerCase() } }
  }
  if (/^data:/i.test(uri)) return { ok: false, error: '只支持 base64 编码的 data: 图片' }

  if (/^https?:\/\//i.test(uri)) return { ok: true, source: { kind: 'http', url: uri } }

  // blob: 只活在渲染进程里,主进程读不到 —— 调用方要传原始地址,不是显示用的 blob。
  if (/^blob:/i.test(uri)) return { ok: false, error: 'blob: 地址只在渲染进程有效,请传图片的原始地址' }

  if (/^local-file:\/\//i.test(uri)) {
    const resolved = resolveOsPathFromRequest(uri, platform)
    return resolved.ok
      ? { ok: true, source: { kind: 'path', path: resolved.path } }
      : { ok: false, error: '本地图片路径不合法' }
  }

  if (/^file:\/\//i.test(uri)) {
    try {
      return { ok: true, source: { kind: 'path', path: fileURLToPath(uri) } }
    } catch {
      return { ok: false, error: '本地图片路径不合法' }
    }
  }

  // 裸路径:Windows 盘符 / UNC / POSIX 绝对路径。
  if (/^[A-Za-z]:[\\/]/.test(uri) || uri.startsWith('\\\\') || uri.startsWith('/')) {
    return { ok: true, source: { kind: 'path', path: uri } }
  }
  return { ok: false, error: '不认识的图片地址' }
}

export interface FetchLike {
  (url: string): Promise<{
    ok: boolean
    status: number
    headers: { get(name: string): string | null }
    arrayBuffer(): Promise<ArrayBuffer>
  }>
}

export type BytesResult = { ok: true; bytes: Buffer; mime?: string } | { ok: false; error: string }

/**
 * 把 `http` / `data` 来源读成字节。`path` 来源不在这里读(调用方有更合适的 API:
 * `nativeImage.createFromPath` / `fs.copyFile`,不必把整张图过一遍 JS 堆)。
 */
export async function readRemoteOrInlineBytes(
  source: Exclude<ImageSource, { kind: 'path' }>,
  deps: { fetch: FetchLike; maxBytes?: number },
): Promise<BytesResult> {
  if (source.kind === 'data') return { ok: true, bytes: source.bytes, mime: source.mime }

  const maxBytes = deps.maxBytes ?? MAX_REMOTE_IMAGE_BYTES
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await deps.fetch(source.url)
  } catch (err) {
    return { ok: false, error: `下载图片失败:${err instanceof Error ? err.message : String(err)}` }
  }
  if (!res.ok) return { ok: false, error: `下载图片失败:HTTP ${res.status}` }

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, error: '文件太大,已放弃下载' }
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) return { ok: false, error: '文件太大,已放弃下载' }
  const mime = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  return { ok: true, bytes: buf, mime: mime || undefined }
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
}

/**
 * 另存为的默认文件名:名字里已经有扩展名就原样用;没有(比如链接最后一段是 `0`)
 * 就按 mime 补一个,免得存出一个系统不认识的无扩展名文件。
 */
export function suggestImageFileName(name: string, mime?: string): string {
  const base = (name || 'image').replace(/[\\/:*?"<>|]+/g, '_')
  if (/\.[A-Za-z0-9]{2,5}$/.test(base)) return base
  const ext = mime ? EXT_BY_MIME[mime.toLowerCase()] : undefined
  return ext ? base + ext : base
}

export type OpResult = { success: true; path?: string; canceled?: true } | { success: false; error: string }

/** 只用到 NativeImage 的这几个方法,单测里用假对象即可。 */
export interface DecodedImage {
  isEmpty(): boolean
  toPNG(): Uint8Array
}

export interface CopyImageDeps {
  fetch: FetchLike
  platform?: NodeJS.Platform
  createFromPath(path: string): DecodedImage
  createFromBuffer(bytes: Buffer): DecodedImage
  /** 写剪贴板;空图返回 false。 */
  writeImage(image: DecodedImage): Promise<boolean>
}

/** `shell:copy-image` 的全部逻辑。 */
export async function copyImageUri(uri: unknown, deps: CopyImageDeps): Promise<OpResult> {
  const parsed = parseImageUri(uri, deps.platform)
  if (!parsed.ok) return { success: false, error: parsed.error }

  let image: DecodedImage
  if (parsed.source.kind === 'path') {
    image = deps.createFromPath(parsed.source.path)
  } else {
    const bytes = await readRemoteOrInlineBytes(parsed.source, { fetch: deps.fetch })
    if (!bytes.ok) return { success: false, error: bytes.error }
    image = deps.createFromBuffer(bytes.bytes)
  }
  if (image.isEmpty()) return { success: false, error: 'unable to load image' }
  const written = await deps.writeImage(image)
  return written ? { success: true } : { success: false, error: 'unable to load image' }
}

export interface SaveImageDeps {
  fetch: FetchLike
  platform?: NodeJS.Platform
  /** 弹「另存为」框;取消返回 null。 */
  pickSavePath(defaultName: string): Promise<string | null>
  copyFile(from: string, to: string): Promise<void>
  writeFile(to: string, bytes: Buffer): Promise<void>
  /** 路径来源的默认文件名取 basename。 */
  basename(p: string): string
}

/** `shell:save-as` 的全部逻辑。 */
export async function saveImageUri(uri: unknown, suggestedName: string | undefined, deps: SaveImageDeps): Promise<OpResult> {
  const parsed = parseImageUri(uri, deps.platform)
  if (!parsed.ok) return { success: false, error: parsed.error }

  if (parsed.source.kind === 'path') {
    const target = await deps.pickSavePath(suggestedName || deps.basename(parsed.source.path))
    if (!target) return { success: true, canceled: true }
    await deps.copyFile(parsed.source.path, target)
    return { success: true, path: target }
  }

  // 先取字节、再弹框:下载失败时直接报错,不要让用户先选了位置才发现存不了。
  const bytes = await readRemoteOrInlineBytes(parsed.source, { fetch: deps.fetch })
  if (!bytes.ok) return { success: false, error: bytes.error }
  const target = await deps.pickSavePath(suggestImageFileName(suggestedName || 'image', bytes.mime))
  if (!target) return { success: true, canceled: true }
  await deps.writeFile(target, bytes.bytes)
  return { success: true, path: target }
}

