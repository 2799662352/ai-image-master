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

// **覆盖层只在有进行中的登录流程时现身。**
//
// 这几条是防回归用的。它是 `fixed inset-0 z-[75000]`,一旦在 idle 态也渲染,就会盖住
// 整个应用:既有用户凭空多出一道墙,全部 16 个 E2E 文件点不到底下的任何东西 ——
// 而症状是 `locator.click` 超时 30 秒,不是显式失败,极难一眼归因(CI 上真的发生过)。
// 单测里更是完全看不出异常,所以必须有这几条钉住。
describe('DesktopLoginPage 只在登录流程中现身', () => {
  it('idle 态整个不渲染(启动时不挡应用)', async () => {
    await renderPage()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('desktop-login-overlay')).toBeNull()
  })

  it('idle 态不占据任何 DOM —— 不是靠 CSS 隐藏', async () => {
    const { container } = await renderPage()
    expect(container.innerHTML).toBe('')
  })

  it('用户从设置页发起登录后(pending)才出现', async () => {
    await renderPage()
    act(() => {
      useAuthStore.setState({ pending: true, authorizeUrl: AUTHORIZE_URL })
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('登录失败(error)时也出现,承载重试出口', async () => {
    await renderPage()
    act(() => {
      useAuthStore.setState({ pending: false, error: '登录已超时,请重新发起' })
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('登录已超时,请重新发起')).toBeTruthy()
  })

  it('idle 态不自行发起登录', async () => {
    await renderPage()
    expect(auth.startLogin).not.toHaveBeenCalled()
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

  // 登录入口在设置页的账号分区(见 SettingsAccountPanel.test.tsx),不在本覆盖层里。

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
