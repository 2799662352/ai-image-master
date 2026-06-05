/**
 * mediaPathValidation — shared whitelist + path-safety primitives consumed by
 * BOTH `attachments:read-thumb` (full-fidelity bytes, see attachmentsIpc.ts)
 * and `media:thumb` (resized thumbnail bytes, see mediaThumbIpc.ts).
 *
 * Keeping the whitelist + traversal check in one module guarantees that any
 * mime/extension we accept for thumbnail rendering is also accepted for
 * full-fidelity lightbox loading and vice versa — drift between the two would
 * mean a path passes one channel but is silently rejected by the other,
 * which is the kind of subtle behavior change that produces hard-to-repro
 * "image suddenly broken" bug reports.
 *
 * Pure functions only. No side effects, no `node:fs` access, no `electron`
 * imports — that lets the unit tests run on plain `node` without needing
 * electron's runtime.
 */

export const ALLOWED_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
}

export function mimeFromExt(p: string): string | undefined {
  if (typeof p !== 'string' || p.length === 0) return undefined
  const dot = p.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = p.slice(dot + 1).toLowerCase()
  return ALLOWED_MIME_BY_EXT[ext]
}

export function hasTraversalSegment(p: string): boolean {
  return p.split(/[\\/]/).some((segment) => segment === '..')
}

export function isImageMime(mime: string): boolean {
  return typeof mime === 'string' && mime.startsWith('image/')
}

export function isVideoMime(mime: string): boolean {
  return typeof mime === 'string' && mime.startsWith('video/')
}
