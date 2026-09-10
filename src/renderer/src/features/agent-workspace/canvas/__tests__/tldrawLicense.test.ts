import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTldrawLicenseKey } from '../tldrawLicense'

describe('resolveTldrawLicenseKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads VITE_TLDRAW_LICENSE_KEY from the build environment', () => {
    vi.stubEnv('VITE_TLDRAW_LICENSE_KEY', 'tldraw-abc123')
    expect(resolveTldrawLicenseKey()).toBe('tldraw-abc123')
  })

  it('returns undefined when the variable is missing or blank (tldraw then behaves as today)', () => {
    vi.stubEnv('VITE_TLDRAW_LICENSE_KEY', '')
    expect(resolveTldrawLicenseKey()).toBeUndefined()
    expect(resolveTldrawLicenseKey(undefined)).toBeUndefined()
    expect(resolveTldrawLicenseKey('   ')).toBeUndefined()
  })

  it('strips whitespace, line breaks and zero-width characters from a pasted key', () => {
    expect(resolveTldrawLicenseKey(' tldraw-\u200Babc\r\n123 \n')).toBe('tldraw-abc123')
  })
})
