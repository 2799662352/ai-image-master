import { describe, expect, it } from 'vitest'
import { deriveCodeChallenge, generateCodeVerifier, generateState } from '../pkce'

describe('generateCodeVerifier', () => {
  it('satisfies RFC 7636 §4.1: 43-128 chars from the unreserved set', () => {
    for (let i = 0; i < 50; i++) {
      const v = generateCodeVerifier()
      expect(v.length).toBeGreaterThanOrEqual(43)
      expect(v.length).toBeLessThanOrEqual(128)
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/)
    }
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCodeVerifier()))
    expect(seen.size).toBe(200)
  })
})

describe('deriveCodeChallenge', () => {
  // RFC 7636 Appendix B 官方向量。后端用同一组做校验,两边必须一致。
  it('matches the RFC 7636 Appendix B vector', () => {
    expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('is base64url with no padding', () => {
    expect(deriveCodeChallenge(generateCodeVerifier())).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('generateState', () => {
  it('is high-entropy base64url', () => {
    const s = generateState()
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(s.length).toBeGreaterThanOrEqual(43)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateState()))
    expect(seen.size).toBe(200)
  })
})
