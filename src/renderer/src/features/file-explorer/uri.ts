const WIN_ABS = /^[A-Za-z]:[\\/]/
const POSIX_ABS = /^\//

/**
 * Windows path → `local-file:///C:/…` with the drive colon kept RAW.
 *
 * `local-file` is registered as a *standard* scheme (protocolHandler.ts), so
 * Chromium parses `local-file:///X…` the way it parses `http:///X…`: the run
 * of slashes collapses and `X` becomes the authority. Measured in a real
 * Electron 43 BrowserWindow (file:// page origin, packaged-app webPreferences,
 * the real protocol handler):
 *
 *   `local-file:///C%3A/…` → the host "C:" (after percent-decoding) contains a
 *     forbidden host code point, so the URL is INVALID: `new URL()` throws,
 *     `<img>` shows the broken-image icon, `<audio>` fails with
 *     "Media load rejected by URL safety check", and the protocol handler is
 *     never called. This was the canvas 裂图 / AudioPage local-playback bug.
 *   `local-file:///C:/…`   → host "c", path "/…"; `<img>` decodes and `<audio>`
 *     plays. The request reaches the main process as `local-file://c/…` and
 *     `resolveOsPathFromRequest` restores the drive from the 1-letter host.
 *
 * (The old `%3A` trick assumed the handler could not cope with the host-letter
 * form; it has handled `local-file://c/…` for a long time.)
 */
function windowsPathToLocalFileUri(path: string): string {
  return 'local-file:///' + path.replace(/\\/g, '/')
}

/** Legacy `local-file:///C%3A/…` (written by older builds; an invalid URL). */
const LEGACY_ENCODED_DRIVE = /^local-file:\/\/\/([A-Za-z])%3[Aa](?=\/)/
/** Chromium-normalized `local-file://c/…` (what `img.src` / request URLs read back as). */
const HOST_LETTER_DRIVE = /^local-file:\/\/([A-Za-z])(?=\/)/

/**
 * Fold every shape of an existing `local-file://` URL onto the canonical
 * `local-file:///C:/…` form. Streamable media URLs (`local-file://media/?p=`)
 * and POSIX paths (`local-file:////home/…`) match neither pattern and pass
 * through untouched.
 */
function normalizeLocalFileUri(uri: string): string {
  const legacy = LEGACY_ENCODED_DRIVE.exec(uri)
  if (legacy) return `local-file:///${legacy[1]}:${uri.slice(legacy[0].length)}`
  const hostLetter = HOST_LETTER_DRIVE.exec(uri)
  if (hostLetter) return `local-file:///${hostLetter[1].toUpperCase()}:${uri.slice(hostLetter[0].length)}`
  return uri
}

/**
 * 媒体元素专用地址:`local-file://media/?p=<百分号编码的绝对路径>`。
 *
 * 为什么视频/音频不沿用 `toRenderableUri` 那种 `local-file:///D:/...`:
 *
 * 历史上 `<video>`/`<audio>` 拿到旧的 `local-file:///D%3A/...` 会直接抛
 * `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check` ——**在渲染端就拒了,
 * 请求根本不发出去**,主进程协议处理器一条日志都没有(这个"没有日志"的症状此前被反复
 * 误判成协议没注册或 CSP 拦截)。真机实测后的病根是 `%3A`:standard scheme 下它让
 * 整条 URL 非法(见 `windowsPathToLocalFileUri`);盘符冒号原样的形式媒体元素也能加载。
 *
 * 媒体仍然走这个 host 非空、路径塞进**查询串**的形态,是因为主进程只对 `media` 主机
 * 实现了 206 Range 分段(见 protocolHandler.ts serveMedia)—— 大文件才能拖进度条;
 * 查询串也不参与路径规范化,Windows 盘符不会被折叠。
 *
 * 图片继续用 `toRenderableUri`(`local-file:///C:/…`,盘符冒号原样,见上方注释)。
 */
export function toStreamableUri(osPath: string): string {
  if (!osPath) return ''
  return `local-file://media/?p=${encodeURIComponent(osPath)}`
}

export function toRenderableUri(uri: string): string {
  if (!uri) return uri
  if (uri.startsWith('local-file://')) return normalizeLocalFileUri(uri)
  if (uri.startsWith('blob:') || uri.startsWith('data:') || /^https?:\/\//.test(uri)) return uri
  // `file://…` is NOT natively loadable from this sandboxed renderer — `<img
  // src="file://…">` triggers "Not allowed to load local resource". Multiple
  // producers emit it (codexArtifactPersistence's path fallback when R2/COS is
  // unsettled, SeedanceTaskListener, codex MCP `file://` resource_links), so we
  // normalize it here at the single rendering chokepoint into the canonical
  // `local-file://` form, which routes through the custom-protocol/IPC path that
  // `useResolvedMediaSrc` knows how to read. (Markdown link clicks keep using
  // `osPathFromHref` on the raw href — this only affects media `src` rendering.)
  if (/^file:\/\//i.test(uri)) {
    let rest = uri.replace(/^file:\/\//i, '')
    // Drop an authority/host (`file://host/path`); `file:///path` leaves a
    // leading slash already.
    if (!rest.startsWith('/')) {
      const slash = rest.indexOf('/')
      rest = slash >= 0 ? rest.slice(slash) : '/' + rest
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(rest)
    } catch {
      decoded = rest
    }
    // Windows drive path lost as `/C:/Users/…` → strip the spurious leading slash.
    const win = /^\/([A-Za-z]:[\\/].*)$/.exec(decoded)
    if (win) return windowsPathToLocalFileUri(win[1])
    // POSIX absolute path keeps its leading slash (→ `local-file:////home/…`).
    return 'local-file:///' + decoded
  }
  if (WIN_ABS.test(uri)) return windowsPathToLocalFileUri(uri)
  if (POSIX_ABS.test(uri)) return 'local-file:///' + uri
  return uri
}
