import { describe, expect, it } from 'vitest'
import { appendCosThumb, isCosUrl, isPersistedCosThumbUrl, persistedCosThumbUrl, pickPersistedThumbSize } from './cosThumb'

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/x.png'
const DATED = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/09/15/004f299ed8d3400a.png'

describe('persistedCosThumbUrl', () => {
  it('derives the sibling .thumbNNN.webp object for a dated image-history original', () => {
    expect(persistedCosThumbUrl(DATED)).toBe(DATED.replace(/\.png$/, '.thumb512.webp'))
    expect(persistedCosThumbUrl(DATED, 80)).toBe(DATED.replace(/\.png$/, '.thumb512.webp'))
    expect(persistedCosThumbUrl(DATED, 1024)).toBe(DATED.replace(/\.png$/, '.thumb1024.webp'))
    expect(persistedCosThumbUrl(DATED, 700)).toBe(DATED.replace(/\.png$/, '.thumb1024.webp'))
    expect(pickPersistedThumbSize(512)).toBe(512)
    expect(pickPersistedThumbSize(513)).toBe(1024)
  })

  it('leaves originals uploaded before PERSISTED_THUMBS_SINCE alone (no persisted object exists for them yet)', () => {
    expect(persistedCosThumbUrl(DATED.replace('2026/09/15', '2026/09/14'))).toBeUndefined()
    expect(persistedCosThumbUrl(DATED.replace('2026/09/15', '2025/12/31'))).toBeUndefined()
    expect(persistedCosThumbUrl(DATED.replace('2026/09/15', '2026/10/01'))).toBe(
      DATED.replace('2026/09/15', '2026/10/01').replace(/\.png$/, '.thumb512.webp'),
    )
  })

  it('returns undefined for everything that cannot have a persisted sibling', () => {
    // Presigned model output on another bucket — never ours to derive from.
    expect(persistedCosThumbUrl('https://aigc-output-image-1326893053.cos.ap-guangzhou.myqcloud.com/x.png?q-sign-time=1;2')).toBeUndefined()
    // Not the dated image-history layout (audio-history, releases, probes, undated).
    expect(persistedCosThumbUrl(COS)).toBeUndefined()
    expect(persistedCosThumbUrl('https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/audio-history/2026/09/15/a.mp3')).toBeUndefined()
    // Already a thumbnail — no thumb-of-thumb.
    expect(persistedCosThumbUrl(DATED.replace(/\.png$/, '.thumb512.webp'))).toBeUndefined()
    // Non-COS / local / blank.
    expect(persistedCosThumbUrl('https://example.com/image-history/2026/09/15/a.png')).toBeUndefined()
    expect(persistedCosThumbUrl('local-file:///D:/image-history/2026/09/15/a.png')).toBeUndefined()
    expect(persistedCosThumbUrl(undefined)).toBeUndefined()
  })

  it('isPersistedCosThumbUrl recognises only bare persisted-thumb objects', () => {
    expect(isPersistedCosThumbUrl(DATED.replace(/\.png$/, '.thumb512.webp'))).toBe(true)
    expect(isPersistedCosThumbUrl(DATED.replace(/\.png$/, '.thumb1024.webp'))).toBe(true)
    expect(isPersistedCosThumbUrl(DATED)).toBe(false)
    expect(isPersistedCosThumbUrl(appendCosThumb(DATED))).toBe(false)
    expect(isPersistedCosThumbUrl('https://example.com/a.thumb512.webp')).toBe(false)
  })
})

describe('isCosUrl', () => {
  it('matches Tencent COS bucket URLs', () => {
    expect(isCosUrl(COS)).toBe(true)
  })

  it('rejects non-COS http URLs and local/data sources', () => {
    expect(isCosUrl('https://example.com/a.png')).toBe(false)
    expect(isCosUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isCosUrl('D:\\imgs\\a.png')).toBe(false)
    expect(isCosUrl('local-file:///D%3A/imgs/a.png')).toBe(false)
    expect(isCosUrl('')).toBe(false)
  })
})

describe('appendCosThumb', () => {
  it('appends 数据万象 imageMogr2 thumbnail params to a COS URL', () => {
    expect(appendCosThumb(COS, 512)).toBe(
      `${COS}?imageMogr2/thumbnail/512x512%3E/format/webp/quality/85/ignore-error/1`,
    )
  })

  it('defaults to 512 when no size given', () => {
    expect(appendCosThumb(COS)).toBe(
      `${COS}?imageMogr2/thumbnail/512x512%3E/format/webp/quality/85/ignore-error/1`,
    )
  })

  it('honours a custom longest-edge size', () => {
    expect(appendCosThumb(COS, 256)).toBe(
      `${COS}?imageMogr2/thumbnail/256x256%3E/format/webp/quality/85/ignore-error/1`,
    )
  })

  it('leaves non-COS URLs, data URLs and local paths untouched', () => {
    expect(appendCosThumb('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(appendCosThumb('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(appendCosThumb('D:\\imgs\\a.png')).toBe('D:\\imgs\\a.png')
    expect(appendCosThumb('local-file:///D%3A/imgs/a.png')).toBe('local-file:///D%3A/imgs/a.png')
  })

  it('never appends imageMogr2 to a non-image object key — 数据万象 would return the whole file', () => {
    const video = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/x.mp4'
    expect(appendCosThumb(video)).toBe(video)
    const yml = 'https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml'
    expect(appendCosThumb(yml)).toBe(yml)
    // Extension-less keys stay eligible (ignore-error covers the odd non-image).
    const bare = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/abc'
    expect(appendCosThumb(bare)).toContain('?imageMogr2/')
  })

  it('does not double-process a URL that already carries a query', () => {
    const already = `${COS}?imageMogr2/thumbnail/100x100`
    expect(appendCosThumb(already)).toBe(already)
  })

  it('is a no-op for empty/undefined input', () => {
    expect(appendCosThumb('')).toBe('')
    expect(appendCosThumb(undefined)).toBe(undefined)
  })
})
