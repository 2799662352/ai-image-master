// 设置页 · 账号分区。
//
// 这个目录此前不存在 —— 组件的头部注释说「分区只依赖 auth 桥、能单测」,但一直没测。
// 加额度展示时先把它建起来。
//
// 按 `stores/__tests__/useAuthStore.test.ts` 的范式伪造 preload 桥
// (`Object.defineProperty(window, 'electronAPI', …)`),不 mock store —— 值全在
// 「store 与 UI 接线对不对」,把 store 也 mock 掉就只剩渲染快照了。
//
// 三条最值得测的:
// - 未登录时**不该**发额度查询(那几个端点都要鉴权,发了只会拿 401);
// - 余额未知时显示占位而**不是 ¥0.00**(0 会让用户以为余额空了);
// - 充值必须走 `shell.openExternal` —— `will-navigate` 只允许同源,应用内导航会被拦。

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthState } from '../../../../../types/authApi'
import { useAuthStore, __resetSubscriptionsForTesting } from '../../../stores/useAuthStore'
import { useQuotaStore, __resetQuotaStoreForTesting } from '../../../stores/useQuotaStore'
import { AccountSection } from '../AccountSection'

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
  getOrganizations: vi.fn(),
  getBalance: vi.fn(),
  getQuota: vi.fn(),
  getPaymentConfig: vi.fn(),
  // 抽屉与充值弹窗是**真组件**,不 mock —— 这一层要验的恰好是「有没有把对的 pool
  // 传下去」,把子组件换成桩就正好把被测的接线抹掉了。所以它们的 IPC 也得备着。
  getUsageLogs: vi.fn(),
  getUsageSummary: vi.fn(),
  createRechargeOrder: vi.fn(),
  getRechargeOrder: vi.fn(),
}
const shell = { openExternal: vi.fn() }

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth, shell }, configurable: true })
  Object.values(auth).forEach((m) => m.mockReset())
  shell.openExternal.mockReset().mockResolvedValue({ success: true })

  auth.onStateChanged.mockReturnValue(() => {})
  auth.onLoginResult.mockReturnValue(() => {})
  auth.getState.mockResolvedValue(LOGGED_OUT)
  auth.logout.mockResolvedValue(undefined)
  auth.startLogin.mockResolvedValue({ authorizeUrl: 'https://x/desktop-auth', expiresIn: 300 })
  auth.getOrganizations.mockResolvedValue({
    ok: true,
    data: [{ id: 342, name: '个人计费', studioName: null, balanceYuan: 0.26, joined: true }],
  })
  auth.getPaymentConfig.mockResolvedValue({ ok: true, data: { personalBillingProjectId: 342 } })
  auth.getBalance.mockResolvedValue({ ok: true, data: { balanceYuan: 0.26, balanceQuota: 130_000 } })
  auth.getQuota.mockResolvedValue({ ok: true, data: {} })
  auth.getUsageLogs.mockResolvedValue({
    ok: true,
    data: { rows: [], total: 0, page: 0, pageSize: 50 },
  })
  auth.getUsageSummary.mockResolvedValue({ ok: true, data: [] })

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

async function renderLoggedIn() {
  auth.getState.mockResolvedValue(LOGGED_IN)
  useAuthStore.setState({ authenticated: true, username: 'zuozuoliang', displayName: '左亮', role: 'ADMIN' })
  const utils = render(<AccountSection />)
  await waitFor(() => expect(auth.getState).toHaveBeenCalled())
  return utils
}

/**
 * 选中个人计费池。
 *
 * `load()` **不会**自动选池(它只恢复上次存下的选择,而测试里 localStorage 是清空的),
 * 所以默认渲染出来就是「未选池」—— 那正好是下面几条禁用用例要的初始态。
 */
function selectPool(): void {
  act(() => {
    useQuotaStore.setState({
      selectedPool: { projectId: 342, producerProjectId: null },
      balanceYuan: 0.26,
    })
  })
}

