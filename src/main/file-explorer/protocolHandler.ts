import { protocol, net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
  const sep = platform === 'win32' ? /[\\/]/ : /\//
  if (decodeURIComponent(url).split(sep).some((seg) => seg === '..')) {
    return { ok: false, reason: 'traversal' }
  }
  let osPath = decodeURIComponent(parsed.pathname)
  if (platform === 'win32' && /^\/[A-Za-z]:/.test(osPath)) osPath = osPath.slice(1)
  const normalize = platform === 'win32' ? path.win32.normalize : path.posix.normalize
  const normalized = normalize(osPath)
  return { ok: true, path: normalized }
}

export function registerLocalFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'local-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ])
}

export function installLocalFileHandler(): void {
  protocol.handle('local-file', async (request) => {
    const r = resolveOsPathFromRequest(request.url)
    if (!r.ok) {
      return new Response(`Forbidden: ${r.reason}`, { status: r.reason === 'traversal' ? 403 : 400 })
    }
    try {
      return await net.fetch(pathToFileURL(r.path).toString())
    } catch (err) {
      return new Response(`local-file fetch error: ${String(err)}`, { status: 500 })
    }
  })
}
