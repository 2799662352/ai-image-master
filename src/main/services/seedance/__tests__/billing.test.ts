// 「这一次的钱从哪出」这个值有两个来源都**不可信**:渲染端的 IPC 载荷,和
// IndexedDB 里躺了不知道多久的卡片。所以进主进程之前要过一道收敛。
//
// 收敛的方向是有讲究的:认不出一律当「没带」,绝不猜成 platform。猜错方向的代价
// 不对称 —— 猜成 own-key 最多是回到接网关之前的老行为(vvdance 直连,报「请填
// 火山密钥」这种用户能自己解决的错);猜成 platform 会让一条自填 Key 的任务被拿
// 影子 token 去提交,钱记到组织头上,而桌面端事后查不出来。

import { describe, expect, it } from 'vitest'
import { coerceVideoBillingSource, createVideoBillingResolver } from '../billing'
import type { SeedanceGatewayTokenSources } from '../../seedanceGateway/credentials'

function sources(over: Partial<SeedanceGatewayTokenSources> = {}): SeedanceGatewayTokenSources {
  return { platformToken: () => null, ownKey: () => '', ...over }
}

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

/**
 * 路由(走哪条 transport)与取 token(用哪枚凭据)必须给出**同一个**结论。
 * 各判各的就会出现「按平台余额路由、拿自填 Key 提交」这种组合 —— 请求会成功,
 * 钱从错的钱包出,而两边的日志各自都看起来是对的。
 *
 * 所以这个 resolver 不自己写判据,直接复用 `resolveSeedanceGatewayToken` 的
 * `billing` 结论。下面的用例守的是「复用」这件事本身。
 */
describe('createVideoBillingResolver', () => {
  it('调用方给了意向就听它的 —— 这是 UI 那条路的全部意义', () => {
    // 🧬 主进程手上明明有影子 token,但渲染层说「我要用自填 Key」。
    // 这正是 credentials.ts「已知缺口」描述的那个窗口:渲染层已切 own-key,
    // 而 clearBillingPool() 失败被吞掉,主进程仍握着 activePool。
    // 让主进程按自己的镜像去猜,用户就会在不知情的情况下花掉平台余额。
    const resolve = createVideoBillingResolver(sources({ platformToken: () => 'shadow-1' }))
    expect(resolve('own-key')).toBe('own-key')
  })

  it('要平台余额但影子 token 取不到时,仍然回 platform —— 不悄悄改走自填 Key', () => {
    // 回 own-key 会让路由落到 vvdance 直连:用户以为花的是平台余额,扣的是他
    // 自己的火山密钥。回 platform 则会在 requireApiKey 那里抛出「请先选择计费池」
    // —— 响亮、可执行、一分钱不花。
    const resolve = createVideoBillingResolver(sources({ ownKey: () => 'miau-key' }))
    expect(resolve('platform')).toBe('platform')
  })

  it('没有意向(MCP 那条路)才看主进程手上有没有影子 token', () => {
    expect(createVideoBillingResolver(sources({ platformToken: () => 'shadow-1' }))()).toBe(
      'platform',
    )
    expect(createVideoBillingResolver(sources({ ownKey: () => 'miau-key' }))()).toBe('own-key')
  })

  it('两枚都没有时报 own-key —— 那是用户唯一能自己补上的一枚', () => {
    expect(createVideoBillingResolver(sources())()).toBe('own-key')
  })
})