describe('AccountSection', () => {
  it('未登录时给出登录入口,不展示余额', async () => {
    render(<AccountSection />)
    await waitFor(() => expect(auth.getState).toHaveBeenCalled())

    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy()
    expect(screen.queryByTestId('account-balance')).toBeNull()
  })

  // 额度那几个端点都挂 authMiddleware,未登录发过去只会拿 401 —— 白发请求还会在
  // 控制台留下误导性的报错。
  it('未登录时不发额度查询', async () => {
    render(<AccountSection />)
    await waitFor(() => expect(auth.getState).toHaveBeenCalled())

    expect(auth.getOrganizations).not.toHaveBeenCalled()
    expect(auth.getPaymentConfig).not.toHaveBeenCalled()
  })

  it('已登录时展示身份并加载额度', async () => {
    await renderLoggedIn()
    expect(screen.getByText('左亮')).toBeTruthy()
    await waitFor(() => expect(auth.getOrganizations).toHaveBeenCalledTimes(1))
  })

  it('展示所选池的余额', async () => {
    await renderLoggedIn()
    act(() => {
      useQuotaStore.setState({
        selectedPool: { projectId: 342, producerProjectId: null },
        balanceYuan: 12.5,
      })
    })
    expect(screen.getByTestId('account-balance').textContent).toContain('12.50')
  })

  // **余额未知 ≠ 余额为零。** 显示 ¥0.00 会让用户以为钱花光了,跑去充值 ——
  // 而真实原因可能只是还没选池、或查询失败。
  it('余额未知时显示占位,不显示 ¥0.00', async () => {
    await renderLoggedIn()
    act(() => {
      useQuotaStore.setState({ balanceYuan: null })
    })
    const el = screen.getByTestId('account-balance')
    expect(el.textContent).not.toContain('0.00')
  })

  it('真的是 0 余额时如实显示 ¥0.00', async () => {
    await renderLoggedIn()
    act(() => {
      useQuotaStore.setState({
        selectedPool: { projectId: 342, producerProjectId: null },
        balanceYuan: 0,
      })
    })
    expect(screen.getByTestId('account-balance').textContent).toContain('0.00')
  })

  // 这里曾经是 `openExternal('https://13797248455.xyz/home')` —— 一个真 bug:
  // 首页**到不了充值表单**(表单是 `/space` 画布页上的弹窗组件,`/plan` 只是充值
  // *记录*页),点了等于把用户丢到首页自己找。而 payUrl 是支付宝每次现签、含订单号、
  // 10 分钟过期的一次性地址,压根拼不出来 —— 只能走「建单 → 开浏览器 → 轮询」。
  // 所以充值现在开原生弹窗,`openExternal` 由弹窗在拿到 payUrl 之后自己调。
  it('点充值开原生弹窗,而不是把用户丢到网页首页', async () => {
    await renderLoggedIn()
    selectPool()

    await act(async () => {
      screen.getByRole('button', { name: /充值/ }).click()
    })

    expect(screen.getByTestId('recharge-modal')).toBeTruthy()
    // 关键的负向断言:这一步不该有任何跳转。跳转发生在弹窗里、拿到 payUrl 之后。
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('组织可选,选中后向主进程查该池余额', async () => {
    auth.getOrganizations.mockResolvedValue({
      ok: true,
      data: [
        { id: 342, name: '个人计费', studioName: null, balanceYuan: 0.26, joined: true },
        { id: 700, name: 'Seedance', studioName: 'S', balanceYuan: 12, joined: true, producerProjectId: 5 },
      ],
    })
    await renderLoggedIn()
    await waitFor(() => expect(auth.getOrganizations).toHaveBeenCalled())

    const select = screen.getByTestId('account-pool-select') as HTMLSelectElement
    await act(async () => {
      select.value = '700:5'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => expect(auth.getBalance).toHaveBeenCalledWith(700, 5))
  })

  it('额度查询失败时把文案显示出来', async () => {
    auth.getOrganizations.mockResolvedValue({
      ok: false,
      error: { code: 'QUERY_FAILED', message: '无法连接额度服务' },
    })
    await renderLoggedIn()
    await waitFor(() => expect(screen.getByText('无法连接额度服务')).toBeTruthy())
  })

  it('退出登录后不再展示余额', async () => {
    await renderLoggedIn()
    act(() => {
      useQuotaStore.setState({
        selectedPool: { projectId: 342, producerProjectId: null },
        balanceYuan: 5,
      })
    })
    expect(screen.getByTestId('account-balance')).toBeTruthy()

    act(() => {
      useAuthStore.setState({ authenticated: false, username: null, displayName: null, role: null })
    })
    expect(screen.queryByTestId('account-balance')).toBeNull()
  })

  it('渲染出的 DOM 里不含 token 之类的机密字段', async () => {
    const { container } = await renderLoggedIn()
    expect(container.innerHTML).not.toMatch(/token|jwt|sk-/i)
  })

  // 两个入口都要:余额数字本身可点(对齐网页端 `title="查看使用明细"` 那个交互),
  // 另给一个显式文字按钮 —— 只做可点数字的话,没人猜得到那串数字能点。
  describe('使用明细的两个入口', () => {
    it('余额数字可点,点了开抽屉', async () => {
      await renderLoggedIn()
      selectPool()

      const balance = screen.getByTestId('account-balance')
      expect(balance.tagName).toBe('BUTTON')
      expect(balance.getAttribute('title')).toContain('明细')

      await act(async () => {
        balance.click()
      })
      expect(screen.getByTestId('usage-drawer-root')).toBeTruthy()
    })

    it('显式「使用明细」按钮也能开抽屉', async () => {
      await renderLoggedIn()
      selectPool()

      await act(async () => {
        screen.getByTestId('account-usage-entry').click()
      })
      expect(screen.getByTestId('usage-drawer-root')).toBeTruthy()
    })

    it('把当前选中的池传给抽屉,不是自己另查一个', async () => {
      await renderLoggedIn()
      act(() => {
        useQuotaStore.setState({
          selectedPool: { projectId: 700, producerProjectId: 5 },
          balanceYuan: 12,
        })
      })

      await act(async () => {
        screen.getByTestId('account-usage-entry').click()
      })

      // 抽屉自己会按 pool 发查询。断在这里而不是断 props:props 断言换个写法就假绿,
      // 而「发出去的 projectId 对不对」是用户真正看到的东西。
      await waitFor(() =>
        expect(auth.getUsageLogs).toHaveBeenCalledWith(expect.objectContaining({ projectId: 700 })),
      )
    })

    it('抽屉关掉后从 DOM 里消失', async () => {
      await renderLoggedIn()
      selectPool()
      await act(async () => {
        screen.getByTestId('account-usage-entry').click()
      })
      expect(screen.getByTestId('usage-drawer-root')).toBeTruthy()

      await act(async () => {
        screen.getByTestId('usage-close').click()
      })
      expect(screen.queryByTestId('usage-drawer-root')).toBeNull()
    })
  })

  // 用量端点的 `projectId` 必填才有意义,建单也必须有项目上下文 —— 未选池时两个动作
  // 都发不出去。禁用比「点了拿一个 400」好:后者要等一个 RTT 才告诉用户「你还没选池」。
  describe('未选池时的禁用', () => {
    it('未选池时明细入口禁用,点不开抽屉', async () => {
      await renderLoggedIn()

      const entry = screen.getByTestId('account-usage-entry') as HTMLButtonElement
      expect(entry.disabled).toBe(true)

      await act(async () => {
        entry.click()
      })
      expect(screen.queryByTestId('usage-drawer-root')).toBeNull()
    })

    it('未选池时充值禁用,点不开弹窗', async () => {
      await renderLoggedIn()

      const btn = screen.getByRole('button', { name: /充值/ }) as HTMLButtonElement
      expect(btn.disabled).toBe(true)

      await act(async () => {
        btn.click()
      })
      expect(screen.queryByTestId('recharge-modal')).toBeNull()
    })
  })
})
