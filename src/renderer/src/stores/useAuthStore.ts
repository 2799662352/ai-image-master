import { create } from 'zustand'
import type { AuthLoginResult, AuthState } from '../../../types/authApi'

type AuthApi = {
  getState: () => Promise<AuthState>
  startLogin: () => Promise<{ authorizeUrl: string; expiresIn: number }>
  cancelLogin: () => Promise<void>
  submitCode: (grantCode: string) => Promise<void>
  logout: () => Promise<void>
  onStateChanged: (handler: (state: AuthState) => void) => () => void
  onLoginResult: (handler: (result: AuthLoginResult) => void) => () => void
}

interface AuthStoreState extends AuthState {
  pending: boolean
  error: string | null
  authorizeUrl: string | null
  sessionOnly: boolean
}

interface AuthStoreActions {
  hydrate: () => Promise<void>
  ensureSubscriptions: () => void
  startLogin: () => Promise<void>
  cancelLogin: () => Promise<void>
  /**
   * 把失败的登录流程从界面上撤下来,让用户回到应用继续用自己的 API Key。
   *
   * 必须存在:`error` 此前没有任何动作会清掉(cancelLogin 只清 pending 与
   * authorizeUrl),而覆盖层是 `error ? 'error' : …` 派生的 —— 少了这个动作,
   * 登录失败一次就把用户永久挡在应用外,只能重启进程。
   *
   * 刻意**不发 IPC**:走到 error 态时主进程那边的配对流程已经结束、回环监听器
   * 已关闭,没有东西需要取消。等待态的退出走 cancelLogin,那才需要通知主进程。
   */
  dismissLogin: () => void
  submitCode: (grantCode: string) => Promise<void>
  logout: () => Promise<void>
}

type AuthStore = AuthStoreState & AuthStoreActions

let unsubscribeStateChanged: (() => void) | null = null
let unsubscribeLoginResult: (() => void) | null = null

function getAuthApi(): AuthApi | undefined {
  return (window as Window & { electronAPI?: { auth?: AuthApi } }).electronAPI?.auth
}

function applyAuthState(state: AuthState): Partial<AuthStoreState> {
  return {
    authenticated: state.authenticated,
    username: state.username,
    displayName: state.displayName,
    role: state.role,
    credentialSource: state.credentialSource,
    sessionOnly: state.credentialSource === 'memory',
  }
}

const initialState: AuthStoreState = {
  authenticated: false,
  username: null,
  displayName: null,
  role: null,
  credentialSource: 'none',
  pending: false,
  error: null,
  authorizeUrl: null,
  sessionOnly: false,
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  ...initialState,

  hydrate: async () => {
    const api = getAuthApi()
    if (!api) return
    const state = await api.getState()
    set(applyAuthState(state))
  },

  ensureSubscriptions: () => {
    if (unsubscribeStateChanged || typeof window === 'undefined') return
    const api = getAuthApi()
    if (!api) return

    unsubscribeStateChanged = api.onStateChanged((state) => {
      set(applyAuthState(state))
    })

    unsubscribeLoginResult = api.onLoginResult((result) => {
      if (result.ok) {
        set({ pending: false, error: null })
      } else {
        set({ pending: false, error: result.message })
      }
    })
  },

  startLogin: async () => {
    const api = getAuthApi()
    if (!api) return

    set({ pending: true, error: null, authorizeUrl: null })

    try {
      const { authorizeUrl } = await api.startLogin()
      set({ authorizeUrl })
    } catch (err) {
      set({
        pending: false,
        error: err instanceof Error ? err.message : String(err),
        authorizeUrl: null,
      })
    }
  },

  cancelLogin: async () => {
    const api = getAuthApi()
    if (!api) return
    await api.cancelLogin()
    // error 一并清掉:若取消的同时有一条失败推送落进来,留着它会让覆盖层从
    // 「等待」直接切到无法退出的「错误」态,用户以为点了取消却更出不去了。
    set({ pending: false, authorizeUrl: null, error: null })
  },

  dismissLogin: () => {
    set({ pending: false, authorizeUrl: null, error: null })
  },

  submitCode: async (grantCode: string) => {
    const api = getAuthApi()
    if (!api) return
    await api.submitCode(grantCode)
  },

  logout: async () => {
    const api = getAuthApi()
    if (!api) return
    await api.logout()
  },
}))

/**
 * Test-only: reset module-level subscription singletons so Vitest's per-test
 * `setState(getInitialState(), true)` actually starts from a clean slate.
 * Production code should NOT call this — leaking a subscription across windows
 * would cause double-fire.
 */
export function __resetSubscriptionsForTesting(): void {
  unsubscribeStateChanged?.()
  unsubscribeStateChanged = null
  unsubscribeLoginResult?.()
  unsubscribeLoginResult = null
}
