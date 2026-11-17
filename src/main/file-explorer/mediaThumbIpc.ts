import { ipcMain, nativeImage, net } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { checkRemoteImageUrl } from '../utils/remoteImageGuard'
import { parseImageUri, readRemoteOrInlineBytes, type FetchLike } from '../utils/imageUriSource'
import {
  ALLOWED_MIME_BY_EXT,
  hasTraversalSegment,
  isImageMime,
  isVideoMime,
  mimeFromExt,
} from './mediaPathValidation'
import { createByteLru, createLimiter } from './thumbScheduling'
import { grabVideoFrame } from './videoFrame'

/**
 * `media:thumb` — resized-thumbnail IPC dedicated to the renderer hot path
 * (chat composer drops, reference chips, attachment cards, file-explorer
 * previews). Designed to replace `attachments:read-thumb` for thumbnail use
 * cases; the original full-fidelity IPC stays for lightbox / download flows
 * via `useResolvedMediaSrc(src, hint, { fullFidelity: true })`.
 *
 * Why this exists — see openspec/changes/fix-codex-chat-image-attachment-lag
 * for the full diagnosis. TL;DR: dropping a 5–20 MB phone photo into the
 * Codex chat used to:
 *   1. fully read the file in main,
 *   2. base64-encode it (≈1.33× bloat),
 *   3. `structuredClone` it across the IPC boundary,
 *   4. atob + Blob + URL.createObjectURL on the renderer side.
 * Every step is on the main thread. With this IPC the main process resizes
 * once and ships a 5–30 KB JPEG, so the renderer's hot path shrinks by
 * roughly 100×.
 *
 * Security surface is identical to `attachments:read-thumb` (mime+ext
 * whitelist, traversal check, size cap, realpath) — both ship from the same
 * `mediaPathValidation` primitives so the two channels can't drift.
 */

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const DEFAULT_THUMB_SIZE = 256

export type MediaThumbResult =
  | {
      ok: true
      base64: string
      mime: string
      width?: number
      height?: number
    }
  | { ok: false; reason: string }

export interface MediaThumbArgs {
  /** 本地文件路径。与 `url` 二选一;两个都给时只认 `path`。 */
  path?: string
  /**
   * 远程图或内联图:`https://…` 或 `data:image/…;base64,…`。主进程自己取字节、缩成缩略图,
   * 渲染端从头到尾拿不到(也不必解码)那张原图。其它写法(`http:`、本地路径、内网地址)一律拒绝 ——
   * 本地文件只能走 `path`,那条路有自己的白名单。
   */
  url?: string
  /** Longest edge in CSS pixels. Default 256. Capped at 1024 to avoid the
   *  "thumbnail" channel being abused as a backdoor for full-res reads. */
  size?: number
  /** Output mime. Only `image/jpeg` is supported in PR-A; future PRs may
   *  add `image/webp` for transparency-preserving thumbnails. */
  targetMime?: 'image/jpeg'
}

const MAX_THUMB_SIZE = 1024

/**
 * SVG passthrough: we don't rasterize because (1) SVGs are typically <50 KB
 * already so the optimization is unnecessary, and (2) rasterizing loses the
 * vector representation which the renderer can scale freely.
 */
async function readSvgPassthrough(realPath: string): Promise<MediaThumbResult> {
  const buf = await fs.readFile(realPath)
  return { ok: true, base64: buf.toString('base64'), mime: 'image/svg+xml' }
}

/**
 * Electron's OS-native thumbnail provider. On macOS this uses Quick Look; on
 * Windows it uses the Shell IThumbnailProvider that File Explorer itself uses.
 * It is the only way to thumbnail formats sharp cannot decode (BMP, ICO, …)
 * and the only video-still source that needs no ffmpeg spawn, so it is the
 * fallback for images and the first choice for videos. For freshly written
 * images (nothing in the OS cache) it is slower than sharp and its `toJPEG`
 * runs on the main thread — see {@link imageThumb}.
 *
 * Returns null on:
 *   - empty NativeImage (Linux + most Windows cases without a registered
 *     IThumbnailProvider for the extension)
 *   - thrown error (macOS error path for unreadable inputs)
 */
