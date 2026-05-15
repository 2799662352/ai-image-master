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
  if (WIN_ABS.test(uri)) return 'local-file:///' + encodeDriveColon(uri.replace(/\\/g, '/'))
  if (POSIX_ABS.test(uri)) return 'local-file:///' + uri
  return uri
}
