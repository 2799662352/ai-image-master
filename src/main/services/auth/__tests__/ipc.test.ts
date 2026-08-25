// IPC 编排层。被测的核心不是「能跑通」,而是几条只在异常路径上才暴露的约束:
// 端口有没有在每条退出路径上释放、verifier 有没有跨进程泄漏、
// 打开浏览器前有没有真的比对过 origin。

import { describe, expect, it, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
const openExternal = vi.fn(async () => {})
let windowDestroyed = false

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => void handlers.set(ch, fn),
    removeHandler: (ch: string) => void handlers.delete(ch),
  },
  shell: { openExternal: (...a: unknown[]) => openExternal(...a) },
  BrowserWindow: {},
}))

const listener = {
  host: '127.0.0.1' as const,
  port: 51789,
  redirectUri: 'http://127.0.0.1:51789/cb',
  waitForCode: vi.fn(),
  close: vi.fn(),
}
const startLoopbackListener = vi.fn(async () => listener)
vi.mock('../loopback', () => ({ startLoopbackListener: (o: unknown) => startLoopbackListener(o) }))

vi.mock('../pkce', () => ({
  generateCodeVerifier: () => 'the-verifier',
  deriveCodeChallenge: () => 'the-challenge',
  generateState: () => 'the-state',
}))

const startPairing = vi.fn()
const claimPairing = vi.fn()
const logoutFn = vi.fn()
let authState = {
  authenticated: false,
  username: null as string | null,
  displayName: null as string | null,
  role: null as string | null,
  credentialSource: 'none' as const,
}
class AuthError extends Error {
  constructor(public code: string, public status: number, msg: string) {
    super(msg)
  }
}
vi.mock('../session', () => ({
  authBaseUrl: () => 'https://13797248455.xyz',
  startPairing: (...a: unknown[]) => startPairing(...a),
  claimPairing: (...a: unknown[]) => claimPairing(...a),
  getAuthState: () => authState,
  logout: () => logoutFn(),
  probeLiveness: async () => {},
  AuthError,
}))

const fakeWindow = () =>
  ({
    isDestroyed: () => windowDestroyed,
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
  }) as never

async function register() {
  const m = await import('../ipc')
  return m.registerAuthIpc(() => fakeWindow())
}
const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({} as never, ...a)

