// 「这一次的钱从哪出」这个值有两个来源都**不可信**:渲染端的 IPC 载荷,和
// IndexedDB 里躺了不知道多久的卡片。所以进主进程之前要过一道收敛。
//
// 收敛的方向是有讲究的:认不出一律当「没带」,绝不猜成 platform。猜错方向的代价
// 不对称 —— 猜成 own-key 最多是回到接网关之前的老行为(vvdance 直连,报「请填
// 火山密钥」这种用户能自己解决的错);猜成 platform 会让一条自填 Key 的任务被拿
// 影子 token 去提交,钱记到组织头上,而桌面端事后查不出来。

import { describe, expect, it } from 'vitest'
import { coerceVideoBillingSource } from '../billing'

describe('coerceVideoBillingSource', () => {
  it('两个合法值原样放行', () => {
    expect(coerceVideoBillingSource('platform')).toBe('platform')
    expect(coerceVideoBillingSource('own-key')).toBe('own-key')
  })

  it('缺省 / 认不出 / 非字符串一律当没带', () => {
    for (const raw of [undefined, null, '', 'Platform', 'PLATFORM', 'ownkey', 'own_key', 1, {}, []]) {
      expect(coerceVideoBillingSource(raw), JSON.stringify(raw)).toBeUndefined()
    }
  })

  it('绝不把认不出的值猜成 platform', () => {
    // 反方向的成本不对称:猜 own-key 只是回到老行为,猜 platform 是把钱记到
    // 别人头上。这条用例守的就是这个不对称。
    expect(coerceVideoBillingSource('plat form')).not.toBe('platform')
    expect(coerceVideoBillingSource(true)).not.toBe('platform')
  })
})
