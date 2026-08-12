const WIN_ABS = /^[A-Za-z]:[\\/]/
const POSIX_ABS = /^\//

// Drive colons in a `local-file://` URL must be percent-encoded. `local-file`
// is registered as a standard scheme, so an unencoded `local-file:///C:/x`
// is parsed as host=`c`, dropping the drive letter entirely (the renderer
// then issues `local-file://c/x`, which the protocol handler cannot resolve
// and returns 500). Encoding the colon as `%3A` keeps host empty and lets
// `resolveOsPathFromRequest` reconstruct the Windows path normally.
function encodeDriveColon(path: string): string {
  return path.replace(/^([A-Za-z]):/, '$1%3A')
}

/**
 * 媒体元素专用地址:`local-file://media/?p=<百分号编码的绝对路径>`。
 *
 * 为什么不能沿用 `toRenderableUri` 那种 `local-file:///D%3A/...`:
 *
 * `<video>`/`<audio>` 走的是 Blink 的 `HTMLMediaElement::IsSafeToLoadURL`,比图片
 * 严得多,不过就直接抛 `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`
 * ——**在渲染端就拒了,请求根本不发出去**,所以主进程的协议处理器一条日志都没有
 * (这个"没有日志"的症状此前被反复误判成协议没注册或 CSP 拦截)。
 *
 * 差别在 host:`local-file:///…` 的 host 是**空的**,而 `standard: true` 表示这个
 * scheme 按 RFC 3986 通用语法解析,标准 scheme 的空 host 在 Chromium 里是可疑形态
 * (只有 `file` 例外)。查到的所有能正常播放的实例——Electron 官方文档的
 * `app://bundle/...`、生产项目 CoWork-OS 的 `media://<token>`——host 都非空。
 *
 * 顺带把整条路径塞进**查询串**:那里不参与路径规范化,Windows 盘符不会被折叠,
 * 也就不必再依赖 `D%3A` 那种精巧的编码技巧。
 *
 * 图片继续用 `toRenderableUri` —— 它那条路一直是好的,没有理由跟着动。
 */
export function toStreamableUri(osPath: string): string {
  if (!osPath) return ''
  return `local-file://media/?p=${encodeURIComponent(osPath)}`
}

export function toRenderableUri(uri: string): string {
  if (!uri) return uri
  if (uri.startsWith('local-file://')) {
    return uri.replace(/^(local-file:\/\/\/)([A-Za-z]):/, '$1$2%3A')
  }
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
    if (win) return 'local-file:///' + encodeDriveColon(win[1].replace(/\\/g, '/'))
    // POSIX absolute path keeps its leading slash (→ `local-file:////home/…`).
    return 'local-file:///' + decoded
  }
  if (WIN_ABS.test(uri)) return 'local-file:///' + encodeDriveColon(uri.replace(/\\/g, '/'))
  if (POSIX_ABS.test(uri)) return 'local-file:///' + uri
  return uri
}