/** 让脱钩的等码+claim 那段跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

const OK_START = { pairingId: 'p1', authorizeUrl: 'https://13797248455.xyz/desktop-auth?x=1', expiresIn: 300 }

describe('auth IPC 编排', () => {
  beforeEach(() => {
    vi.resetModules()
    handlers.clear()
    sent.length = 0
    windowDestroyed = false
    openExternal.mockClear()
    listener.waitForCode.mockReset()
    listener.close.mockClear()
    startLoopbackListener.mockClear()
    startPairing.mockReset()
    claimPairing.mockReset()
    logoutFn.mockClear()
    authState = { authenticated: false, username: null, displayName: null, role: null, credentialSource: 'none' }
  })

  it('注册全部五个通道', async () => {
    await register()
    expect([...handlers.keys()].sort()).toEqual(
      ['auth:cancel-login', 'auth:get-state', 'auth:logout', 'auth:start-login', 'auth:submit-code'].sort(),
    )
  })

  it('disposer 会把 handler 摘掉', async () => {
    const dispose = await register()
    dispose()
    expect(handlers.size).toBe(0)
  })

  it('get-state 直接返回 session 的派生状态', async () => {
    authState = { authenticated: true, username: 'alice', displayName: 'Alice', role: 'USER', credentialSource: 'safeStorage' }
    await register()
    expect(await call('auth:get-state')).toEqual(authState)
  })

  it('start-login 把 challenge/state 与回环 host/port 交给 startPairing,并快速返回', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockReturnValue(new Promise(() => {})) // 永不 resolve
    await register()

    const r = await call('auth:start-login')

    expect(r).toEqual({ authorizeUrl: OK_START.authorizeUrl, expiresIn: 300 })
    expect(startLoopbackListener).toHaveBeenCalledWith(expect.objectContaining({ state: 'the-state' }))
    expect(startPairing).toHaveBeenCalledWith(
      expect.any(String),
      { host: '127.0.0.1', port: 51789 },
      { codeChallenge: 'the-challenge', state: 'the-state' },
    )
    expect(openExternal).toHaveBeenCalledWith(OK_START.authorizeUrl)
  })

  // 唯一一道拦住「把用户送去钓鱼页」的关。
  it('authorizeUrl 的 origin 不匹配时拒绝打开浏览器,并释放端口', async () => {
    startPairing.mockResolvedValue({ ...OK_START, authorizeUrl: 'https://evil.example.com/desktop-auth' })
    await register()

    await expect(call('auth:start-login')).rejects.toThrow()
    expect(openExternal).not.toHaveBeenCalled()
    expect(listener.close).toHaveBeenCalled()
  })

  // pending 在 openExternal 之前就赋了值。这里若只关端口不清 pending,后者就指向一个
  // 已关闭的监听器,随后的 submit-code 会对着一个永远收不到回调的配对去 claim。
  it('openExternal 抛错时既释放端口,也不留下 pending', async () => {
    startPairing.mockResolvedValue(OK_START)
    openExternal.mockRejectedValueOnce(new Error('no browser'))
    await register()

    await expect(call('auth:start-login')).rejects.toThrow()
    expect(listener.close).toHaveBeenCalled()
    // 没有 pending 时 submit-code 必须报错 —— 这是「pending 已清」的可观测证据。
    await expect(call('auth:submit-code', 'x')).rejects.toThrow()
    expect(claimPairing).not.toHaveBeenCalled()
  })

  it('start 阶段报错也要释放端口', async () => {
    startPairing.mockRejectedValue(new AuthError('MISSING_PUBLIC_BASE_URL', 500, 'x'))
    await register()

    await expect(call('auth:start-login')).rejects.toThrow()
    expect(listener.close).toHaveBeenCalled()
  })

  it('拿到码后 claim 成功:关端口、广播新状态与 ok 结果', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockResolvedValue('the-grant-code')
    claimPairing.mockImplementation(async () => {
      authState = { authenticated: true, username: 'alice', displayName: 'Alice', role: 'USER', credentialSource: 'safeStorage' }
    })
    await register()

    await call('auth:start-login')
    await flush()

    expect(claimPairing).toHaveBeenCalledWith('p1', 'the-grant-code', 'the-verifier')
    expect(listener.close).toHaveBeenCalled()
    expect(sent).toEqual([
      { channel: 'auth:state-changed', payload: expect.objectContaining({ authenticated: true }) },
      { channel: 'auth:login-result', payload: { ok: true } },
    ])
  })

  it('claim 失败时也关端口,并广播可读文案而非裸 code', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockResolvedValue('g')
    claimPairing.mockRejectedValue(new AuthError('PAIRING_EXPIRED', 410, '配对已过期'))
    await register()

    await call('auth:start-login')
    await flush()

    expect(listener.close).toHaveBeenCalled()
    const last = sent[sent.length - 1] as { channel: string; payload: { ok: boolean; code: string; message: string } }
    expect(last.channel).toBe('auth:login-result')
    expect(last.payload.ok).toBe(false)
    expect(last.payload.code).toBe('PAIRING_EXPIRED')
    expect(last.payload.message).toBe('登录已超时,请重新发起')
  })

  // 断网时说「授权校验失败,请重新登录」会让用户反复重试并怀疑自己账号有问题。
  it('网络类失败给出网络文案,与认证被拒绝区分开', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockResolvedValue('g')
    claimPairing.mockRejectedValue(new Error('ECONNREFUSED'))
    await register()

    await call('auth:start-login')
    await flush()

    const last = sent[sent.length - 1] as { payload: { message: string } }
    expect(last.payload.message).toMatch(/网络|代理/)
    expect(last.payload.message).not.toMatch(/重新登录/)
  })

  it('等码超时也关端口并报错', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockRejectedValue(new Error('timeout'))
    await register()

    await call('auth:start-login')
    await flush()

    expect(listener.close).toHaveBeenCalled()
    expect((sent[sent.length - 1] as { payload: { ok: boolean } }).payload.ok).toBe(false)
  })

  it('cancel-login 关端口', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockReturnValue(new Promise(() => {}))
    await register()

    await call('auth:start-login')
    await call('auth:cancel-login')
    expect(listener.close).toHaveBeenCalled()
  })

  it('重复 start-login 先关掉上一个监听器,不泄漏端口', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockReturnValue(new Promise(() => {}))
    await register()

    await call('auth:start-login')
    expect(listener.close).not.toHaveBeenCalled()
    await call('auth:start-login')
    expect(listener.close).toHaveBeenCalledTimes(1)
  })

  it('submit-code 用 pending 里的 verifier,而不是渲染层传来的东西', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockReturnValue(new Promise(() => {}))
    claimPairing.mockResolvedValue(undefined)
    await register()

    await call('auth:start-login')
    await call('auth:submit-code', 'pasted-code')

    expect(claimPairing).toHaveBeenCalledWith('p1', 'pasted-code', 'the-verifier')
  })

  it('没有 pending 时 submit-code 直接报错,不去打后端', async () => {
    await register()
    await expect(call('auth:submit-code', 'x')).rejects.toThrow()
    expect(claimPairing).not.toHaveBeenCalled()
  })

  it('logout 清凭证并广播', async () => {
    authState = { authenticated: true, username: 'a', displayName: 'a', role: 'USER', credentialSource: 'safeStorage' }
    await register()
    logoutFn.mockImplementation(() => {
      authState = { authenticated: false, username: null, displayName: null, role: null, credentialSource: 'none' }
    })

    await call('auth:logout')
    expect(logoutFn).toHaveBeenCalled()
    expect(sent[0]).toEqual({ channel: 'auth:state-changed', payload: expect.objectContaining({ authenticated: false }) })
  })

  it('窗口已销毁时广播不抛', async () => {
    windowDestroyed = true
    await register()
    // 不用 .resolves —— logout 的 handler 是同步返回 void 的,包一层 Promise.resolve
    // 才能同时容纳同步与异步两种实现。真抛了的话这一行会带着原始错误让测试失败。
    await Promise.resolve(call('auth:logout'))
    expect(sent).toHaveLength(0)
  })

  // verifier 泄漏到渲染层等于 PKCE 白做了。
  it('任何跨 IPC 的返回值与推送里都不含 verifier', async () => {
    startPairing.mockResolvedValue(OK_START)
    listener.waitForCode.mockResolvedValue('g')
    claimPairing.mockResolvedValue(undefined)
    await register()

    const r = await call('auth:start-login')
    await flush()
    const blob = JSON.stringify({ r, sent })
    expect(blob).not.toContain('the-verifier')
  })
})
