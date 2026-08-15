import { toRenderableUri, toStreamableUri } from '../../file-explorer/uri'

/**
 * Canvas media must NEVER travel as base64 through IPC or sit as `data:` URLs
 * in the tldraw store / IndexedDB. That path is what OOM-crashes the renderer
 * and makes Electron relaunch the app in a loop when the canvas tab opens.
 *
 * Same contract as the file-explorer / video-workbench viewers:
 *   - images → `local-file:///D%3A/...` (`toRenderableUri`)
 *   - video/audio → `local-file://media/?p=...` (`toStreamableUri`, Range + stream)
 * Bytes stay on disk; Chromium streams them. See protocolHandler.ts.
 */

const VIDEO_OR_AUDIO_EXT = /\.(mp4|webm|mov|m4v|mkv|ogg|ogv|mp3|wav|m4a|aac|flac|opus|oga|weba)$/i

/** A `data:` src longer than this is treated as leaked file bytes, not a tiny icon. */
export const CANVAS_INLINE_ASSET_MAX_CHARS = 10_000

export function toCanvasAssetUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return pathOrUrl
  if (
    pathOrUrl.startsWith('data:') ||
    pathOrUrl.startsWith('blob:') ||
    pathOrUrl.startsWith('http://') ||
    pathOrUrl.startsWith('https://') ||
    pathOrUrl.startsWith('local-file://')
  ) {
    return pathOrUrl
  }
  if (VIDEO_OR_AUDIO_EXT.test(pathOrUrl)) return toStreamableUri(pathOrUrl)
  return toRenderableUri(pathOrUrl)
}

/**
 * Inverse of `toCanvasAssetUrl`: recover the OS path from a canvas asset URL so
 * `get_canvas_video` / `get_canvas_image` can hand the agent an openable path
 * without exporting the bytes back out. Returns null for anything that is not
 * one of our own local-file URLs, and for `..` traversal (mirrors the
 * main-process protocol gate rather than trusting the store).
 */
export function osPathFromCanvasAssetUrl(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('local-file://')) return null
  let decoded: string
  const mediaPrefix = 'local-file://media/?p='
  if (url.startsWith(mediaPrefix)) {
    decoded = safeDecode(url.slice(mediaPrefix.length))
  } else {
    const filePrefix = 'local-file:///'
    if (!url.startsWith(filePrefix)) return null
    decoded = safeDecode(url.slice(filePrefix.length))
  }
  if (!decoded) return null
  if (decoded.split(/[\\/]/).some((seg) => seg === '..')) return null
  return decoded
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

function rewriteAssetSrc(src: unknown, assetPath: unknown): string | null {
  if (typeof src !== 'string') return null
  if (!src.startsWith('data:') || src.length <= CANVAS_INLINE_ASSET_MAX_CHARS) return src
  if (typeof assetPath === 'string' && assetPath) return toCanvasAssetUrl(assetPath)
  return ''
}

/**
 * Clone a tldraw `getSnapshot()` payload and strip inline `data:` bytes from
 * asset records. Used before `canvas:save-checkpoint` crosses IPC — otherwise
 * the structured-clone copy of a multi-MB snapshot lives in BOTH processes.
 */
export function stripSnapshotAssetBytes<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const cloned = structuredClone(snapshot) as {
    document?: { store?: Record<string, unknown> }
    store?: Record<string, unknown>
  }
  const store = cloned.document?.store ?? cloned.store
  if (!store || typeof store !== 'object') return cloned as T
  for (const rec of Object.values(store)) {
    if (!rec || typeof rec !== 'object') continue
    const record = rec as {
      typeName?: string
      props?: { src?: unknown }
      meta?: { assetPath?: unknown }
    }
    if (record.typeName !== 'asset' || !record.props) continue
    const next = rewriteAssetSrc(record.props.src, record.meta?.assetPath)
    if (next !== null) record.props.src = next
  }
  return cloned as T
}
