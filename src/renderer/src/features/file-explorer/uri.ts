const WIN_ABS = /^[A-Za-z]:[\\/]/
const POSIX_ABS = /^\//

export function toRenderableUri(uri: string): string {
  if (!uri) return uri
  if (uri.startsWith('local-file://')) return uri
  if (uri.startsWith('blob:') || uri.startsWith('data:') || /^https?:\/\//.test(uri)) return uri
  if (WIN_ABS.test(uri)) return 'local-file:///' + uri.replace(/\\/g, '/')
  if (POSIX_ABS.test(uri)) return 'local-file:///' + uri
  return uri
}
