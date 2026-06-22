import { afterEach, describe, expect, it, vi } from 'vitest'
import { srcToBase64 } from '../canvasBridge'

describe('srcToBase64', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses a base64 data: URL without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never)
    const result = await srcToBase64('data:image/png;base64,QUJD')
    expect(result).toEqual({ mime: 'image/png', base64: 'QUJD' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses tldraw asset: refs instead of fetching them (CSP-safe)', async () => {
    // Regression: fetching `asset:<id>` threw + violated connect-src CSP, which
    // broke the annotation→edit export. Such schemes must short-circuit to null.
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never)
    expect(await srcToBase64('asset:743134291')).toBeNull()
    expect(await srcToBase64('file:///tmp/x.png')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
