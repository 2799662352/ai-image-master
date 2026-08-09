import { describe, expect, it } from 'vitest'
import {
  describeRemaining,
  describeUrlHealth,
  parseBasicIsoDate,
  parseSignedUrlExpiry,
} from '../signedUrlExpiry'

/** 实测样本:2026-08-09 一次「加载失败」的卡片上取下来的真实地址。 */
const TOS_URL =
  'https://ark-acg-ap-southest-1.tos-ap-southeast-1.volces.com/dreamina-seedance-2-0/0217.mp4'
  + '?X-Tos-Algorithm=TOS4-HMAC-SHA256'
  + '&X-Tos-Credential=AKLT%2F20260809%2Fap-southeast-1%2Ftos%2Frequest'
  + '&X-Tos-Date=20260809T004221Z'
  + '&X-Tos-Expires=86400'
  + '&X-Tos-Signature=0fef035d'
  + '&X-Tos-SignedHeaders=host'

const SIGNED_AT = Date.UTC(2026, 7, 9, 0, 42, 21)

describe('parseBasicIsoDate', () => {
  it('解析预签名用的无分隔符 ISO', () => {
    expect(parseBasicIsoDate('20260809T004221Z')).toBe(SIGNED_AT)
  })

  it('带分隔符的普通 ISO 不属于这个格式，返回 null', () => {
    expect(parseBasicIsoDate('2026-08-09T00:42:21Z')).toBeNull()
  })
})

describe('parseSignedUrlExpiry', () => {
  /**
   * 这条断言是本文件的重点。当时的错误文案说「网络问题或链接已过期」，而这条地址
   * 签发才 13 分钟。含糊其辞会把用户推去花钱重生成一条其实还能下载的视频。
   */
  it('实测样本:签发 13 分钟后仍有约 23 小时 47 分，未过期', () => {
    const now = SIGNED_AT + 13 * 60_000
    const exp = parseSignedUrlExpiry(TOS_URL, now)!

    expect(exp.expired).toBe(false)
    expect(exp.expiresAt).toBe(SIGNED_AT + 86_400_000)
    expect(Math.round(exp.remainingMs / 60_000)).toBe(1427) // 23h47m
  })

  it('过了 24 小时判过期', () => {
    const exp = parseSignedUrlExpiry(TOS_URL, SIGNED_AT + 86_400_001)!
    expect(exp.expired).toBe(true)
  })

  it('兼容 S3 的 X-Amz-* 同构参数', () => {
    const url = 'https://b.s3.amazonaws.com/o.mp4?X-Amz-Date=20260809T004221Z&X-Amz-Expires=3600'
    const exp = parseSignedUrlExpiry(url, SIGNED_AT)!
    expect(exp.expiresAt).toBe(SIGNED_AT + 3_600_000)
  })

  it.each([
    ['没有签名参数的普通地址', 'https://cdn.example.com/a.mp4'],
    ['不是合法 URL', 'not a url'],
    ['缺 expires', 'https://x/y?X-Tos-Date=20260809T004221Z'],
    ['expires 非法', 'https://x/y?X-Tos-Date=20260809T004221Z&X-Tos-Expires=abc'],
  ])('%s → null（未知，不等于没过期）', (_label, url) => {
    expect(parseSignedUrlExpiry(url)).toBeNull()
  })

  it('undefined 安全', () => {
    expect(parseSignedUrlExpiry(undefined)).toBeNull()
  })
})

describe('describeRemaining', () => {
  it.each([
    [3 * 3_600_000 + 20 * 60_000, '还有 3 小时 20 分'],
    [2 * 3_600_000, '还有 2 小时'],
    [90_000, '还有 1 分钟'],
    [-2 * 3_600_000, '已过期 2 小时'],
  ])('%i ms → %s', (ms, text) => {
    expect(describeRemaining(ms)).toBe(text)
  })
})

describe('describeUrlHealth', () => {
  it('未过期时明说是网络问题，不把人引去重新生成', () => {
    const text = describeUrlHealth(TOS_URL, SIGNED_AT + 13 * 60_000)
    expect(text).toContain('链接未过期')
    expect(text).toContain('网络不通')
    expect(text).not.toContain('重新生成')
  })

  it('确实过期了才说要重新生成', () => {
    expect(describeUrlHealth(TOS_URL, SIGNED_AT + 90_000_000)).toContain('只能重新生成')
  })

  it('解析不出来时说「未知」，不假装知道', () => {
    expect(describeUrlHealth('https://cdn.example.com/a.mp4')).toBe('（链接有效期未知）')
  })
})
