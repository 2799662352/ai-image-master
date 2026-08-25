// 全屏登录覆盖层的四态与三个出口。
//
// 这里刻意通过 mock 掉的 `window.electronAPI.auth` 断言,而不是去 spy store 的动作:
// 覆盖层的价值全在「点了按钮之后主进程收到了什么」,中间那层 store 已由
// `stores/__tests__/useAuthStore.test.ts` 单独盯着。断在桥上,接线错了才会红。
//
// 两条最值得测的:
// - 错误文案是主进程给的原文,渲染层不再按 code 映射一遍(否则两处文案各自漂移);
// - 错误态的「重试」必须重新 startLogin —— 授权码是一次性的,重放只会拿到 409。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthLoginResult, AuthState } from '../../../../types/authApi'
import { useAuthStore, __resetSubscriptionsForTesting } from '../../stores/useAuthStore'
import { useUIPrefsStore } from '../../stores/useUIPrefsStore'
import DesktopLoginPage from '../DesktopLoginPage'

const AUTHORIZE_URL = 'https://13797248455.xyz/desktop-auth?p=p1'

/** 主进程 `auth:login-result` 在 PAIRING_EXPIRED 上给出的原文,见 main/services/auth/ipc.ts。 */
const EXPIRED_MESSAGE = '登录已超时,请重新发起'

const LOGGED_IN: AuthState = {
  authenticated: true,
  username: 'alice',
  displayName: 'Alice',
  role: 'USER',
  credentialSource: 'safeStorage',
}
const LOGGED_OUT: AuthState = {
  authenticated: false,
  username: null,
  displayName: null,
  role: null,
  credentialSource: 'none',
}

let stateHandler: ((s: AuthState) => void) | null = null
let resultHandler: ((r: AuthLoginResult) => void) | null = null

const auth = {
  getState: vi.fn(),
  startLogin: vi.fn(),
  cancelLogin: vi.fn(),
  submitCode: vi.fn(),
  logout: vi.fn(),
  onStateChanged: vi.fn(),
  onLoginResult: vi.fn(),
}

const writeText = vi.fn()

beforeEach(() => {
  Object.values(auth).forEach((m) => m.mockReset())
  stateHandler = null
  resultHandler = null
  auth.onStateChanged.mockImplementation((h: (s: AuthState) => void) => {
    stateHandler = h
    return () => {}
  })
  auth.onLoginResult.mockImplementation((h: (r: AuthLoginResult) => void) => {
    resultHandler = h
    return () => {}
  })
  auth.getState.mockResolvedValue(LOGGED_OUT)
  auth.startLogin.mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresIn: 300 })
  auth.cancelLogin.mockResolvedValue(undefined)
  auth.submitCode.mockResolvedValue(undefined)
  auth.logout.mockResolvedValue(undefined)

  Object.defineProperty(window, 'electronAPI', { value: { auth }, configurable: true })

  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

  __resetSubscriptionsForTesting()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  // useUIPrefsStore 带 persist 中间件,jsdom 的 localStorage 跨用例存活 ——
  // 不显式重置的话,「点过稍后再说」会渗到后面的用例里。
  useUIPrefsStore.setState({ authOnboardingDismissed: false })
})

