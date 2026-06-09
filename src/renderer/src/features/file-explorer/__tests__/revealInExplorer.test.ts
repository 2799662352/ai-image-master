import { describe, expect, it } from 'vitest'
import { osPathFromHref, isAncestorPath, isImageHref } from '../revealInExplorer'

describe('osPathFromHref', () => {
  it('decodes a Windows file:/// URL to a drive path (no drive-letter folding)', () => {
    // The exact shape the model cites for a generated image on Windows.
    expect(osPathFromHref('file:///C:/Users/me/AppData/Roaming/app/agent/uploads/x.png')).toBe(
      'C:/Users/me/AppData/Roaming/app/agent/uploads/x.png',
    )
  })

  it('percent-decodes the drive colon (C%3A) form', () => {
    expect(osPathFromHref('file:///C%3A/Users/me/x.png')).toBe('C:/Users/me/x.png')
  })

  it('decodes a POSIX file:/// URL', () => {
    expect(osPathFromHref('file:///home/me/pics/x.png')).toBe('/home/me/pics/x.png')
  })

  it('accepts the local-file:/// attachment form', () => {
    expect(osPathFromHref('local-file:///C%3A/u/x.png')).toBe('C:/u/x.png')
  })

  it('accepts bare Windows and POSIX paths used as link targets', () => {
    expect(osPathFromHref('C:\\Users\\me\\x.png')).toBe('C:\\Users\\me\\x.png')
    expect(osPathFromHref('/var/data/x.png')).toBe('/var/data/x.png')
  })

  it('percent-decodes spaces in the path', () => {
    expect(osPathFromHref('file:///C:/My%20Pics/a%20b.png')).toBe('C:/My Pics/a b.png')
  })

  it('rejects non-local schemes (let default link behaviour run)', () => {
    expect(osPathFromHref('https://example.com/x.png')).toBe('')
    expect(osPathFromHref('http://example.com')).toBe('')
    expect(osPathFromHref('data:image/png;base64,AAA')).toBe('')
    expect(osPathFromHref('blob:abc')).toBe('')
    expect(osPathFromHref('mailto:a@b.com')).toBe('')
  })

  it('rejects relative links, anchors, and empties', () => {
    expect(osPathFromHref('#section')).toBe('')
    expect(osPathFromHref('relative/path.png')).toBe('')
    expect(osPathFromHref('')).toBe('')
    expect(osPathFromHref(undefined)).toBe('')
    expect(osPathFromHref(null)).toBe('')
  })

  it('blocks .. traversal in any form', () => {
    expect(osPathFromHref('file:///C:/a/../../secret')).toBe('')
    expect(osPathFromHref('/a/b/../../../etc/passwd')).toBe('')
  })

  it('resolves DOCUMENT paths too (not just images) so .md/.json links open', () => {
    // Docs route through revealPath→openTab→FileViewer; the resolver is
    // extension-agnostic, so these must come back as real paths.
    expect(osPathFromHref('file:///D:/tecx/text/剧本.md')).toBe('D:/tecx/text/剧本.md')
    expect(osPathFromHref('file:///C:/proj/data/config.json')).toBe('C:/proj/data/config.json')
    expect(osPathFromHref('D:\\tecx\\text\\全剧资产清单.md')).toBe('D:\\tecx\\text\\全剧资产清单.md')
    expect(osPathFromHref('/home/me/notes/todo.json')).toBe('/home/me/notes/todo.json')
  })
})

describe('isImageHref', () => {
  it('is true for image extensions (ignoring query/hash)', () => {
    expect(isImageHref('https://cdn/x.png')).toBe(true)
    expect(isImageHref('https://cdn/x.JPG?token=abc')).toBe(true)
    expect(isImageHref('https://cdn/x.webp#frag')).toBe(true)
  })

  it('is false for documents and non-images so they never hijack the lightbox', () => {
    expect(isImageHref('https://cdn/readme.md')).toBe(false)
    expect(isImageHref('https://cdn/data.json')).toBe(false)
    expect(isImageHref('https://example.com/page')).toBe(false)
    expect(isImageHref('')).toBe(false)
    expect(isImageHref(undefined)).toBe(false)
  })
})

describe('isAncestorPath', () => {
  it('matches a Windows ancestor dir of a nested file', () => {
    expect(isAncestorPath('C:\\a\\b', 'C:\\a\\b\\c.png')).toBe(true)
    expect(isAncestorPath('C:\\a', 'C:\\a\\b\\c.png')).toBe(true)
  })

  it('matches a POSIX ancestor dir', () => {
    expect(isAncestorPath('/a/b', '/a/b/c.png')).toBe(true)
  })

  it('is false for the same path, siblings, and partial-name prefixes', () => {
    expect(isAncestorPath('C:\\a\\b', 'C:\\a\\b')).toBe(false)
    expect(isAncestorPath('C:\\a\\b', 'C:\\a\\bc\\d.png')).toBe(false) // not a real ancestor
    expect(isAncestorPath('/a/b', '/a/c/d.png')).toBe(false)
    expect(isAncestorPath('', '/a/b')).toBe(false)
  })
})
