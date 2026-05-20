import { protocol, net, app } from 'electron'
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
      const response = await net.fetch(pathToFileURL(r.path).toString())
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
