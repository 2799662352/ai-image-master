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
    set({ pending: false, authorizeUrl: null })
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
