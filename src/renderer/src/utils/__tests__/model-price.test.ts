import { describe, it, expect } from 'vitest'
import { extractPriceFromModel, formatPrice } from '../model-price'

describe('extractPriceFromModel', () => {
  it('优先使用 price 字段', () => {
    const model = { price: 0.06, displayName: '$0.03/张' }
    expect(extractPriceFromModel(model)).toBe(0.06)
  })

  it('price 字段为 0 也算有效(免费模型)', () => {
    const model = { price: 0, displayName: '$0.05/张' }
    expect(extractPriceFromModel(model)).toBe(0)
  })

  it('无 price 字段时从 displayName 抠 $X.XX/张', () => {
    const model = { displayName: '15s, gemini-3.1-flash, $0.045/张' }
    expect(extractPriceFromModel(model)).toBe(0.045)
  })

  it('支持整数价格', () => {
    expect(extractPriceFromModel({ displayName: '$1/张' })).toBe(1)
  })

  it('支持 / 张 之间有空格', () => {
    expect(extractPriceFromModel({ displayName: '$0.07 / 张 高质量' })).toBe(0.07)
  })

  it('完全匹配不到返回 0', () => {
    expect(extractPriceFromModel({ displayName: '没有价格信息的模型' })).toBe(0)
  })

  it('null/undefined 入参返回 0,不抛错', () => {
    expect(extractPriceFromModel(null)).toBe(0)
    expect(extractPriceFromModel(undefined)).toBe(0)
  })

  it('非对象入参返回 0', () => {
    expect(extractPriceFromModel('string')).toBe(0)
    expect(extractPriceFromModel(123)).toBe(0)
  })

  it('无 displayName 也无 price 返回 0', () => {
    expect(extractPriceFromModel({ name: '空模型' })).toBe(0)
  })

  it('忽略负数 price,回退 displayName', () => {
    const model = { price: -1, displayName: '$0.02/张' }
    expect(extractPriceFromModel(model)).toBe(0.02)
  })

  it('忽略非有限数 price,回退 displayName', () => {
    const model = { price: NaN, displayName: '$0.02/张' }
    expect(extractPriceFromModel(model)).toBe(0.02)
  })
})

describe('formatPrice', () => {
  it('正常价格格式化为三位小数', () => {
    expect(formatPrice(0.06)).toBe('$0.060')
    expect(formatPrice(0.09)).toBe('$0.090')
    expect(formatPrice(1.234)).toBe('$1.234')
  })

  it('0 / 负数 / 非数字 → "$ ?"', () => {
    expect(formatPrice(0)).toBe('$ ?')
    expect(formatPrice(-1)).toBe('$ ?')
    expect(formatPrice(NaN)).toBe('$ ?')
    expect(formatPrice(Infinity)).toBe('$ ?')
  })
})
