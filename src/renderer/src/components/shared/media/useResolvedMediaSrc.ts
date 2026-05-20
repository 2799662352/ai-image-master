/**
 * useResolvedMediaSrc — turn a media URI into something Chromium will load.
 *
 * **Why this is its own module** — every renderer surface that displays a
 * user-attached file (chat thumbnail, lightbox big-image, file-explorer
 * reference preview) must agree on the same resolution strategy, otherwise
 * one surface works while the others render broken-image icons. Centralising
 * the logic here is the same pattern VSCode took with its
 * `IChatImageCarouselService` (microsoft/vscode#301587) and Copilot SDK takes
 * with its `blob attachment` shape (github/copilot-sdk image-input.md).
 *
 * **Why we don't use `local-file://` directly** — in Electron 38 + dev mode
 * the renderer's URL parser will not recognise a custom scheme as standard
 * even after `registerSchemesAsPrivileged` succeeds in the main process;
 * `fetch(src)` throws `TypeError: Failed to parse URL` and `<img>` emits a
 * GET with the Windows drive letter stripped (`local-file://users/27996/...`
 * instead of `local-file:///C:/Users/27996/...`). This is the root cause
 * tracked at electron/electron#49073 — Chromium's standard-scheme parsing
 * does not have the Windows-drive-letter handler that `file://` does, so
 * `%3A` collapses and the GET reaches the protocol handler with a broken
 * path. The `bypassCustomProtocolHandlers` workaround mentioned in that
 * issue only fixes the recursion case, not the drive-letter mangling.
 *
 * **What we do instead** — pull the file bytes through a dedicated IPC
 * (`attachments:read-thumb`) which lives in the main process and has full
 * disk access, then hand the renderer a `blob:` URL. `blob:` URLs have no
 * scheme-registration gotchas and survive every Chromium parser unchanged.
 * This is the same path VSCode took for non-file schemes (vscode#209453,
 * PR #209458 "Load images in a data uri for image preview").
 *
 * **Passthrough** for `http(s)://`, `blob:`, `data:`, and `file://` — those
 * all work natively from the renderer without IPC.
 */

import { useEffect, useState } from 'react'

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

const VIDEO_EXT_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
}

export type MediaKindHint = 'image' | 'video' | 'auto'

function guessMimeFromPath(osPath: string, hint: MediaKindHint): string {
  const dot = osPath.lastIndexOf('.')
  const ext = dot >= 0 ? osPath.slice(dot + 1).toLowerCase() : ''
  if (hint !== 'video' && IMAGE_EXT_TO_MIME[ext]) return IMAGE_EXT_TO_MIME[ext]
  if (hint !== 'image' && VIDEO_EXT_TO_MIME[ext]) return VIDEO_EXT_TO_MIME[ext]
  if (hint === 'image') return 'image/*'
  if (hint === 'video') return 'video/*'
  return 'application/octet-stream'
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new ArrayBuffer(bin.length)
  const view = new Uint8Array(out)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return out
}

/**
 * Resolve any "local file-ish" src to an OS path that the main process can
 * read. Accepts three shapes the renderer might receive:
 *
 *   1. `local-file:///D%3A/foo/bar.png` — the canonical form produced by
 *      `toRenderableUri`. We strip the prefix and percent-decode.
 *
 *   2. `D:\foo\bar.png` or `D:/foo/bar.png` — raw Windows path. This is
 *      what `buildAttachmentUri` returns when the renderer only has a
 *      file path (no buffer), i.e. the path produced by the user dropping
 *      a file from `D:\360MoveData\...` before AttachmentService has
 *      copied it into the uploads cache.
 *
 *   3. `/home/user/foo.png` — raw POSIX absolute path. Same scenario as
 *      above on macOS/Linux.
 *
 * Returns null for traversal segments and for shapes that should go
 * straight to the renderer (`http(s)://`, `blob:`, `data:`, `file://`).
 *
 * Pure string ops — does **not** call `new URL()` because in the renderer
 * `local-file` is not parseable as a standard scheme (see module docstring).
 */
function toOsPathIfLocal(src: string): string | null {
  if (src.startsWith('local-file://')) {
    const prefix = 'local-file:///'
    if (!src.startsWith(prefix)) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(src.slice(prefix.length))
    } catch {
      return null
    }
    if (decoded.includes('..')) return null
    if (/^[A-Za-z]:[\\/]/.test(decoded)) return decoded
    return '/' + decoded
  }
  // Raw Windows path: `D:\foo`, `D:/foo`, `\\server\share\foo` (UNC).
  if (/^[A-Za-z]:[\\/]/.test(src)) return src
  // Raw POSIX absolute path.
  if (src.startsWith('/') && !src.startsWith('//')) return src
  return null
}

