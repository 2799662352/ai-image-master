// 头部账号胶囊。
//
// 沿用 `AccountSection.test.tsx` 的范式:伪造 preload 桥、不 mock store —— 值全在
// 「store 与 UI 接线对不对」。
//
// 这里最值得测的三条,都是这次改动的**理由**本身:
// - 未登录时头部就有登录入口(在这之前只有进设置页才找得到);
// - 平台计费显示余额、自有 Key **不**显示 —— 那个数字此刻不是要花的钱,摆出来就是歧义;
// - 余额未知不催充值(该做的是选池/重试,不是掏钱)。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthState } from '../../../../../types/authApi'
import { useAuthStore, __resetSubscriptionsForTesting } from '../../../stores/useAuthStore'
import { useQuotaStore, __resetQuotaStoreForTesting } from '../../../stores/useQuotaStore'
import { AccountBadge } from '../AccountBadge'

const LOGGED_IN: AuthState = {
  authenticated: true,
  username: 'zuozuoliang',
  displayName: '左亮',
  role: 'ADMIN',
  credentialSource: 'safeStorage',
}
const LOGGED_OUT: AuthState = {
  authenticated: false,
  username: null,
  displayName: null,
  role: null,
  credentialSource: 'none',
}

const auth = {
  getState: vi.fn(),
  startLogin: vi.fn(),
  cancelLogin: vi.fn(),
  submitCode: vi.fn(),
  logout: vi.fn(),
  onStateChanged: vi.fn(),
  onLoginResult: vi.fn(),
  onBalanceStale: vi.fn(),
  getOrganizations: vi.fn(),
  getBalance: vi.fn(),
  getQuota: vi.fn(),
  getPaymentConfig: vi.fn(),
  getUsageLogs: vi.fn(),
  getUsageSummary: vi.fn(),
  createRechargeOrder: vi.fn(),
  getRechargeOrder: vi.fn(),
  setBillingPool: vi.fn(),
  clearBillingPool: vi.fn(),
}
const shell = { openExternal: vi.fn() }

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth, shell }, configurable: true })
  Object.values(auth).forEach((m) => m.mockReset())
  shell.openExternal.mockReset().mockResolvedValue({ success: true })

  auth.onStateChanged.mockReturnValue(() => {})
  auth.onLoginResult.mockReturnValue(() => {})
  auth.onBalanceStale.mockReturnValue(() => {})
  auth.getState.mockResolvedValue(LOGGED_OUT)
  auth.startLogin.mockResolvedValue({ authorizeUrl: 'https://x/desktop-auth', expiresIn: 300 })
  auth.getOrganizations.mockResolvedValue({
    ok: true,
    data: [{ id: 342, name: '个人计费', studioName: null, balanceYuan: 12.5, joined: true }],
  })
  auth.getPaymentConfig.mockResolvedValue({ ok: true, data: { personalBillingProjectId: 342 } })
  auth.getBalance.mockResolvedValue({ ok: true, data: { balanceYuan: 12.5, balanceQuota: 6_250_000 } })
  auth.getUsageLogs.mockResolvedValue({ ok: true, data: { rows: [], total: 0, page: 0, pageSize: 50 } })
  auth.getUsageSummary.mockResolvedValue({ ok: true, data: [] })
  auth.setBillingPool.mockResolvedValue({ ok: true, data: { ready: true } })
  auth.clearBillingPool.mockResolvedValue({ ok: true, data: null })

  localStorage.clear()
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
  localStorage.clear()
})

async function renderLoggedIn(
  patch: Partial<{ balanceYuan: number | null; billingSource: 'platform' | 'own-key' }> = {},
) {
  auth.getState.mockResolvedValue(LOGGED_IN)
  useAuthStore.setState({ authenticated: true, username: 'zuozuoliang', displayName: '左亮' })
  const utils = render(<AccountBadge />)
  await waitFor(() => expect(auth.getState).toHaveBeenCalled())
  // 直接落 store 而不是走 selectPool/setBillingSource:这个文件测的是**呈现**,
  // 让每条用例自己摆出想要的那个状态最省事,也不会把别的 store 逻辑的 bug
  // 混进这里的断言。
  await act(async () => {
    useQuotaStore.setState({
      selectedPool: { projectId: 342, producerProjectId: null },
      balanceYuan: 12.5,
      billingSource: 'platform',
      ...patch,
    })
  })
  return utils
}

describe('AccountBadge · 未登录', () => {
  /**
   * 🧬 变异点:把未登录那一支改成 `return null`,这条必红。
   *
   * 这是整次改动的核心 —— 在这之前,用户没有任何理由会想到去设置页里找登录。
   */
  it('头部直接给出登录入口', async () => {
    render(<AccountBadge />)
    await waitFor(() => expect(auth.getState).toHaveBeenCalled())

    expect(screen.getByTestId('account-badge-login')).toBeTruthy()
  })

  it('点登录直接起浏览器授权,不用先进设置页', async () => {
    render(<AccountBadge />)
    await waitFor(() => expect(auth.getState).toHaveBeenCalled())

    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge-login'))
    })

    expect(auth.startLogin).toHaveBeenCalled()
  })

  // 未登录时那几个额度端点都会 401,发过去只会在控制台留一串误导性的红字。
  it('未登录不发额度查询', async () => {
    render(<AccountBadge />)
    await waitFor(() => expect(auth.getState).toHaveBeenCalled())

    expect(auth.getOrganizations).not.toHaveBeenCalled()
    expect(auth.getBalance).not.toHaveBeenCalled()
  })
})

