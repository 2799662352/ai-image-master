import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthLoginResult, AuthState } from '../../../../types/authApi'

let stateHandler: ((s: AuthState) => void) | null = null
let resultHandler: ((r: AuthLoginResult) => void) | null = null
const offState = vi.fn()
const offResult = vi.fn()

const auth = {
  getState: vi.fn(),
  startLogin: vi.fn(),
  cancelLogin: vi.fn(),
  submitCode: vi.fn(),
  logout: vi.fn(),
  onStateChanged: vi.fn((h: (s: AuthState) => void) => {
    stateHandler = h
    return offState
  }),
  onLoginResult: vi.fn((h: (r: AuthLoginResult) => void) => {
    resultHandler = h
    return offResult
  }),
}

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

import { useAuthStore, __resetSubscriptionsForTesting } from '../useAuthStore'

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth }, configurable: true })
  Object.values(auth).forEach((m) => m.mockReset())
  auth.onStateChanged.mockImplementation((h) => {
    stateHandler = h
    return offState
  })
  auth.onLoginResult.mockImplementation((h) => {
    resultHandler = h
    return offResult
  })
  auth.getState.mockResolvedValue(LOGGED_OUT)
  auth.startLogin.mockResolvedValue({ authorizeUrl: 'https://13797248455.xyz/desktop-auth?p=1', expiresIn: 300 })
  auth.cancelLogin.mockResolvedValue(undefined)
  auth.submitCode.mockResolvedValue(undefined)
  auth.logout.mockResolvedValue(undefined)
  offState.mockClear()
  offResult.mockClear()
  stateHandler = null
  resultHandler = null
  __resetSubscriptionsForTesting()
  // 整体重置而不是手列字段 —— 日后加了字段也不会跨测试泄漏。
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