afterEach(() => {
  // vitest globals:false 下 RTL 不自动 cleanup,手动卸载防跨用例 DOM 残留。
  cleanup()
  __resetSubscriptionsForTesting()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

async function renderPage() {
  const utils = render(<DesktopLoginPage />)
  // 挂载 effect 里的 hydrate 是异步的,等它落地再断言,免得留下 act() 告警。
  await waitFor(() => expect(auth.getState).toHaveBeenCalled())
  return utils
}

// 登录是软门:自带 API Key 的功能不依赖它,断网时更不该被一块黑幕挡在外面。
// 没有这三条,下一个人重构时很容易又把它做回硬门 —— 而硬门在测试里看不出任何异常。
describe('DesktopLoginPage 软门', () => {
  it('未登录时提供「稍后再说」出口', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: '稍后再说' })).toBeTruthy()
  })

  it('点「稍后再说」后覆盖层让路,且不误伤登录按钮', async () => {
    await renderPage()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '稍后再说' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(auth.startLogin).not.toHaveBeenCalled()
  })

  it('跳过状态会持久化,重新挂载不再拦人', async () => {
    useUIPrefsStore.setState({ authOnboardingDismissed: true })
    await renderPage()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // partialize 漏掉这个字段的话:本次点了有效,下次启动覆盖层又回来 ——
  // 只在内存里生效的「跳过」不算跳过。
  it('跳过写进了 persist 的落盘负载', async () => {
    localStorage.removeItem('ui-prefs')
    await renderPage()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '稍后再说' }))
    })
    const raw = localStorage.getItem('ui-prefs')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).state.authOnboardingDismissed).toBe(true)
  })

  // 跳过只让 idle 态让路。用户之后主动登录时,等待/错误态照样要显示出来。
  it('跳过之后主动发起的登录仍然显示等待态', async () => {
    useUIPrefsStore.setState({ authOnboardingDismissed: true })
    await renderPage()
    act(() => {
      useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  // 「登录以继续」是硬门的说法,与「稍后再说」并列会自相矛盾。
  it('文案不宣称登录是使用应用的前提', async () => {
    await renderPage()
    expect(screen.queryByText('登录以继续')).toBeNull()
  })
})

describe('DesktopLoginPage', () => {
  it('挂载时同时接推送(ensureSubscriptions)和拉当前状态(hydrate)', async () => {
    await renderPage()
    // ensureSubscriptions 的可观测后果:两条推送通道都订阅上了。
    expect(auth.onStateChanged).toHaveBeenCalledTimes(1)
    expect(auth.onLoginResult).toHaveBeenCalledTimes(1)
    // hydrate 的可观测后果:拉了一次当前状态。
    expect(auth.getState).toHaveBeenCalledTimes(1)
  })

  it('idle 态给出登录入口,点击后发起 startLogin', async () => {
    await renderPage()
    const btn = screen.getByRole('button', { name: '使用浏览器登录' })
    await act(async () => {
      btn.click()
    })
    expect(auth.startLogin).toHaveBeenCalledTimes(1)
  })

  it('waiting 态提示已在浏览器打开,并给出三个出口', async () => {
    useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    await renderPage()

    expect(screen.getByText(/已在浏览器中打开/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制链接' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '手动输入授权码' })).toBeTruthy()
  })

  it('waiting 态点「取消」调 cancelLogin', async () => {
    useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    await renderPage()
    await act(async () => {
      screen.getByRole('button', { name: '取消' }).click()
    })
    expect(auth.cancelLogin).toHaveBeenCalledTimes(1)
  })

  it('waiting 态点「复制链接」把 authorizeUrl 写进剪贴板并给出反馈', async () => {
    useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    await renderPage()
    await act(async () => {
      screen.getByRole('button', { name: '复制链接' }).click()
    })
    expect(writeText).toHaveBeenCalledWith(AUTHORIZE_URL)
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy())
  })

  it('手动输入授权码后提交的是输入框里的值', async () => {
    useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    await renderPage()

    await act(async () => {
      screen.getByRole('button', { name: '手动输入授权码' }).click()
    })
    const input = screen.getByLabelText('授权码') as HTMLInputElement
    // 受控输入必须走 fireEvent.change:直接改 .value 会绕过 React 的 value tracker。
    fireEvent.change(input, { target: { value: 'pasted-grant-code' } })
    await act(async () => {
      screen.getByRole('button', { name: '提交授权码' }).click()
    })

    expect(auth.submitCode).toHaveBeenCalledWith('pasted-grant-code')
  })

  it('error 态显示主进程给的原文案,不泄漏裸 code', async () => {
    await renderPage()
    act(() => {
      resultHandler!({ ok: false, code: 'PAIRING_EXPIRED', message: EXPIRED_MESSAGE })
    })

    expect(screen.getByText(EXPIRED_MESSAGE)).toBeTruthy()
    // 渲染层若自己再按 code 映射一遍,迟早把 code 漏到脸上。
    expect(document.body.textContent).not.toContain('PAIRING_EXPIRED')
  })

  it('error 态的「重试」重新 startLogin,而不是重放 submitCode', async () => {
    useAuthStore.setState({ error: EXPIRED_MESSAGE })
    await renderPage()
    await act(async () => {
      screen.getByRole('button', { name: '重试' }).click()
    })

    expect(auth.startLogin).toHaveBeenCalledTimes(1)
    // 授权码一次性,重放只会拿到 409。
    expect(auth.submitCode).not.toHaveBeenCalled()
  })

  it('走完一次登录后显示成功提示', async () => {
    useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    await renderPage()
    // 主进程的真实顺序:先 state-changed 再 login-result(见 main 侧 ipc.test.ts)。
    act(() => {
      stateHandler!(LOGGED_IN)
    })
    act(() => {
      resultHandler!({ ok: true })
    })

    expect(screen.getByText(/登录成功/)).toBeTruthy()
  })

  it('启动时已登录则整个覆盖层不渲染(不闪一下成功提示)', async () => {
    auth.getState.mockResolvedValue(LOGGED_IN)
    useAuthStore.setState({ authenticated: true, username: 'alice', displayName: 'Alice' })
    const { container } = await renderPage()
    expect(container.firstChild).toBeNull()
  })

  it('pending 中不给登录入口(避免重复发起)', async () => {
    useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    await renderPage()
    expect(screen.queryByRole('button', { name: '使用浏览器登录' })).toBeNull()
  })
})
