// 出图按钮下方的计费提示条。
//
// 这一条要守的不变量只有一句:**按下去之前,用户知道花的是谁的钱。**
// 余额档位决定声量 —— 充裕时一行灰字,偏低/用尽才升级成带充值按钮的警告。

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore, __resetSubscriptionsForTesting } from '../../../stores/useAuthStore'
import { useQuotaStore, __resetQuotaStoreForTesting } from '../../../stores/useQuotaStore'
import { BillingHintBar } from '../BillingHintBar'

const ORG_STUDIO = {
  id: 700,
  name: 'Seedance',
  studioName: '猫工作室',
  balanceYuan: 12,
  joined: true,
  producerProjectId: 5,
}

const auth = {
  getState: vi.fn(),
  onStateChanged: vi.fn(),
  onLoginResult: vi.fn(),
  onBalanceStale: vi.fn(),
  createRechargeOrder: vi.fn(),
  getRechargeOrder: vi.fn(),
  getPaymentConfig: vi.fn(),
}
const shell = { openExternal: vi.fn() }

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth, shell }, configurable: true })
  Object.values(auth).forEach((m) => m.mockReset())
  shell.openExternal.mockReset().mockResolvedValue({ success: true })
  auth.onStateChanged.mockReturnValue(() => {})
  auth.onLoginResult.mockReturnValue(() => {})
  auth.onBalanceStale.mockReturnValue(() => {})

  __resetSubscriptionsForTesting()
  __resetQuotaStoreForTesting()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  useQuotaStore.setState(useQuotaStore.getInitialState(), true)
})

