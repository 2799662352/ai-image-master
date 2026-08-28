// 「用哪枚 token」的策略。这是本条链路上唯一一个需要**决策**的地方,所以它单独
// 成文件、单独有测试 —— 决策错了不会报错,只会把钱记到别人头上。

import { describe, expect, it, vi } from 'vitest'
import {
  createSeedanceGatewayTokenResolver,
  describeMissingGatewayToken,
  resolveSeedanceGatewayToken,
  type SeedanceGatewayTokenSources,
} from '../credentials'

function sources(over: Partial<SeedanceGatewayTokenSources> = {}): SeedanceGatewayTokenSources {
  return {
    platformToken: () => null,
    ownKey: () => '',
    ...over,
  }
}

describe('显式 platform', () => {
  it('用影子 token', () => {
    const s = sources({ platformToken: () => 'shadow-1', ownKey: () => 'own-1' })
    expect(resolveSeedanceGatewayToken(s, 'platform')).toEqual({
      billing: 'platform',
      token: 'shadow-1',
    })
  })

  it('影子 token 缺席时**绝不**偷偷用自填 Key', () => {
    // 静默回落 = 用户以为在花平台余额、实际在花自己的钱。宁可空手让上层报错。
    const ownKey = vi.fn(() => 'own-1')
    const s = sources({ platformToken: () => null, ownKey })
    expect(resolveSeedanceGatewayToken(s, 'platform')).toEqual({ billing: 'platform', token: '' })
    expect(ownKey).not.toHaveBeenCalled()
  })

  it('空串影子 token 与 null 同等对待', () => {
    const s = sources({ platformToken: () => '   ', ownKey: () => 'own-1' })
    expect(resolveSeedanceGatewayToken(s, 'platform').token).toBe('')
  })
})

describe('显式 own-key', () => {
  it('用自填 Miau Key,即便平台余额此刻是开着的', () => {
    const platformToken = vi.fn(() => 'shadow-1')
    const s = sources({ platformToken, ownKey: () => 'own-1' })
    expect(resolveSeedanceGatewayToken(s, 'own-key')).toEqual({ billing: 'own-key', token: 'own-1' })
    expect(platformToken).not.toHaveBeenCalled()
  })

  it('自填 Key 缺席时**绝不**偷偷用平台余额', () => {
    // 反方向同样致命:用户以为在花自己的 Key,实际在扣组织的钱。
    const s = sources({ platformToken: () => 'shadow-1', ownKey: () => '' })
    expect(resolveSeedanceGatewayToken(s, 'own-key')).toEqual({ billing: 'own-key', token: '' })
  })
})

describe('没有意向（MCP agent 那条路根本没有渲染层）', () => {
  it('平台余额已武装时走平台', () => {
    const s = sources({ platformToken: () => 'shadow-1', ownKey: () => 'own-1' })
    expect(resolveSeedanceGatewayToken(s)).toEqual({ billing: 'platform', token: 'shadow-1' })
  })

  it('平台余额没武装时退到自填 Key', () => {
    const s = sources({ platformToken: () => null, ownKey: () => 'own-1' })
    expect(resolveSeedanceGatewayToken(s)).toEqual({ billing: 'own-key', token: 'own-1' })
  })

  it('两枚都没有时报 own-key 的缺席（那是用户唯一能自己补上的一枚）', () => {
    expect(resolveSeedanceGatewayToken(sources())).toEqual({ billing: 'own-key', token: '' })
  })
})

describe('现取不缓存', () => {
  it('用户切了计费池,下一次提交就该换 token', () => {
    let current: string | null = 'pool-a'
    const s = sources({ platformToken: () => current })
    expect(resolveSeedanceGatewayToken(s).token).toBe('pool-a')
    current = 'pool-b'
    expect(resolveSeedanceGatewayToken(s).token).toBe('pool-b')
    current = null
    expect(resolveSeedanceGatewayToken(s).billing).toBe('own-key')
  })

  it('取值抛错不炸掉整条提交链路', () => {
    const s = sources({
      platformToken: () => {
        throw new Error('store not ready')
      },
      ownKey: () => 'own-1',
    })
    expect(resolveSeedanceGatewayToken(s)).toEqual({ billing: 'own-key', token: 'own-1' })
  })
})

describe('describeMissingGatewayToken', () => {
  it('两种缺席给的是两句不同的人话（补救动作完全不同）', () => {
    expect(describeMissingGatewayToken('platform')).toMatch(/计费池|平台余额/)
    expect(describeMissingGatewayToken('own-key')).toMatch(/Miau/)
    expect(describeMissingGatewayToken('platform')).not.toBe(describeMissingGatewayToken('own-key'))
  })
})

describe('createSeedanceGatewayTokenResolver', () => {
  it('回的是 token 与 billing 一对 —— 缺席时要靠 billing 决定报哪一句人话', () => {
    const resolve = createSeedanceGatewayTokenResolver(sources({ platformToken: () => 'shadow-1' }))
    expect(resolve()).toEqual({ billing: 'platform', token: 'shadow-1' })
  })

  it('意向每次现读 —— 用户中途切了计费模式不必重建 transport', () => {
    let prefer: 'platform' | 'own-key' | undefined = 'own-key'
    const resolve = createSeedanceGatewayTokenResolver(
      sources({ platformToken: () => 'shadow-1', ownKey: () => 'own-1' }),
      () => prefer,
    )
    expect(resolve().token).toBe('own-1')
    prefer = 'platform'
    expect(resolve().token).toBe('shadow-1')
  })
})
