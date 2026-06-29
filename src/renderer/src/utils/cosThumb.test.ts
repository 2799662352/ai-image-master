import { describe, expect, it } from 'vitest'
import { appendCosThumb, isCosUrl } from './cosThumb'

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/x.png'

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

  it('does not double-process a URL that already carries a query', () => {
    const already = `${COS}?imageMogr2/thumbnail/100x100`
    expect(appendCosThumb(already)).toBe(already)
  })

  it('is a no-op for empty/undefined input', () => {
    expect(appendCosThumb('')).toBe('')
    expect(appendCosThumb(undefined)).toBe(undefined)
  })
})
