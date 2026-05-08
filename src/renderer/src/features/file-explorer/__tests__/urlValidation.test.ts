import { describe, expect, it } from 'vitest'
import { validateExternalUrl } from '../urlValidation'

describe('validateExternalUrl', () => {
  it('accepts https URLs as embeddable', () => {
    expect(validateExternalUrl('https://developers.openai.com')).toEqual({
      ok: true,
      url: 'https://developers.openai.com/',
      embeddable: true,
    })
  })

  it('accepts http URLs but marks them non-embeddable', () => {
    expect(validateExternalUrl('http://localhost:3000/preview')).toEqual({
      ok: true,
      url: 'http://localhost:3000/preview',
      embeddable: false,
    })
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'about:blank',
    'chrome://flags',
    'chrome-extension://abc/options.html',
    'blob:https://example.com/abc',
  ])('rejects %s', (url) => {
    const result = validateExternalUrl(url)
    expect(result.ok).toBe(false)
  })

  it('rejects malformed input safely', () => {
    expect(validateExternalUrl('not a url').ok).toBe(false)
    expect(validateExternalUrl('').ok).toBe(false)
  })
})
