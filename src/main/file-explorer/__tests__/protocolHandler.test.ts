import { describe, it, expect } from 'vitest'
import { isAllowedLocalFileFetchSite, resolveOsPathFromRequest } from '../protocolHandler'

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
    'rejects cross-origin fetch/XHR even when site is %s and dest is empty',
    (site) => {
      expect(isAllowedLocalFileFetchSite(site, 'empty')).toBe(false)
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
