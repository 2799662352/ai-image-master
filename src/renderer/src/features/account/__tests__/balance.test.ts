import { describe, expect, it } from 'vitest'
import { LOW_BALANCE_YUAN, balanceLevel, balanceText } from '../balance'

describe('balanceText', () => {
  /**
   * 🧬 变异点:把 `if (yuan === null)` 改成 `if (!yuan)`,这条必红。
   *
   * `0` 也是 falsy —— 那一改会让「刚好花光」显示成「余额未知」,而这两句话指向
   * 相反的下一步:未知要去选池/重试,花光了要去充钱。
   */
  it('未知与零是两句不同的话', () => {
    expect(balanceText(null)).toBe('余额未知')
    expect(balanceText(0)).toBe('¥0.00')
  })

  it('固定两位小数', () => {
    expect(balanceText(12.3)).toBe('¥12.30')
    expect(balanceText(12.345)).toBe('¥12.35')
  })

  // 上游允许预扣与结算之间出现负值,不能显示成 `¥-0.50` 之外的样子(比如被
  // 当成未知而吞掉)——用户得知道自己欠着。
  it('负数照实显示', () => {
    expect(balanceText(-0.5)).toBe('¥-0.50')
  })
})

describe('balanceLevel', () => {
  it('null 是未知,不是告急', () => {
    expect(balanceLevel(null)).toBe('unknown')
  })

  /**
   * 🧬 变异点:把 `yuan <= 0` 改成 `yuan < 0`,这条必红。
   *
   * 刚好 0 元时还按 `low` 处理的话,面板上会写「余额不多了」而不是「已用尽,
   * 充值后才能继续」—— 而此刻用户点出图一定失败。
   */
  it('零和负数都算用尽', () => {
    expect(balanceLevel(0)).toBe('empty')
    expect(balanceLevel(-1)).toBe('empty')
  })

  it('低于阈值算偏低,到阈值就算正常', () => {
    expect(balanceLevel(LOW_BALANCE_YUAN - 0.01)).toBe('low')
    expect(balanceLevel(LOW_BALANCE_YUAN)).toBe('ok')
  })

  it('充裕时是 ok', () => {
    expect(balanceLevel(100)).toBe('ok')
  })
})
