import { ipcMain, nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {
  ALLOWED_MIME_BY_EXT,
  hasTraversalSegment,
  isImageMime,
  isVideoMime,
  mimeFromExt,
} from './mediaPathValidation'

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
  path: string
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
 * Try Electron's OS-native thumbnail provider first. On macOS this uses
 * Quick Look; on Windows it uses the Shell IThumbnailProvider that File
 * Explorer itself uses. When the OS already has a thumbnail cached (common
 * for files the user has interacted with in File Explorer or Finder) this
 * is materially faster than sharp's decode-resize-encode round trip.
 *
 * Returns null on:
 *   - empty NativeImage (Linux + most Windows cases without a registered
 *     IThumbnailProvider for the extension)
 *   - thrown error (macOS error path for unreadable inputs)
 *
 * Caller falls back to sharp on null.
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
  realPath: string,
  size: number,
): Promise<{ buf: Buffer; width: number; height: number }> {
  const pipeline = sharp(realPath, { failOn: 'none' })
    .rotate() // honor EXIF orientation
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
  const { data, info } = await pipeline
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return { buf: data, width: info.width, height: info.height }
}

export async function handleMediaThumb(args: MediaThumbArgs): Promise<MediaThumbResult> {
  if (!args || typeof args.path !== 'string' || args.path.length === 0) {
    return { ok: false, reason: 'whitelist: empty path' }
  }
  if (hasTraversalSegment(args.path)) {
    return { ok: false, reason: 'traversal segment in path' }
  }
  const mime = mimeFromExt(args.path)
  if (!mime) {
    return { ok: false, reason: 'mime whitelist: extension not allowed' }
  }
  // Clamp size to a safe range. Renderer callers pass 64/128/256/512.
  const requestedSize =
    typeof args.size === 'number' && Number.isFinite(args.size) && args.size > 0
      ? Math.min(Math.floor(args.size), MAX_THUMB_SIZE)
      : DEFAULT_THUMB_SIZE

  let realPath: string
  try {
    realPath = await fs.realpath(args.path)
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

  // Video → no frame extraction in PR-A. Renderer paints a play-icon
  // placeholder via MediaThumbnail's video branch when this returns false.
  // Future PR-D (or piggyback on smartErase ffmpeg) can add real frame grab.
  if (isVideoMime(mime)) {
    return { ok: false, reason: 'video thumbnail not yet supported' }
  }
  if (!isImageMime(mime)) {
    // Audio (mp3, wav, etc.) — no point thumbnailing.
    return { ok: false, reason: 'no thumbnail for non-image mime' }
  }

  const fromNative = await tryNativeThumb(realPath, requestedSize)
  if (fromNative) {
    return {
      ok: true,
      base64: fromNative.buf.toString('base64'),
      mime: 'image/jpeg',
      width: fromNative.width,
      height: fromNative.height,
    }
  }

  try {
    const { buf, width, height } = await sharpThumb(realPath, requestedSize)
    return {
      ok: true,
      base64: buf.toString('base64'),
      mime: 'image/jpeg',
      width,
      height,
    }
  } catch (err) {
    return { ok: false, reason: `thumbnail failed: ${String(err)}` }
  }
}

export function registerMediaThumbIpc(): void {
  ipcMain.handle(
    'media:thumb',
    (_event, rawArgs: MediaThumbArgs) =>
      handleMediaThumb({
        ...rawArgs,
        path: typeof rawArgs?.path === 'string' ? path.normalize(rawArgs.path) : '',
      }),
  )
}

// Re-export the shared whitelist constant so callers wiring up other
// helpers (e.g. preload bridge typing) don't have to import the validation
// module separately.
export { ALLOWED_MIME_BY_EXT }
