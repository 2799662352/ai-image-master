import { describe, expect, it } from 'vitest'
import { buildMediaCandidates, isExpiredSignedUrl, parseSignedUrlWindow } from '../mediaFallback'

const COS_SIGNED =
  'https://aigc-output-image-1326893053.cos.ap-guangzhou.myqcloud.com/1345773498/x_0.png?q-sign-algorithm=sha1&q-ak=AKID&q-sign-time=1789461247;1789504457&q-key-time=1789461247;1789504457&q-header-list=host&q-url-param-list=&q-signature=abc'

describe('parseSignedUrlWindow', () => {
  it('reads the COS q-sign-time window', () => {
    expect(parseSignedUrlWindow(COS_SIGNED)).toEqual({ start: 1789461247, end: 1789504457 })
  })

  it('reads S3/R2 X-Amz-Date + X-Amz-Expires', () => {
    const url = 'https://r2.example/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260915T080000Z&X-Amz-Expires=3600&X-Amz-Signature=x'
    expect(parseSignedUrlWindow(url)).toEqual({ start: Date.UTC(2026, 8, 15, 8, 0, 0) / 1000, end: Date.UTC(2026, 8, 15, 9, 0, 0) / 1000 })
  })

  it('reads legacy Expires=<epoch>', () => {
    expect(parseSignedUrlWindow('https://x.test/a.png?Expires=1789504457&Signature=y')).toEqual({ start: 0, end: 1789504457 })
  })

  it('returns null for unsigned / local / non-http sources', () => {
    expect(parseSignedUrlWindow('https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/a.png')).toBeNull()
    expect(parseSignedUrlWindow('https://x.test/a.png?imageMogr2/thumbnail/512x512%3E')).toBeNull()
    expect(parseSignedUrlWindow('local-file:///D:/a.png?q-sign-time=1;2')).toBeNull()
    expect(parseSignedUrlWindow('blob:http://localhost/abc')).toBeNull()
    expect(parseSignedUrlWindow('')).toBeNull()
  })
})

describe('isExpiredSignedUrl', () => {
  it('is false inside the window and true 60s past the end (clock-skew margin)', () => {
    expect(isExpiredSignedUrl(COS_SIGNED, 1789504457 * 1000 - 1)).toBe(false)
    expect(isExpiredSignedUrl(COS_SIGNED, (1789504457 + 30) * 1000)).toBe(false)
    expect(isExpiredSignedUrl(COS_SIGNED, (1789504457 + 61) * 1000)).toBe(true)
  })

  it('never calls an unsigned or local source expired', () => {
    expect(isExpiredSignedUrl('https://x.test/a.png', Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(isExpiredSignedUrl('local-file:///D:/a.png', Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})

describe('buildMediaCandidates', () => {
  const now = (1789504457 + 3600) * 1000 // one hour after the COS signature above expired

  it('keeps order primary → fallbacks, de-duplicates, drops blanks', () => {
    expect(
      buildMediaCandidates('https://a.test/1.png', [' ', undefined, 'https://a.test/1.png', 'file:///D:/1.png'], now),
    ).toEqual(['https://a.test/1.png', 'file:///D:/1.png'])
  })

  it('drops an expired signed primary so the local copy is tried first', () => {
    expect(buildMediaCandidates(COS_SIGNED, ['file:///D:/out/1.png'], now)).toEqual(['file:///D:/out/1.png'])
  })

  it('keeps a still-valid signed url', () => {
    expect(buildMediaCandidates(COS_SIGNED, ['file:///D:/out/1.png'], 1789461247 * 1000 + 1000)).toEqual([COS_SIGNED, 'file:///D:/out/1.png'])
  })

  it('returns [] when everything is expired or blank — caller renders the placeholder without a request', () => {
    expect(buildMediaCandidates(COS_SIGNED, [undefined, ''], now)).toEqual([])
    expect(buildMediaCandidates(undefined, undefined, now)).toEqual([])
  })
})
