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
