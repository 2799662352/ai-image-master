import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { isAllowedLocalFileFetchSite, isTrustedLocalFileInitiator, resolveOsPathFromRequest } from '../protocolHandler'

describe('protocolHandler.resolveOsPathFromRequest', () => {
  it('extracts Windows drive path from local-file:///D:/x/y.png', () => {
    const r = resolveOsPathFromRequest('local-file:///D:/x/y.png', 'win32')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('D:\\x\\y.png')
  })

  it('extracts Windows drive path from Chromium-normalized local-file://d/x/y.png', () => {
    const r = resolveOsPathFromRequest('local-file://d/x/y.png', 'win32')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('D:\\x\\y.png')
  })

  // Exact request shape a real Electron 43 renderer delivered for
  // `<img src="local-file:///C:/…/测试 dir/下载 (2).png">`: the standard-scheme
  // parser turned the drive into a 1-letter lower-case host and percent-encoded
  // the CJK / space segments. This is the canonical form toRenderableUri emits.
  it('restores drive + decodes CJK/space segments from the host-letter request form', () => {
    const r = resolveOsPathFromRequest(
      'local-file://c/Users/27996/Temp/%E6%B5%8B%E8%AF%95%20dir/%E4%B8%8B%E8%BD%BD%20(2).png',
      'win32',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('C:\\Users\\27996\\Temp\\测试 dir\\下载 (2).png')
  })

  it('extracts Windows drive path from encoded local-file:///D%3A/x/y.png', () => {
    const r = resolveOsPathFromRequest('local-file:///D%3A/x/y.png', 'win32')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('D:\\x\\y.png')
  })

  it('extracts POSIX path from local-file:////home/u/x.png', () => {
    const r = resolveOsPathFromRequest('local-file:////home/u/x.png', 'linux')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('/home/u/x.png')
  })

  it('rejects URLs with .. segments', () => {
    const r = resolveOsPathFromRequest('local-file:///D:/uploads/../../../etc/passwd', 'win32')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('traversal')
  })

  it('rejects encoded .. (%2e%2e)', () => {
    const r = resolveOsPathFromRequest('local-file:///D:/uploads/%2e%2e/etc/passwd', 'win32')
    expect(r.ok).toBe(false)
  })

  it('decodes percent-encoded segments before resolving', () => {
    const r = resolveOsPathFromRequest('local-file:///D:/with%20space/x.png', 'win32')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('D:\\with space\\x.png')
  })
})

describe('protocolHandler.isAllowedLocalFileFetchSite', () => {
  it.each([null, 'same-origin', 'none'])(
    'allows %s when Sec-Fetch-Dest is unset (fetch/XHR/document)',
    (site) => {
      expect(isAllowedLocalFileFetchSite(site, null)).toBe(true)
    },
  )

  it.each(['cross-site', 'same-site'])(
    'allows dest=empty fetch (tldraw canvas asset resolve) when site is %s',
    (site) => {
      expect(isAllowedLocalFileFetchSite(site, 'empty')).toBe(true)
    },
  )

  it.each(['cross-site', 'same-site'])(
    'still rejects dest-unset requests when site is %s',
    (site) => {
      expect(isAllowedLocalFileFetchSite(site, null)).toBe(false)
    },
  )

  // Renderer page origin is `http://localhost:5173` (dev) or `file://` (prod),
  // so an <img src="local-file://..."> is *always* labelled cross-site by
  // Chromium. Allow these no-CORS static loads or thumbnails are dead.
  it.each(['image', 'video', 'audio'])(
    'allows cross-site Sec-Fetch-Dest=%s (no-CORS static resource)',
    (dest) => {
      expect(isAllowedLocalFileFetchSite('cross-site', dest)).toBe(true)
      expect(isAllowedLocalFileFetchSite('same-site', dest)).toBe(true)
    },
  )

  // Defence in depth: even with dest=image, document / script / worker
  // dests stay rejected when cross-site so a hostile page can't load
  // local-file:// HTML or JS through this scheme.
  it.each(['document', 'script', 'worker', 'iframe'])(
    'still rejects cross-site Sec-Fetch-Dest=%s',
    (dest) => {
      expect(isAllowedLocalFileFetchSite('cross-site', dest)).toBe(false)
    },
  )
})

/**
 * `corsEnabled: true` on the scheme makes Chromium skip the CORS header check
 * entirely (measured on Electron 43, file:// and http origins): without this
 * guard a sandboxed `srcdoc` iframe could `fetch()` and read any local file.
 * The initiator is the only thing left to gate on.
 */
describe('protocolHandler.isTrustedLocalFileInitiator (frame guard behind corsEnabled)', () => {
  const topFrameOfWindow = { frameIsTop: true, webContentsType: 'window' } as const

  it.each(['image', 'xhr', 'media', 'other'])(
    'allows a %s sub-resource requested by the top frame of one of our windows',
    (resourceType) => {
      expect(isTrustedLocalFileInitiator({ ...topFrameOfWindow, resourceType })).toBe(true)
    },
  )

  it('cancels requests from any iframe (sandboxed srcdoc, tldraw embeds, UrlPreview)', () => {
    expect(isTrustedLocalFileInitiator({ frameIsTop: false, resourceType: 'xhr', webContentsType: 'window' })).toBe(false)
    expect(isTrustedLocalFileInitiator({ frameIsTop: false, resourceType: 'image', webContentsType: 'window' })).toBe(false)
  })

  it('cancels requests with no frame (workers, service workers, detached)', () => {
    expect(isTrustedLocalFileInitiator({ frameIsTop: null, resourceType: 'xhr', webContentsType: 'window' })).toBe(false)
    expect(isTrustedLocalFileInitiator({ frameIsTop: null, resourceType: 'image', webContentsType: null })).toBe(false)
  })

  it('cancels requests from <webview> guests and other non-window contents', () => {
    expect(isTrustedLocalFileInitiator({ frameIsTop: true, resourceType: 'image', webContentsType: 'webview' })).toBe(false)
    expect(isTrustedLocalFileInitiator({ frameIsTop: true, resourceType: 'image', webContentsType: null })).toBe(false)
  })

  it.each(['mainFrame', 'subFrame'])('never lets a %s navigate to a local file', (resourceType) => {
    expect(isTrustedLocalFileInitiator({ ...topFrameOfWindow, resourceType })).toBe(false)
  })

  // Electron keeps ONE `onBeforeRequest` listener per session: a second
  // registration anywhere in main silently replaces the guard and reopens
  // the hole. Pin it at the source level, like viewersUseIpc does.
  it('is the only onBeforeRequest registration in src/main', () => {
    const mainRoot = path.join(__dirname, '..', '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__' && entry !== 'node_modules') walk(full)
          continue
        }
        if (!/\.(ts|mts|cts)$/.test(entry) || /\.test\./.test(entry)) continue
        const source = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n')
        if (/\.onBeforeRequest\(/.test(source)) offenders.push(path.relative(mainRoot, full).replace(/\\/g, '/'))
      }
    }
    walk(mainRoot)
    expect(offenders).toEqual(['file-explorer/protocolHandler.ts'])
  })
})