interface AttachmentsApi {
  readThumb: (
    p: string,
  ) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }>
}

interface FsApi {
  readBinary: (
    p: string,
  ) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }>
}

function getAttachmentsApi(): AttachmentsApi | null {
  const api = (globalThis as unknown as { electronAPI?: { attachments?: AttachmentsApi } })
    .electronAPI
  return api?.attachments ?? null
}

function getFsApi(): FsApi | null {
  const api = (globalThis as unknown as { electronAPI?: { fs?: FsApi } }).electronAPI
  return api?.fs ?? null
}

/**
 * Read file bytes from disk for thumbnail/lightbox rendering.
 *
 * Tries the dedicated `attachments:read-thumb` IPC first (no sandbox roots,
 * mime+size whitelist). Falls back to `fs:read-binary` (workspace + uploads
 * roots only) so we don't regress paths that used to work. If both fail,
 * resolves to null and the component renders a broken-image placeholder.
 */
async function readBytes(
  osPath: string,
): Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }> {
  const attachments = getAttachmentsApi()
  if (attachments) {
    const res = await attachments.readThumb(osPath)
    if (res.ok) return res
    // Fall through to fs API only when the dedicated IPC says "not eligible"
    // (mime/size whitelist miss). Hard failures (file not found, EACCES)
    // propagate as-is so the caller sees the original cause.
    if (!/whitelist|size|mime/i.test(res.reason)) return res
  }
  const fs = getFsApi()
  if (fs) return fs.readBinary(osPath)
  return { ok: false, reason: 'no IPC available' }
}

/**
 * Resolve a media src to something Chromium will actually render.
 *
 * @param src   The source URI as supplied by the model (`local-file://`,
 *              `http(s)://`, `blob:`, `data:`, or `file://`).
 * @param hint  Used only to disambiguate ambiguous file extensions when the
 *              main-process mime probe returns `application/octet-stream`.
 *              Pass `'auto'` when you don't have a kind classification.
 *
 * Returns `null` while the byte read is in flight or after a failure so the
 * caller can decide whether to render a placeholder.
 */
function initialResolved(src: string): string | null {
  if (typeof src !== 'string' || src.length === 0) return null
  if (toOsPathIfLocal(src) === null) return src
  return null
}

export function useResolvedMediaSrc(src: string, hint: MediaKindHint = 'auto'): string | null {
  const [resolved, setResolved] = useState<string | null>(() => initialResolved(src))
  // React's official "Storing information from previous renders" pattern —
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  //
  // CRITICAL: when `src` changes (e.g. Lightbox navigates to the next image)
  // we must reset `resolved` SYNCHRONOUSLY in the render phase before the
  // next commit. Otherwise:
  //   1. React commits `<img src={oldBlobUrl}>` for the new render
  //   2. The useEffect cleanup runs and revokes oldBlobUrl
  //   3. The browser sees its `<img>` element pointing at a now-revoked
  //      blob: URL and reports `net::ERR_FILE_NOT_FOUND`
  // Setting state during render is legal (and the recommended fix) as long
  // as we gate on a real change — React will discard the in-progress render
  // and re-render with the new state before committing.
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setResolved(initialResolved(src))
  }

  useEffect(() => {
    if (typeof src !== 'string' || src.length === 0) {
      setResolved(null)
      return
    }
    const osPath = toOsPathIfLocal(src)
    if (osPath === null) {
      // Web URL / blob / data — Chromium loads these natively.
      setResolved(src)
      return
    }
    let cancelled = false
    let createdBlobUrl: string | null = null
    readBytes(osPath)
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          if (import.meta.env?.DEV) {
            // eslint-disable-next-line no-console
            console.warn('[useResolvedMediaSrc] read failed', { osPath, reason: res.reason })
          }
          setResolved(null)
          return
        }
        const mime =
          res.mime && res.mime !== 'application/octet-stream'
            ? res.mime
            : guessMimeFromPath(osPath, hint)
        const blob = new Blob([base64ToArrayBuffer(res.base64)], { type: mime })
        createdBlobUrl = URL.createObjectURL(blob)
        setResolved(createdBlobUrl)
      })
      .catch((err) => {
        if (cancelled) return
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[useResolvedMediaSrc] read threw', { osPath, err: String(err) })
        }
        setResolved(null)
      })
    return () => {
      cancelled = true
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl)
    }
  }, [src, hint])

  return resolved
}