async function tryNativeThumb(
  realPath: string,
  size: number,
): Promise<{ buf: Buffer; width: number; height: number } | null> {
  try {
    const img = await nativeImage.createThumbnailFromPath(realPath, {
      width: size,
      height: size,
    })
    if (!img || img.isEmpty()) return null
    const buf = img.toJPEG(78)
    if (!buf || buf.length === 0) return null
    const dims = img.getSize()
    return { buf, width: dims.width, height: dims.height }
  } catch {
    return null
  }
}

async function sharpThumb(
  input: string | Buffer,
  size: number,
): Promise<{ buf: Buffer; width: number; height: number }> {
  const pipeline = sharp(input, { failOn: 'none' })
    .rotate() // honor EXIF orientation
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
  const { data, info } = await pipeline
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return { buf: data, width: info.width, height: info.height }
}

/**
 * 视频缩略图:先问系统(Windows 资源管理器同款的缩略图提供者,已缓存时几乎零成本),
 * 拿不到再用自带 ffmpeg 截一帧。两条都失败时的 reason 仍含 `video`,
 * 渲染层据此决定要不要退回别的显示方式。
 */
async function videoThumb(realPath: string, size: number): Promise<MediaThumbResult> {
  const fromNative = await tryNativeThumb(realPath, size)
  if (fromNative) {
    return {
      ok: true,
      base64: fromNative.buf.toString('base64'),
      mime: 'image/jpeg',
      width: fromNative.width,
      height: fromNative.height,
    }
  }
  const frame = await grabVideoFrame(realPath, size)
  if (!frame) return { ok: false, reason: 'video frame extraction failed' }
  const meta = await sharp(frame, { failOn: 'none' })
    .metadata()
    .catch(() => null)
  return {
    ok: true,
    base64: frame.toString('base64'),
    mime: 'image/jpeg',
    ...(meta?.width ? { width: meta.width } : {}),
    ...(meta?.height ? { height: meta.height } : {}),
  }
}

/** 渲染端传来的尺寸收敛到安全范围;调用方通常传 64/128/256/512。 */
function clampThumbSize(size: unknown): number {
  return typeof size === 'number' && Number.isFinite(size) && size > 0
    ? Math.min(Math.floor(size), MAX_THUMB_SIZE)
    : DEFAULT_THUMB_SIZE
}

/** 测试可以换掉取网络的实现;生产用 Chromium 网络栈(走系统代理 / 证书),并给整次请求设上限。 */
export interface MediaThumbDeps {
  fetch?: FetchLike
}

export async function handleMediaThumb(
  args: MediaThumbArgs,
  deps: MediaThumbDeps = {},
): Promise<MediaThumbResult> {
  const hasPath = !!args && typeof args.path === 'string' && args.path.length > 0
  // 没有本地路径、但给了远程 / 内联地址:走远程分支。有路径就只认路径(各走各的白名单,
  // 不能让 `url` 变成绕过路径检查的后门 —— 远程分支只接受 https 与 data:image)。
  if (!hasPath && !!args && typeof args.url === 'string' && args.url.length > 0) {
    return handleUrlThumb(args.url, clampThumbSize(args.size), deps)
  }
  if (!hasPath) {
    return { ok: false, reason: 'whitelist: empty path' }
  }
  const argPath = args.path as string
  if (hasTraversalSegment(argPath)) {
    return { ok: false, reason: 'traversal segment in path' }
  }
  const mime = mimeFromExt(argPath)
  if (!mime) {
    return { ok: false, reason: 'mime whitelist: extension not allowed' }
  }
  const requestedSize = clampThumbSize(args.size)

  let realPath: string
  try {
    realPath = await fs.realpath(argPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { ok: false, reason: 'file not found' }
    return { ok: false, reason: `realpath failed: ${String(err)}` }
  }

  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(realPath)
  } catch (err) {
    return { ok: false, reason: `stat failed: ${String(err)}` }
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'not a regular file' }
  }

  // 视频只截一帧、不读整个文件,所以不受体积上限约束(成片动辄几百 MB)。
  if (isVideoMime(mime)) {
    return scheduleThumb(realPath, stat, requestedSize, () => videoThumb(realPath, requestedSize))
  }

  if (stat.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: `size whitelist: ${stat.size} bytes exceeds ${MAX_ATTACHMENT_BYTES} cap`,
    }
  }

  // SVG → passthrough (already small, lossless wins matter).
  if (mime === 'image/svg+xml') {
    return readSvgPassthrough(realPath)
  }

  if (!isImageMime(mime)) {
    // Audio (mp3, wav, etc.) — no point thumbnailing.
    return { ok: false, reason: 'no thumbnail for non-image mime' }
  }

  return scheduleThumb(realPath, stat, requestedSize, () => imageThumb(realPath, requestedSize))
}

