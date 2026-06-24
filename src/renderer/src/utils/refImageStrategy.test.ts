import { describe, it, expect } from 'vitest'
import { wantsInlineBase64ForModel } from './refImageStrategy'

describe('wantsInlineBase64ForModel', () => {
  it('returns true only when inlineRefImageAsBase64 === true', () => {
    expect(wantsInlineBase64ForModel({ inlineRefImageAsBase64: true })).toBe(true)
  })

  it('returns false when flag is explicitly false (default URL path)', () => {
    expect(wantsInlineBase64ForModel({ inlineRefImageAsBase64: false })).toBe(false)
  })

  it('returns false when flag is undefined on the config', () => {
    expect(wantsInlineBase64ForModel({})).toBe(false)
  })

  it('returns false for undefined / null config', () => {
    expect(wantsInlineBase64ForModel(undefined)).toBe(false)
    expect(wantsInlineBase64ForModel(null)).toBe(false)
  })

  it('does not treat truthy non-true values as inline (strict equality)', () => {
    // 防御:配置被误写成字符串/1 等 truthy 值时,仍走 URL 而非误内联。
    expect(wantsInlineBase64ForModel({ inlineRefImageAsBase64: 1 as unknown as boolean })).toBe(false)
  })
})
