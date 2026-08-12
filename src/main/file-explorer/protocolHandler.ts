import { protocol, net, app } from 'electron'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

/** 媒体扩展名 → Content-Type。缺了它 Chromium 只能靠嗅探,mp4 经常猜不中。 */
const MEDIA_MIME: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.weba': 'audio/webm',
}

/**
 * `Range: bytes=a-b` → 闭区间 `[start, end]`。返回 null = 语法不认识(按整份发),
 * 返回 'unsatisfiable' = 语法对但越界(必须回 416,不能装作没看见)。
 */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  // `bytes=-500` = 最后 500 字节。播放器探测 moov 尾盒时会这么问。
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * 媒体文件按 Range 分段发。
 *
 * 为什么不能继续用 `net.fetch(pathToFileURL(...))`:它对 `file://` 不返回
 * `Accept-Ranges`,播放器于是认为这个源不可分段,只能整份拉 —— 大文件表现为
 * 卡顿、进度条拖不动(`video.seekable.end()` 恒为 0)。这是上游的已知行为,
 * electron#38749「video files not seekable with protocol.handle」正是它,
 * electron#51442 里也确认媒体播放要自己实现 206。
 *
 * 实现照 Electron 内部的 `makeStreamFromFileInfo`:`createReadStream` 带 start/end,
 * 经 `Readable.toWeb` 变成 WHATWG 流 —— 按需读盘,整份文件不进内存。
 */
async function serveMedia(osPath: string, rangeHeader: string | null): Promise<Response> {
  const info = await stat(osPath)
  if (!info.isFile()) return new Response('Not a file', { status: 404 })
  const size = info.size
  const mime = MEDIA_MIME[path.extname(osPath).toLowerCase()] ?? 'application/octet-stream'
  const range = parseByteRange(rangeHeader, size)

  if (range === 'unsatisfiable') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    })
  }

  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const stream = Readable.toWeb(createReadStream(osPath, { start, end })) as ReadableStream<Uint8Array>

  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(end - start + 1),
      // 即便本次是整份发,也要声明可分段 —— 播放器据此才敢在拖进度条时发 Range。
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
  })
}

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'traversal' | 'invalid' }

export function resolveOsPathFromRequest(url: string, platform: NodeJS.Platform = process.platform): ResolveResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  // 媒体形态:`local-file://media/?p=<绝对路径>`(见 renderer 的 toStreamableUri)。
  // 路径整条放在查询串里,不参与路径规范化 —— Windows 盘符不会被折叠,也不需要
  // 那套 `D%3A` 的编码技巧。host 非空是关键:标准 scheme 的空 host 会让
  // `<video>` 的 IsSafeToLoadURL 直接判死,连请求都不发。
  if (parsed.hostname === 'media') {
    const raw = parsed.searchParams.get('p')
    if (!raw) return { ok: false, reason: 'invalid' }
    if (raw.split(/[\\/]/).some((seg) => seg === '..')) return { ok: false, reason: 'traversal' }
    const normalize = platform === 'win32' ? path.win32.normalize : path.posix.normalize
    return { ok: true, path: normalize(raw) }
  }

  const sep = platform === 'win32' ? /[\\/]/ : /\//
  if (decodeURIComponent(url).split(sep).some((seg) => seg === '..')) {
    return { ok: false, reason: 'traversal' }
  }
  let osPath = decodeURIComponent(parsed.pathname)
  if (platform === 'win32' && /^\/[A-Za-z]:/.test(osPath)) osPath = osPath.slice(1)
  if (platform === 'win32' && /^[A-Za-z]$/.test(parsed.hostname) && !/^[A-Za-z]:[\\/]/.test(osPath)) {
    osPath = `${parsed.hostname.toUpperCase()}:${osPath}`
  }
  const normalize = platform === 'win32' ? path.win32.normalize : path.posix.normalize
  const normalized = normalize(osPath)
  return { ok: true, path: normalized }
}

export function registerLocalFileScheme(): void {
  // DEV-only diagnostic: print the timing of this call vs app.isReady() so we
  // can prove whether the scheme registration is propagating to the renderer
  // process. `registerSchemesAsPrivileged` MUST be called before `app` emits
  // `ready` — once renderers spawn they snapshot the scheme registry and
  // late registrations are silently ignored (the renderer's URL parser then
  // treats `local-file://...` as a non-special scheme, which is exactly what
  // produces `TypeError: Failed to execute 'fetch' on 'Window': Failed to
  // parse URL from local-file:///...`).
  if (!app.isPackaged) {
    // eslint-disable-next-line no-console
    console.log('[local-file] registerSchemesAsPrivileged called', {
      appIsReady: app.isReady(),
      timestamp: Date.now(),
    })
  }
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'local-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        // `<video>` / `<audio>` **必须**要这一条。官方文档(docs/api/protocol.md)原话:
        // 媒体元素默认期待协议把整个响应**缓冲**下来,`stream` 才让它们按流式响应处理。
        // 不开它,net.fetch 那头明明是 createReadStream 流式吐字节,到了媒体元素这边
        // 仍按「等它缓冲完」处理 —— 大文件表现为一直转圈或直接失败,而且没有 Range,
        // 进度条拖不动。
        stream: true,
      },
    },
  ])
}

