import { describe, it, expect } from 'vitest'
import { resolveOsPathFromRequest } from '../protocolHandler'

describe('protocolHandler.resolveOsPathFromRequest', () => {
  it('extracts Windows drive path from local-file:///D:/x/y.png', () => {
    const r = resolveOsPathFromRequest('local-file:///D:/x/y.png', 'win32')
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