describe('useAuthStore', () => {
  it('初始态是未登录、不加载、无错误', () => {
    const s = useAuthStore.getState()
    expect(s.authenticated).toBe(false)
    expect(s.username).toBeNull()
    expect(s.pending).toBe(false)
    expect(s.error).toBeNull()
    expect(s.authorizeUrl).toBeNull()
  })

  it('hydrate 从主进程拉取当前状态', async () => {
    auth.getState.mockResolvedValue(LOGGED_IN)
    await useAuthStore.getState().hydrate()
    expect(useAuthStore.getState()).toMatchObject({
      authenticated: true,
      username: 'alice',
      displayName: 'Alice',
      role: 'USER',
      credentialSource: 'safeStorage',
    })
  })

  it('ensureSubscriptions 幂等 —— 调三次只订阅一次', () => {
    useAuthStore.getState().ensureSubscriptions()
    useAuthStore.getState().ensureSubscriptions()
    useAuthStore.getState().ensureSubscriptions()
    expect(auth.onStateChanged).toHaveBeenCalledTimes(1)
    expect(auth.onLoginResult).toHaveBeenCalledTimes(1)
  })

  it('收到 state-changed 推送后同步到 store', () => {
    useAuthStore.getState().ensureSubscriptions()
    stateHandler!(LOGGED_IN)
    expect(useAuthStore.getState().authenticated).toBe(true)
    expect(useAuthStore.getState().username).toBe('alice')
  })

  // startLogin 的 invoke 在浏览器打开的那一刻就 resolve,不是登录结果。
  // 在这里把 pending 置回 false,UI 会在浏览器刚弹出来时就退出等待态。
  it('startLogin 的 invoke resolve 之后 pending 仍为 true', async () => {
    useAuthStore.getState().ensureSubscriptions()
    await useAuthStore.getState().startLogin()

    expect(useAuthStore.getState().pending).toBe(true)
    expect(useAuthStore.getState().authorizeUrl).toBe('https://13797248455.xyz/desktop-auth?p=1')
    expect(useAuthStore.getState().error).toBeNull()
  })

  it('login-result 成功时收尾:pending 落回 false,清错误', async () => {
    useAuthStore.getState().ensureSubscriptions()
    await useAuthStore.getState().startLogin()
    resultHandler!({ ok: true })

    expect(useAuthStore.getState().pending).toBe(false)
    expect(useAuthStore.getState().error).toBeNull()
  })

  // message 已是主进程映射好的中文文案,渲染层直接显示,不要再自己按 code 映射一遍。
  it('login-result 失败时展示主进程给的文案,而不是 code', async () => {
    useAuthStore.getState().ensureSubscriptions()
    await useAuthStore.getState().startLogin()
    resultHandler!({ ok: false, code: 'PAIRING_EXPIRED', message: '登录已超时,请重新发起' })

    expect(useAuthStore.getState().pending).toBe(false)
    expect(useAuthStore.getState().error).toBe('登录已超时,请重新发起')
  })

  it('startLogin 自身抛错时不进入等待态', async () => {
    auth.startLogin.mockRejectedValue(new Error('授权链接来源不可信'))
    useAuthStore.getState().ensureSubscriptions()

    await useAuthStore.getState().startLogin()

    expect(useAuthStore.getState().pending).toBe(false)
    expect(useAuthStore.getState().error).toBeTruthy()
    expect(useAuthStore.getState().authorizeUrl).toBeNull()
  })

  it('重新发起登录会清掉上一次的错误', async () => {
    useAuthStore.getState().ensureSubscriptions()
    await useAuthStore.getState().startLogin()
    resultHandler!({ ok: false, code: 'PAIRING_EXPIRED', message: '登录已超时,请重新发起' })
    expect(useAuthStore.getState().error).toBeTruthy()

    await useAuthStore.getState().startLogin()
    expect(useAuthStore.getState().error).toBeNull()
    expect(useAuthStore.getState().pending).toBe(true)
  })

  it('cancelLogin 退出等待态并清掉授权链接', async () => {
    useAuthStore.getState().ensureSubscriptions()
    await useAuthStore.getState().startLogin()
    await useAuthStore.getState().cancelLogin()

    expect(auth.cancelLogin).toHaveBeenCalled()
    expect(useAuthStore.getState().pending).toBe(false)
    expect(useAuthStore.getState().authorizeUrl).toBeNull()
  })

  it('submitCode 透传给主进程,失败仍由推送汇报', async () => {
    useAuthStore.getState().ensureSubscriptions()
    await useAuthStore.getState().startLogin()
    await useAuthStore.getState().submitCode('pasted-code')

    expect(auth.submitCode).toHaveBeenCalledWith('pasted-code')
    // 兑换成败一律走 login-result,invoke 的 resolve 不代表成功。
    expect(useAuthStore.getState().pending).toBe(true)
  })

  it('logout 调主进程;真正的状态翻转靠推送', async () => {
    useAuthStore.getState().ensureSubscriptions()
    stateHandler!(LOGGED_IN)
    await useAuthStore.getState().logout()

    expect(auth.logout).toHaveBeenCalled()
    stateHandler!(LOGGED_OUT)
    expect(useAuthStore.getState().authenticated).toBe(false)
  })

  // safeStorage 不可用(典型是 Linux 没有系统密码管理器)时凭证只在本次会话有效。
  // UI 必须提示「重启后需重新登录」,否则用户会以为登录没生效。
  it('credentialSource 为 memory 时暴露「仅本次会话」', () => {
    useAuthStore.getState().ensureSubscriptions()
    stateHandler!({ ...LOGGED_IN, credentialSource: 'memory' })
    expect(useAuthStore.getState().sessionOnly).toBe(true)

    stateHandler!(LOGGED_IN)
    expect(useAuthStore.getState().sessionOnly).toBe(false)
  })

  it('__resetSubscriptionsForTesting 会真的退订', () => {
    useAuthStore.getState().ensureSubscriptions()
    __resetSubscriptionsForTesting()
    expect(offState).toHaveBeenCalled()
    expect(offResult).toHaveBeenCalled()
    // 退订后可以重新订阅。
    useAuthStore.getState().ensureSubscriptions()
    expect(auth.onStateChanged).toHaveBeenCalledTimes(2)
  })

  it('没有 electronAPI 时不炸(浏览器端跑渲染层的场景)', () => {
    Object.defineProperty(window, 'electronAPI', { value: undefined, configurable: true })
    expect(() => useAuthStore.getState().ensureSubscriptions()).not.toThrow()
  })

  // store 里存下 token 等于把主进程的隔离白做了。
  it('store 状态里不含 token 之类的机密字段', async () => {
    auth.getState.mockResolvedValue(LOGGED_IN)
    await useAuthStore.getState().hydrate()
    const keys = Object.keys(useAuthStore.getState())
    expect(keys).not.toContain('token')
    expect(JSON.stringify(useAuthStore.getState())).not.toMatch(/token|verifier/i)
  })
})
