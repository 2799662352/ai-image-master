import { describe, expect, it } from 'vitest'
import {
  imageHistoryPicOperations,
  persistedThumbKey,
  picOperationsHeader,
  thumbRule,
} from '../cosThumbRules'

describe('cosThumbRules', () => {
  it('derives sibling thumbnail keys next to the original, dropping the extension', () => {
    expect(persistedThumbKey('image-history/2026/09/15/abc.png', 512)).toBe('image-history/2026/09/15/abc.thumb512.webp')
    expect(persistedThumbKey('/image-history/2026/09/15/abc.jpeg', 1024)).toBe('image-history/2026/09/15/abc.thumb1024.webp')
    // A dot in a directory name must not be mistaken for the extension.
    expect(persistedThumbKey('image-history/v4.9/noext', 512)).toBe('image-history/v4.9/noext.thumb512.webp')
  })

  it('emits shrink-only rules with a literal > (this is a JSON header, not a URL)', () => {
    expect(thumbRule(512)).toBe('imageMogr2/thumbnail/512x512>/format/webp/quality/85')
    expect(thumbRule(1024)).not.toContain('%3E')
  })

  it('builds two persistent rules (512 / 1024) with leading-slash fileids for image mimes', () => {
    const ops = imageHistoryPicOperations('image-history/2026/09/15/abc.png', 'image/png')
    expect(ops?.is_pic_info).toBe(1)
    expect(ops?.rules).toEqual([
      { fileid: '/image-history/2026/09/15/abc.thumb512.webp', rule: thumbRule(512) },
      { fileid: '/image-history/2026/09/15/abc.thumb1024.webp', rule: thumbRule(1024) },
    ])
    expect(JSON.parse(picOperationsHeader(ops!))).toEqual(ops)
  })

  it('tolerates a charset suffix and case on the mime', () => {
    expect(imageHistoryPicOperations('k.jpg', 'image/JPEG; charset=binary')?.rules).toHaveLength(2)
  })

  it('returns undefined for anything 数据万象 cannot process (audio / video / unknown)', () => {
    expect(imageHistoryPicOperations('audio-history/a.mp3', 'audio/mpeg')).toBeUndefined()
    expect(imageHistoryPicOperations('image-history/a.mp4', 'video/mp4')).toBeUndefined()
    expect(imageHistoryPicOperations('image-history/a.bin', 'application/octet-stream')).toBeUndefined()
    expect(imageHistoryPicOperations('image-history/a.bin', undefined)).toBeUndefined()
  })
})