afterEach(() => {
  cleanup()
  __resetSubscriptionsForTesting()
  __resetQuotaStoreForTesting()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function setQuota(patch: Partial<ReturnType<typeof useQuotaStore.getState>>): void {
  act(() => {
    useQuotaStore.setState(patch)
  })
}

function loggedIn(): void {
  act(() => {
    useAuthStore.setState({ authenticated: true, username: 'u', displayName: '左亮' })
  })
}

describe('BillingHintBar', () => {
  /**
   * 🧬 变异点:去掉 `if (!authenticated) return null`,这条必红。
   *
   * 未登录时头部胶囊已经是一枚「登录」按钮,这里再劝一次是重复劝导;而且未登录的人
   * 多半正拿自有 Key 正常干活,不该被打扰。
   */
  it('未登录时什么都不渲染', () => {
    render(<BillingHintBar />)

    expect(screen.queryByTestId('billing-hint-bar')).toBeNull()
  })

  /**
   * 🧬 变异点:把自有 Key 那一支也 `return null`,这条必红。
   *
   * 用户可能刚在设置页切过来,而出图页上没有任何别的东西会告诉他这次不走账号余额。
   */
  it('自有 Key 时明说走的是自填密钥', () => {
    loggedIn()
    setQuota({ billingSource: 'own-key' })
    render(<BillingHintBar />)

    expect(screen.getByTestId('billing-hint-bar').textContent).toContain('自有 Key')
  })

  it('余额充裕时是一行陈述,带池名和余额,不给充值按钮', () => {
    loggedIn()
    setQuota({
      billingSource: 'platform',
      organizations: [ORG_STUDIO],
      selectedPool: { projectId: 700, producerProjectId: 5 },
      balanceYuan: 88,
    })
    render(<BillingHintBar />)

    const text = screen.getByTestId('billing-hint-bar').textContent ?? ''
    expect(text).toContain('猫工作室 / Seedance')
    expect(text).toContain('¥88.00')
    expect(screen.queryByTestId('billing-hint-recharge')).toBeNull()
  })

  /**
   * 🧬 变异点:把 `level === 'ok' ? … : ''` 改成无条件拼余额,这条必红。
   *
   * 余额未知时把「余额未知」拼进这句,会让一句本来只是交代钱包的话看起来像报错。
   */
  it('余额未知时只说钱包,不把「未知」拼进去', () => {
    loggedIn()
    setQuota({
      billingSource: 'platform',
      organizations: [ORG_STUDIO],
      selectedPool: { projectId: 700, producerProjectId: 5 },
      balanceYuan: null,
    })
    render(<BillingHintBar />)

    const text = screen.getByTestId('billing-hint-bar').textContent ?? ''
    expect(text).toContain('猫工作室 / Seedance')
    expect(text).not.toContain('余额未知')
    expect(screen.queryByTestId('billing-hint-recharge')).toBeNull()
  })

  it('余额偏低时升级成警告并给出充值入口', () => {
    loggedIn()
    setQuota({
      billingSource: 'platform',
      organizations: [ORG_STUDIO],
      selectedPool: { projectId: 700, producerProjectId: 5 },
      balanceYuan: 1.5,
    })
    render(<BillingHintBar />)

    expect(screen.getByTestId('billing-hint-bar').textContent).toContain('只剩 ¥1.50')
    expect(screen.getByTestId('billing-hint-recharge')).toBeTruthy()
  })

  // 这就是「余额不足时的行内补救」:不必先撞一次失败,再自己找去哪充钱。
  it('余额用尽时直说这次会失败,并给充值入口', () => {
    loggedIn()
    setQuota({
      billingSource: 'platform',
      organizations: [ORG_STUDIO],
      selectedPool: { projectId: 700, producerProjectId: 5 },
      balanceYuan: 0,
    })
    render(<BillingHintBar />)

    expect(screen.getByTestId('billing-hint-bar').textContent).toContain('这次出图会失败')
    expect(screen.getByTestId('billing-hint-recharge')).toBeTruthy()
  })

  /**
   * 🧬 变异点:把 `poolLabelOf` 的比对从 `samePool` 换成只比 `projectId`,这条必红。
   *
   * 两个 producer 池共用同一个 projectId 是真实存在的形状。只比一半的话,提示里
   * 显示的是**另一个池**的名字 —— 而这一整条的存在意义就是「说清这次花谁的钱」。
   */
  it('两个池共用 projectId 时,认的是选中的那一个', () => {
    loggedIn()
    setQuota({
      billingSource: 'platform',
      organizations: [
        { ...ORG_STUDIO, name: 'A 池', producerProjectId: 5 },
        { ...ORG_STUDIO, name: 'B 池', producerProjectId: 6 },
      ],
      selectedPool: { projectId: 700, producerProjectId: 6 },
      balanceYuan: 50,
    })
    render(<BillingHintBar />)

    const text = screen.getByTestId('billing-hint-bar').textContent ?? ''
    expect(text).toContain('B 池')
    expect(text).not.toContain('A 池')
  })

  // 池名查不到时省略这半句,而不是编一个或写「未知计费池」—— 后者读起来像出错了。
  it('池名查不到时退回泛称,不显示「未知」', () => {
    loggedIn()
    setQuota({
      billingSource: 'platform',
      organizations: [],
      selectedPool: { projectId: 999, producerProjectId: null },
      balanceYuan: 50,
    })
    render(<BillingHintBar />)

    const text = screen.getByTestId('billing-hint-bar').textContent ?? ''
    expect(text).toContain('账号余额')
    expect(text).not.toContain('未知')
  })

  it('点充值能打开充值弹窗', async () => {
    loggedIn()
    setQuota({
      billingSource: 'platform',
      organizations: [ORG_STUDIO],
      selectedPool: { projectId: 700, producerProjectId: 5 },
      balanceYuan: 0,
    })
    render(<BillingHintBar />)

    await act(async () => {
      screen.getByTestId('billing-hint-recharge').click()
    })

    // 锚在弹窗自己的 testid 上,不用文本 —— `/充值/` 同时命中触发它的那个按钮,
    // 那样即便弹窗没开也照样绿。
    await waitFor(() => expect(screen.getByTestId('recharge-modal')).toBeTruthy())
  })
})
