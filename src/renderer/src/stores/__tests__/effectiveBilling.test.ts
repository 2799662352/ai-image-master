// 「有效计费来源」:选中设置页「自定义网关」时一律是自填 Key。
//
// 这条规则的意义是钱:平台余额的钱包、影子 token 与归属头只对官方网关有效。
// 视频工作台 / 智能擦除是直接读 `useQuotaStore.billingSource` 放进提交载荷的,
// 若不经这一层,用户选了自己的网关、偏好却还是平台余额时,提交会被路由到官方网关上的
// 平台通道 —— 花掉组织的钱,而界面上显示的是「自定义网关」。

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetEffectiveBillingForTests,
  effectiveBillingSource,
  getEffectiveBillingSource,
  isCustomGatewaySelectedNow,
  setCustomGatewaySelected,
  useEffectiveBillingSource,
} from '../effectiveBilling'
import { useQuotaStore } from '../useQuotaStore'

describe('effectiveBillingSource(纯函数)', () => {
  it('没选自定义网关:原样返回偏好', () => {
    expect(effectiveBillingSource('platform', false)).toBe('platform')
    expect(effectiveBillingSource('own-key', false)).toBe('own-key')
  })

  it('选了自定义网关:无论偏好是什么都是自填 Key', () => {
    expect(effectiveBillingSource('platform', true)).toBe('own-key')
    expect(effectiveBillingSource('own-key', true)).toBe('own-key')
  })
})

describe('getEffectiveBillingSource / setCustomGatewaySelected', () => {
  let original: ReturnType<typeof useQuotaStore.getState>['billingSource']

  beforeEach(() => {
    __resetEffectiveBillingForTests()
    original = useQuotaStore.getState().billingSource
  })

  afterEach(() => {
    useQuotaStore.setState({ billingSource: original })
    __resetEffectiveBillingForTests()
  })

  it('缺省没选中:跟着偏好走', () => {
    expect(isCustomGatewaySelectedNow()).toBe(false)
    useQuotaStore.setState({ billingSource: 'platform' })
    expect(getEffectiveBillingSource()).toBe('platform')
    useQuotaStore.setState({ billingSource: 'own-key' })
    expect(getEffectiveBillingSource()).toBe('own-key')
  })

  it('选中后偏好仍是平台余额也拿到自填 Key,取消后恢复(偏好本身没被改写)', () => {
    useQuotaStore.setState({ billingSource: 'platform' })
    setCustomGatewaySelected(true)
    expect(getEffectiveBillingSource()).toBe('own-key')
    // 偏好原样保留:用户切回官方网关时不该发现自己的「平台余额」选择丢了。
    expect(useQuotaStore.getState().billingSource).toBe('platform')

    setCustomGatewaySelected(false)
    expect(getEffectiveBillingSource()).toBe('platform')
  })
})

describe('useEffectiveBillingSource(React hook)', () => {
  let original: ReturnType<typeof useQuotaStore.getState>['billingSource']

  beforeEach(() => {
    __resetEffectiveBillingForTests()
    original = useQuotaStore.getState().billingSource
    useQuotaStore.setState({ billingSource: 'platform' })
  })

  afterEach(() => {
    useQuotaStore.setState({ billingSource: original })
    __resetEffectiveBillingForTests()
  })

  it('页面挂着不卸载时,切到自定义网关会立刻重渲染成自填 Key', () => {
    // 工作台页切页后不一定卸载;只在挂载时读一次的话,用户在设置页切换后
    // 回来的第一次点击仍会按旧值提交。
    const { result } = renderHook(() => useEffectiveBillingSource())
    expect(result.current).toBe('platform')

    act(() => setCustomGatewaySelected(true))
    expect(result.current).toBe('own-key')

    act(() => setCustomGatewaySelected(false))
    expect(result.current).toBe('platform')
  })

  it('偏好变化也会重渲染(未选自定义网关时)', () => {
    const { result } = renderHook(() => useEffectiveBillingSource())
    act(() => useQuotaStore.setState({ billingSource: 'own-key' }))
    expect(result.current).toBe('own-key')
  })

  it('选中状态下偏好怎么变都稳定是自填 Key', () => {
    setCustomGatewaySelected(true)
    const { result } = renderHook(() => useEffectiveBillingSource())
    expect(result.current).toBe('own-key')
    act(() => useQuotaStore.setState({ billingSource: 'platform' }))
    expect(result.current).toBe('own-key')
  })

  it('重复设置同一个值不通知(没有多余重渲染)', () => {
    let renders = 0
    renderHook(() => {
      renders += 1
      return useEffectiveBillingSource()
    })
    const before = renders
    act(() => setCustomGatewaySelected(false))
    act(() => setCustomGatewaySelected(false))
    expect(renders).toBe(before)
  })
})