/**
 * 图片缩略图:**先 sharp,sharp 解不了(BMP / ICO 等)再问系统提供者**。
 *
 * 之前是系统提供者在前。量测(60 张全新的 2336px JPEG):系统提供者共 1.8 s,且每张的
 * `toJPEG` 都在主线程上(一起发时事件循环停 1.5 s);sharp 共 0.9 s,全部在线程池里,
 * 事件循环最长只停 24 ms。系统缓存「已命中」才是它更快的场景,而聊天里的生成图
 * 都是刚写下来的新文件,几乎不命中。
 */
async function imageThumb(realPath: string, size: number): Promise<MediaThumbResult> {
  let sharpErr: unknown
  try {
    const { buf, width, height } = await sharpThumb(realPath, size)
    return { ok: true, base64: buf.toString('base64'), mime: 'image/jpeg', width, height }
  } catch (err) {
    sharpErr = err
  }
  const fromNative = await tryNativeThumb(realPath, size)
  if (fromNative) {
    return {
      ok: true,
      base64: fromNative.buf.toString('base64'),
      mime: 'image/jpeg',
      width: fromNative.width,
      height: fromNative.height,
    }
  }
  return { ok: false, reason: `thumbnail failed: ${String(sharpErr)}` }
}

/** 同时最多生成这么多张;其余排队。见 `thumbScheduling.ts` 顶部的量测。 */
export const THUMB_CONCURRENCY = 4
/** 缩略图结果缓存的总字节预算(base64 字符数 ≈ 字节数);一张通常 5–30 KB,够几千张。 */
export const THUMB_CACHE_MAX_BYTES = 32 * 1024 * 1024

/**
 * 远程 / 内联图的并发闸,和本地的分开:远程那条的耗时主要在等网络,放进同一个闸里,
 * 几张慢链接就会把本地缩略图(读盘 + sharp,几十毫秒)堵在后面。
 */
export const REMOTE_THUMB_CONCURRENCY = 4
/** 远程原图字节上限(比任何一张出图都大,又不会让一个坏链接吃满内存)。 */
export const MAX_REMOTE_THUMB_SOURCE_BYTES = 40 * 1024 * 1024
/** 抓一张远程图的总时限(含读完 body)。 */
export const REMOTE_THUMB_FETCH_TIMEOUT_MS = 30_000

const runLimited = createLimiter(THUMB_CONCURRENCY)
const runRemoteLimited = createLimiter(REMOTE_THUMB_CONCURRENCY)
const thumbCache = createByteLru<Extract<MediaThumbResult, { ok: true }>>(THUMB_CACHE_MAX_BYTES)
const pendingThumbs = new Map<string, Promise<MediaThumbResult>>()

/** 测试用:清掉缓存与排队中的去重表,避免用例之间互相影响。 */
export function resetThumbCacheForTest(): void {
  thumbCache.clear()
  pendingThumbs.clear()
}

/**
 * 缓存 → 同一张图的在途请求合并 → 限并发地真正生成。
 * 只缓存成功结果:失败(文件还没写完、暂时读不到、网络抖了一下)下次要能重试。
 */
function scheduleByKey(
  key: string,
  limit: <T>(task: () => Promise<T>) => Promise<T>,
  build: () => Promise<MediaThumbResult>,
): Promise<MediaThumbResult> {
  const hit = thumbCache.get(key)
  if (hit) return Promise.resolve(hit)
  const inflight = pendingThumbs.get(key)
  if (inflight) return inflight

  const p = limit(build)
    .then((res) => {
      if (res.ok) thumbCache.set(key, res, res.base64.length)
      return res
    })
    .finally(() => {
      pendingThumbs.delete(key)
    })
  pendingThumbs.set(key, p)
  return p
}

function scheduleThumb(
  realPath: string,
  stat: import('node:fs').Stats,
  size: number,
  build: () => Promise<MediaThumbResult>,
): Promise<MediaThumbResult> {
  return scheduleByKey(`${realPath}\0${stat.mtimeMs}\0${stat.size}\0${size}`, runLimited, build)
}

