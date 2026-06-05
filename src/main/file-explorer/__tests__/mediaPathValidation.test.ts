import { describe, it, expect } from 'vitest'
import {
  hasTraversalSegment,
  mimeFromExt,
  isImageMime,
  isVideoMime,
  ALLOWED_MIME_BY_EXT,
} from '../mediaPathValidation'

// Shared validators extracted out of attachmentsIpc.ts so both
// `attachments:read-thumb` (full-fidelity bytes) and `media:thumb`
// (resized thumbnail) enforce the same security/whitelist surface.
// See: openspec/changes/fix-codex-chat-image-attachment-lag/tasks.md ->
// "PR-A — Renderer hot path" -> A1.shared-validation.

describe('mediaPathValidation.mimeFromExt', () => {
  it('returns the canonical mime for whitelisted image extensions', () => {
    expect(mimeFromExt('D:\\foo\\bar.PNG')).toBe('image/png')
    expect(mimeFromExt('/home/u/a.jpeg')).toBe('image/jpeg')
    expect(mimeFromExt('a.webp')).toBe('image/webp')
    expect(mimeFromExt('logo.svg')).toBe('image/svg+xml')
  })

  it('returns the canonical mime for whitelisted video / audio extensions', () => {
    expect(mimeFromExt('clip.mp4')).toBe('video/mp4')
    expect(mimeFromExt('clip.WEBM')).toBe('video/webm')
    expect(mimeFromExt('voice.mp3')).toBe('audio/mpeg')
  })

  it('returns undefined for non-whitelisted or extension-less paths', () => {
    expect(mimeFromExt('id_rsa')).toBeUndefined()
    expect(mimeFromExt('script.exe')).toBeUndefined()
    expect(mimeFromExt('archive.zip')).toBeUndefined()
    expect(mimeFromExt('')).toBeUndefined()
  })
})

describe('mediaPathValidation.hasTraversalSegment', () => {
  it('flags any literal `..` segment on either separator', () => {
    expect(hasTraversalSegment('D:/foo/../bar.png')).toBe(true)
    expect(hasTraversalSegment('D:\\foo\\..\\bar.png')).toBe(true)
    expect(hasTraversalSegment('/home/u/../../etc/passwd')).toBe(true)
    expect(hasTraversalSegment('..')).toBe(true)
  })

  it('does not flag filenames that merely contain dots', () => {
    expect(hasTraversalSegment('D:/foo/.hidden/a.png')).toBe(false)
    expect(hasTraversalSegment('/home/u/my..name/a.png')).toBe(false)
    expect(hasTraversalSegment('D:/release.v4.3.20/img.png')).toBe(false)
  })
})

describe('mediaPathValidation.isImageMime / isVideoMime', () => {
  it('classifies image vs video mimes for callers that need to branch on kind', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(true)
    expect(isImageMime('video/mp4')).toBe(false)
    expect(isVideoMime('video/mp4')).toBe(true)
    expect(isVideoMime('image/png')).toBe(false)
    expect(isImageMime('application/octet-stream')).toBe(false)
  })
})

describe('mediaPathValidation.ALLOWED_MIME_BY_EXT', () => {
  it('exposes the whitelist as a readonly object so both IPCs reference the same source of truth', () => {
    // Subset assertions — we only care that the shared map carries the
    // canonical mappings we rely on. Extra entries are fine.
    expect(ALLOWED_MIME_BY_EXT.png).toBe('image/png')
    expect(ALLOWED_MIME_BY_EXT.mp4).toBe('video/mp4')
    expect(ALLOWED_MIME_BY_EXT.svg).toBe('image/svg+xml')
  })
})