/**
 * Gate on `Sec-Fetch-Site` to stop a hostile web page that somehow loads
 * inside the renderer from exfiltrating files, but **never** stop legitimate
 * no-CORS static resource loads. In Electron the renderer's page origin is
 * either `http://localhost:5173` (Vite dev) or `file://` (packaged), so an
 * `<img src="local-file://...">` is *always* labelled `Sec-Fetch-Site: cross-site`
 * by Chromium — naively blocking cross-site here turns the thumbnail pipeline
 * into a self-DoS (which is exactly the bug that hid this dead code path
 * until EvidenceStack started rendering MediaThumbnail).
 *
 * Chromium guarantees no-CORS image / video / audio responses are opaque to
 * JS, so a cross-site `<img>` load cannot exfiltrate file bytes; we follow
 * VSCode / Cursor's lead and allow those `Sec-Fetch-Dest` values even when
 * `Sec-Fetch-Site` is cross-site. For everything else (fetch, XHR, document
 * navigation, worker scripts) we keep the strict same-origin policy.
 */
export function isAllowedLocalFileFetchSite(
  site: string | null,
  dest: string | null = null,
): boolean {
  if (dest === 'image' || dest === 'video' || dest === 'audio') return true
  return site == null || site === 'same-origin' || site === 'none'
}

export function installLocalFileHandler(): void {
  // DEV-only multi-layer diagnostic so when a local-file load fails the
  // main-process stdout shows the exact request shape Chromium delivered
  // (Sec-Fetch-Site / Sec-Fetch-Dest), the resolved OS path, and the final
  // status. Without this we can only see "image load failed" on the renderer
  // side with no clue whether the handler ran, blocked, or net.fetch errored.
  // Stays silent in packaged builds (`!app.isPackaged`).
  const dev = !app.isPackaged
  protocol.handle('local-file', async (request) => {
    const site = request.headers.get('Sec-Fetch-Site')
    const dest = request.headers.get('Sec-Fetch-Dest')
    if (!isAllowedLocalFileFetchSite(site, dest)) {
      if (dev) {
        // eslint-disable-next-line no-console
        console.warn('[local-file] BLOCKED', { url: request.url, site, dest })
      }
      return new Response('Forbidden: cross-origin', { status: 403 })
    }

    const r = resolveOsPathFromRequest(request.url)
    if (!r.ok) {
      if (dev) {
        // eslint-disable-next-line no-console
        console.warn('[local-file] BAD_URL', { url: request.url, reason: r.reason })
      }
      return new Response(`Forbidden: ${r.reason}`, { status: r.reason === 'traversal' ? 403 : 400 })
    }
    try {
      // 媒体走自己的分段实现(见 serveMedia)。只对 `media` 主机生效 —— 图片与聊天
      // 附件那条 net.fetch 一直好用,没有理由跟着一起动。
      if (new URL(request.url).hostname === 'media') {
        const response = await serveMedia(r.path, request.headers.get('Range'))
        if (dev) {
          // eslint-disable-next-line no-console
          console.log('[local-file] MEDIA', {
            osPath: r.path,
            range: request.headers.get('Range') ?? '(none)',
            status: response.status,
          })
        }
        return response
      }
      // `bypassCustomProtocolHandlers` 是 electron#49073 里给出的解法:不加的话
      // 这次内层 fetch 会再走一遍自定义协议派发,媒体元素上表现为「请求好像成功了
      // 但放不出来」。那条 issue 的报告者在 electron@38 上正是靠它 + 正确的
      // registerSchemesAsPrivileged 修好的,而我们这里的写法(protocol.handle 里
      // net.fetch(pathToFileURL(...)))与他一模一样。
      const response = await net.fetch(pathToFileURL(r.path).toString(), {
        bypassCustomProtocolHandlers: true,
      })
      if (dev && (response.status < 200 || response.status >= 300)) {
        // eslint-disable-next-line no-console
        console.warn('[local-file] FETCH_NON_2XX', {
          url: request.url,
          osPath: r.path,
          site,
          dest,
          status: response.status,
          statusText: response.statusText,
        })
      } else if (dev) {
        // eslint-disable-next-line no-console
        console.log('[local-file] OK', { url: request.url, osPath: r.path, site, dest, status: response.status })
      }
      return response
    } catch (err) {
      if (dev) {
        // eslint-disable-next-line no-console
        console.error('[local-file] FETCH_THREW', { url: request.url, osPath: r.path, site, dest, err: String(err) })
      }
      return new Response(`local-file fetch error: ${String(err)}`, { status: 500 })
    }
  })
}