/** 默认的取网络实现:Chromium 网络栈(系统代理 / 证书),整次请求(含 body)限时。 */
const defaultRemoteFetch: FetchLike = (url) =>
  net.fetch(url, { signal: AbortSignal.timeout(REMOTE_THUMB_FETCH_TIMEOUT_MS) })

/**
 * 把一张远程 / 内联图缩成缩略图 —— 渲染端只会拿到几 KB 的结果,从不加载原图。
 *
 * 为什么要主进程来做:数据万象的缩略参数只能拼在**自家 COS 的裸链接**上;带签名的直出链接
 * (拼参数会让签名失效)和别家的 CDN 都没法在服务端缩小,交给 `<img>` 就是把整张原图
 * 下载、解码进一个 80px 的框里(真窗口量测:240 张 2336px 原图当缩略图,快速滚动丢掉
 * 1.9–2.7 s)。这里下载一次、sharp 缩小、按地址缓存,同一张图再出现不再下载。
 *
 * 只收 `https://`(过 `checkRemoteImageUrl`)和 `data:image/…;base64`。
 */
async function handleUrlThumb(url: string, size: number, deps: MediaThumbDeps): Promise<MediaThumbResult> {
  const parsed = parseImageUri(url)
  if (!parsed.ok) return { ok: false, reason: `url: ${parsed.error}` }
  const source = parsed.source
  if (source.kind === 'path') return { ok: false, reason: 'url: local paths must use `path`' }
  if (source.kind === 'http') {
    const guard = checkRemoteImageUrl(source.url)
    if (!guard.ok) return { ok: false, reason: `url: ${guard.reason}` }
  }
  const fetchImpl = deps.fetch ?? defaultRemoteFetch

  const build = async (): Promise<MediaThumbResult> => {
    const got = await readRemoteOrInlineBytes(source, { fetch: fetchImpl, maxBytes: MAX_REMOTE_THUMB_SOURCE_BYTES })
    if (!got.ok) return { ok: false, reason: `url: ${got.error}` }
    if (got.bytes.length > MAX_REMOTE_THUMB_SOURCE_BYTES) return { ok: false, reason: 'url: source too large' }
    try {
      const built = await remoteSharpThumb(got.bytes, size)
      return { ok: true, base64: built.buf.toString('base64'), mime: built.mime, width: built.width, height: built.height }
    } catch (err) {
      return { ok: false, reason: `url: thumbnail failed: ${String(err)}` }
    }
  }

  // 内联图不进缓存:渲染端的共享 blob 缓存已经按它的内容键去重,而且给几 MB 的字符串再算一遍哈希不划算。
  if (source.kind === 'data') return runRemoteLimited(build)
  return scheduleByKey(`url\0${source.url}\0${size}`, runRemoteLimited, build)
}

/**
 * 远程图的缩小:不透明的出 JPEG(最小),带透明通道的出 WebP —— 否则透明 PNG 会被拍成黑底。
 * (本地路径那条仍是 JPEG,行为没动。)
 */
async function remoteSharpThumb(
  input: Buffer,
  size: number,
): Promise<{ buf: Buffer; mime: string; width: number; height: number }> {
  const meta = await sharp(input, { failOn: 'none' }).metadata()
  const resized = sharp(input, { failOn: 'none' })
    .rotate() // honor EXIF orientation
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
  const out = meta.hasAlpha
    ? await resized.webp({ quality: 80 }).toBuffer({ resolveWithObject: true })
    : await resized.jpeg({ quality: 78, mozjpeg: true }).toBuffer({ resolveWithObject: true })
  return {
    buf: out.data,
    mime: meta.hasAlpha ? 'image/webp' : 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
  }
}

export function registerMediaThumbIpc(): void {
  ipcMain.handle(
    'media:thumb',
    (_event, rawArgs: MediaThumbArgs) =>
      handleMediaThumb({
        ...rawArgs,
        // 空串不能交给 normalize(它会变成 '.'),否则「只给 url」的调用会被当成一个路径。
        path: typeof rawArgs?.path === 'string' && rawArgs.path.length > 0 ? path.normalize(rawArgs.path) : '',
      }),
  )
}

// Re-export the shared whitelist constant so callers wiring up other
// helpers (e.g. preload bridge typing) don't have to import the validation
// module separately.
export { ALLOWED_MIME_BY_EXT }
