import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * `attachments:read-thumb` — bytes-for-display IPC dedicated to the
 * thumbnail/lightbox rendering path. Deliberately separate from
 * `fs:read-binary` because the two have **different security models**:
 *
 *   - `fs:read-binary` is a *workspace* file API. Its allowed-roots gate is
 *     the right thing for codex tools, the file-explorer panel, and any
 *     "agent reads code" use case — we do not want a compromised renderer
 *     pulling `~/.ssh/id_rsa` through it.
 *
 *   - `attachments:read-thumb` exists so the renderer can paint a preview
 *     of a file the **user already chose** (drag-drop / file-picker /
 *     uploads cache). At that point the file path is user-asserted and the
 *     sandbox concern is "can someone smuggle a non-media path through this
 *     channel and exfiltrate its bytes". We mitigate that two ways:
 *
 *       1. **Mime whitelist** — only image/video/audio extensions accepted.
 *          A path to `~/.ssh/id_rsa` (no extension) is rejected before any
 *          disk read happens.
 *
 *       2. **Size cap** — the same 100 MB limit AttachmentService enforces.
 *          Larger files are refused so a malicious renderer can't probe
 *          arbitrarily large disk areas through this channel.
 *
 * This mirrors the model VSCode uses for non-file-scheme images
 * (microsoft/vscode#209453 "Image preview could support non-file schemes")
 * and Copilot SDK's blob-attachment shape: dedicated channel, narrow surface.
 */

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

const ALLOWED_MIME_BY_EXT: Record<string, string> = {
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

function mimeFromExt(p: string): string | undefined {
  const dot = p.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = p.slice(dot + 1).toLowerCase()
  return ALLOWED_MIME_BY_EXT[ext]
}

function hasTraversalSegment(p: string): boolean {
  return p.split(/[\\/]/).some((segment) => segment === '..')
}

export type ReadThumbResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; reason: string }

export async function handleReadThumb(p: string): Promise<ReadThumbResult> {
  if (typeof p !== 'string' || p.length === 0) {
    return { ok: false, reason: 'whitelist: empty path' }
  }
  if (hasTraversalSegment(p)) {
    return { ok: false, reason: 'traversal segment in path' }
  }
  const mime = mimeFromExt(p)
  if (!mime) {
    return { ok: false, reason: 'mime whitelist: extension not allowed' }
  }
  let realPath: string
  try {
    realPath = await fs.realpath(p)
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
  let buf: Buffer
  try {
    buf = await fs.readFile(realPath)
  } catch (err) {
    return { ok: false, reason: `readFile failed: ${String(err)}` }
  }
  return { ok: true, base64: buf.toString('base64'), mime }
}

export function registerAttachmentsThumbIpc(): void {
  ipcMain.handle('attachments:read-thumb', (_event, rawPath: string) => {
    return handleReadThumb(typeof rawPath === 'string' ? path.normalize(rawPath) : '')
  })
}
