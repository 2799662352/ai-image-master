// 设置页的账号分区。
//
// 单独成 `settings/AccountSection.tsx` 而不是写在 SettingsPage 里,是为了能单测:
// SettingsPage 一挂载就要拉 API 站点、Codex provider、Seedance 与腾讯云三套 IPC,
// 把它整页搬进 jsdom 只会测到一堆 mock。分区自己只依赖 auth 桥。
//
// 最值得测的是 sessionOnly 那条提示:safeStorage 不可用(典型是 Linux 没有系统
// 密码管理器)时凭证只在本次会话有效,不提示的话用户会以为登录压根没生效。

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthLoginResult, AuthState } from '../../../../types/authApi'
import { useAuthStore, __resetSubscriptionsForTesting } from '../../stores/useAuthStore'
import { AccountSection } from '../settings/AccountSection'

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

const auth = {
  getState: vi.fn(),
  startLogin: vi.fn(),
  cancelLogin: vi.fn(),
  submitCode: vi.fn(),
  logout: vi.fn(),
  onStateChanged: vi.fn(),
  onLoginResult: vi.fn(),
}

beforeEach(() => {
  Object.values(auth).forEach((m) => m.mockReset())
  auth.onStateChanged.mockImplementation((_h: (s: AuthState) => void) => () => {})
  auth.onLoginResult.mockImplementation((_h: (r: AuthLoginResult) => void) => () => {})
  auth.getState.mockResolvedValue(LOGGED_OUT)
  auth.startLogin.mockResolvedValue({ authorizeUrl: 'https://13797248455.xyz/desktop-auth?p=p1', expiresIn: 300 })
  auth.logout.mockResolvedValue(undefined)

  Object.defineProperty(window, 'electronAPI', { value: { auth }, configurable: true })
  __resetSubscriptionsForTesting()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

afterEach(() => {
  cleanup()
  __resetSubscriptionsForTesting()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

async function renderPanel() {
  const utils = render(<AccountSection />)
  await waitFor(() => expect(auth.getState).toHaveBeenCalled())
  return utils
}

describe('设置页 · 账号分区', () => {
  it('挂载时同时接推送(ensureSubscriptions)和拉当前状态(hydrate)', async () => {
    await renderPanel()
    expect(auth.onStateChanged).toHaveBeenCalledTimes(1)
    expect(auth.onLoginResult).toHaveBeenCalledTimes(1)
    expect(auth.getState).toHaveBeenCalledTimes(1)
  })

  it('未登录时给出登录按钮,点击后发起 startLogin', async () => {
    await renderPanel()
    await act(async () => {
      screen.getByRole('button', { name: '登录' }).click()
    })
    expect(auth.startLogin).toHaveBeenCalledTimes(1)
  })

  it('pending 中按钮显示等待中并禁用', async () => {
    useAuthStore.setState({ pending: true })
    await renderPanel()
    const btn = screen.getByRole('button', { name: /等待浏览器授权/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  // 已登录场景一律通过 getState 喂给 hydrate,而不是预先 setState ——
  // 挂载时 hydrate 会照主进程的回答覆写这些字段,预设值会被冲掉(这本身也说明
  // hydrate 真的跑了)。
  it('已登录时显示 displayName 与角色,点「退出登录」调 logout', async () => {
    auth.getState.mockResolvedValue(LOGGED_IN)
    await renderPanel()

    expect(await screen.findByText('Alice')).toBeTruthy()
    expect(screen.getByText(/USER/)).toBeTruthy()
    await act(async () => {
      screen.getByRole('button', { name: '退出登录' }).click()
    })
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })

  it('没有 displayName 时回退到 username', async () => {
    auth.getState.mockResolvedValue({ ...LOGGED_IN, displayName: null })
    await renderPanel()
    expect(await screen.findByText('alice')).toBeTruthy()
  })

  it('sessionOnly 为 true 时提示重启后需重新登录', async () => {
    auth.getState.mockResolvedValue({ ...LOGGED_IN, credentialSource: 'memory' })
    await renderPanel()
    expect(await screen.findByText(/重启后需重新登录/)).toBeTruthy()
  })

  it('sessionOnly 为 false 时不出现那条提示', async () => {
    auth.getState.mockResolvedValue(LOGGED_IN)
    await renderPanel()
    // 先等已登录内容落地,否则「没出现」可能只是还没渲染完。
    expect(await screen.findByText('Alice')).toBeTruthy()
    expect(screen.queryByText(/重启后需重新登录/)).toBeNull()
  })

  it('登录失败的文案直接显示主进程给的原文,不泄漏裸 code', async () => {
    useAuthStore.setState({ error: '登录已超时,请重新发起' })
    await renderPanel()
    expect(screen.getByText('登录已超时,请重新发起')).toBeTruthy()
    expect(document.body.textContent).not.toContain('PAIRING_EXPIRED')
  })
})
