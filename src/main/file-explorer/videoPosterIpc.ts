import { ipcMain, net } from 'electron'
import { uploadBufferToBucket } from '../services/tencent/cosClient'
import {
  ensureVideoPoster,
  type EnsureVideoPosterResult,
  type SnapshotResponse,
} from '../services/tencent/videoPoster'

/**
 * `media:ensure-video-poster` — generate-once + persist a video bubble's still
 * frame as a static COS object, so the chat renderer can show a few-KB JPEG
 * poster without re-running the billable 数据万象「媒体处理」snapshot on every
 * render. See services/tencent/videoPoster.ts for the idempotent strategy.
 *
 * Network goes through Electron's `net.fetch` (Chromium stack) so it honours
 * the app/session proxy — the same path that makes COS reachable for the user's
 * proxied setup (global undici `fetch` would bypass that proxy).
 */

async function headExists(url: string): Promise<boolean> {
  try {
    const res = await net.fetch(url, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

async function fetchSnapshot(url: string): Promise<SnapshotResponse> {
  const res = await net.fetch(url, { method: 'GET' })
  const ab = await res.arrayBuffer()
  return {
    ok: res.ok,
    status: res.status,
    body: Buffer.from(ab),
    contentType: res.headers.get('content-type') ?? undefined,
  }
}

export function registerVideoPosterIpc(): void {
  ipcMain.handle(
    'media:ensure-video-poster',
    async (_event, videoUrl: string): Promise<EnsureVideoPosterResult> => {
      if (typeof videoUrl !== 'string' || videoUrl.length === 0) {
        return { ok: false, reason: 'empty url' }
      }
      return ensureVideoPoster(videoUrl, {
        headExists,
        fetchSnapshot,
        upload: uploadBufferToBucket,
      })
    },
  )
}