describe('AccountBadge · 已登录', () => {
  it('平台计费时头部常显余额', async () => {
    await renderLoggedIn()

    expect(screen.getByTestId('account-badge-balance').textContent).toBe('¥12.50')
  })

  /**
   * 🧬 变异点:把 `usingPlatform ? … : …` 那个三元去掉、无条件显示余额,这条必红。
   *
   * 自有 Key 模式下余额不是这次要花的钱。摆一个大额数字在头部,用户会以为出图
   * 走的是它 —— 而那正是这次要消灭的歧义(「我在花谁的钱」)。
   */
  it('自有 Key 时不显示余额,只标明计费方式', async () => {
    await renderLoggedIn({ billingSource: 'own-key' })

    expect(screen.queryByTestId('account-badge-balance')).toBeNull()
    expect(screen.getByTestId('account-badge-ownkey')).toBeTruthy()
  })

  it('点开面板能看到充值与使用明细', async () => {
    await renderLoggedIn()

    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })

    expect(screen.getByTestId('account-badge-panel')).toBeTruthy()
    expect(screen.getByTestId('account-badge-recharge')).toBeTruthy()
    expect(screen.getByTestId('account-badge-usage')).toBeTruthy()
  })

  it('再点一次收起', async () => {
    await renderLoggedIn()

    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })

    expect(screen.queryByTestId('account-badge-panel')).toBeNull()
  })

  it('Esc 收起', async () => {
    await renderLoggedIn()
    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(screen.queryByTestId('account-badge-panel')).toBeNull()
  })

  it('点面板外面收起', async () => {
    await renderLoggedIn()
    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })

    await act(async () => {
      fireEvent.mouseDown(document.body)
    })

    expect(screen.queryByTestId('account-badge-panel')).toBeNull()
  })

  /**
   * 🧬 变异点:把收起监听从 `mousedown` 换回 `click`,这条必红。
   *
   * 面板里的按钮点下去会先冒泡到 document 的 click,若用 click 收起,面板会在
   * 按钮自己的 onClick 之前就被卸载 —— 表现成「点充值没反应」。
   */
  it('点面板内部不会把面板收起', async () => {
    await renderLoggedIn()
    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })

    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('account-badge-panel'))
    })

    expect(screen.queryByTestId('account-badge-panel')).toBeTruthy()
  })
})

describe('AccountBadge · 余额档位', () => {
  async function openPanel(patch: Parameters<typeof renderLoggedIn>[0]) {
    await renderLoggedIn(patch)
    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })
  }

  /**
   * 🧬 变异点:把「余额未知」也走成 empty 分支(催充值),这条必红。
   *
   * 查不到余额时该做的是选池或重试,不是掏钱。催错了方向,用户会充完发现
   * 数字还是不显示。
   */
  it('余额未知时不催充值', async () => {
    await openPanel({ balanceYuan: null })

    expect(screen.getByTestId('account-badge-panel-balance').textContent).toBe('余额未知')
    expect(screen.queryByText(/充值后才能继续/)).toBeNull()
  })

  it('余额用尽时明确说要充值', async () => {
    await openPanel({ balanceYuan: 0 })

    expect(screen.getByTestId('account-badge-panel-balance').textContent).toBe('¥0.00')
    expect(screen.getByText(/充值后才能继续/)).toBeTruthy()
  })

  it('余额偏低时提醒但不说已用尽', async () => {
    await openPanel({ balanceYuan: 1.2 })

    expect(screen.getByText('余额不多了。')).toBeTruthy()
    expect(screen.queryByText(/充值后才能继续/)).toBeNull()
  })

  it('余额充裕时不出提醒', async () => {
    await openPanel({ balanceYuan: 100 })

    expect(screen.queryByText('余额不多了。')).toBeNull()
    expect(screen.queryByText(/充值后才能继续/)).toBeNull()
  })
})

describe('AccountBadge · 未选池', () => {
  // 没有池就发不出用量查询、也建不了充值单。禁用比「点了拿一个 400」好 ——
  // 后者要等一个 RTT 才告诉用户「你还没选池」,而这件事本地就知道。
  it('充值与使用明细都禁用,并说明原因', async () => {
    auth.getState.mockResolvedValue(LOGGED_IN)
    useAuthStore.setState({ authenticated: true, username: 'zuozuoliang', displayName: '左亮' })
    render(<AccountBadge />)
    await waitFor(() => expect(auth.getState).toHaveBeenCalled())
    await act(async () => {
      useQuotaStore.setState({ selectedPool: null, balanceYuan: null, billingSource: 'platform' })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('account-badge'))
    })

    expect((screen.getByTestId('account-badge-recharge') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('account-badge-usage') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('还没选计费池。')).toBeTruthy()
  })
})
