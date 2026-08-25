// 桌面端浏览器登录 IPC 编排。PKCE verifier 与 pending 状态只活在主进程,渲染层不可见。

import { ipcMain, shell, type BrowserWindow } from 'electron'
import { startLoopbackListener, type LoopbackListener } from './loopback'
import { deriveCodeChallenge, generateCodeVerifier, generateState } from './pkce'
import {
  AuthError,
  authBaseUrl,
  claimPairing,
  getAuthState,
  logout,
  startPairing,
} from './session'
import type { AuthLoginResult, AuthState } from '../../../types/authApi'

const AUTH_CHANNELS = [
  'auth:get-state',
  'auth:start-login',
  'auth:cancel-login',
  'auth:submit-code',
  'auth:logout',
] as const

const CLIENT_NAME = 'CATIMATION Desktop'

interface PendingLogin {
  pairingId: string
  codeVerifier: string
  listener: LoopbackListener
}

let pending: PendingLogin | null = null

const NETWORK_MESSAGE = '无法连接登录服务,请检查网络或代理后重试'

/**
 * 判据是「有没有拿到 HTTP 状态码」,不是「异常是什么类型」。
 *
 * 断网 / DNS 失败 / TLS 失败时 `net.fetch` 直接抛原始 Error,压根没有响应,
 * 那属于网络问题;拿到了 4xx 才是认证被拒。把这两类混成同一句文案的后果是:
 * 断网的用户看到「授权校验失败,请重新登录」,于是反复重试并开始怀疑自己账号有问题。
 *
 * `status === 0` 与非 AuthError 合并成一个条件而不是各写一支:`session.ts` 的
 * `toAuthError` 只在 `status >= 400` 时构造,所以 0 今天不可达 —— 单独写一支就是
 * 没有任何测试能杀死的死代码。合并后这条判据本身是被测的。
 */
function mapLoginFailure(err: unknown): { code: string; message: string } {
  if (err instanceof AuthError && err.status !== 0) {
    switch (err.code) {
      case 'PKCE_MISMATCH':
      case 'GRANT_CODE_MISMATCH':
        return { code: err.code, message: '授权校验失败,请重新登录' }
      case 'PAIRING_ALREADY_CLAIMED':
        return { code: err.code, message: '该授权码已被使用,请重新登录' }
      case 'PAIRING_NOT_APPROVED':
        return { code: err.code, message: '尚未在浏览器中完成授权' }
      case 'PAIRING_EXPIRED':
      case 'PAIRING_NOT_FOUND':
        return { code: err.code, message: '登录已超时,请重新发起' }
      default:
        return { code: err.code, message: err.message }
    }
  }
  return { code: 'NETWORK_ERROR', message: NETWORK_MESSAGE }
}

function broadcastState(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('auth:state-changed', getAuthState())
  } catch (e) {
    console.warn('[auth] state-changed broadcast failed:', e)
  }
}

function broadcastLoginResult(
  getWindow: () => BrowserWindow | null,
  result: AuthLoginResult,
): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('auth:login-result', result)
  } catch (e) {
    console.warn('[auth] login-result broadcast failed:', e)
  }
}

function clearPending(): void {
  if (!pending) return
  pending.listener.close()
  pending = null
}

function assertAuthorizeOrigin(authorizeUrl: string): void {
  const expected = new URL(authBaseUrl()).origin
  const actual = new URL(authorizeUrl).origin
  if (actual !== expected) {
    console.error('[auth] authorizeUrl origin mismatch:', { expected, actual, authorizeUrl })
    throw new Error('授权链接来源不可信')
  }
}

async function completeClaim(
  getWindow: () => BrowserWindow | null,
  active: PendingLogin,
  grantCode: string,
): Promise<void> {
  try {
    await claimPairing(active.pairingId, grantCode, active.codeVerifier)
    broadcastState(getWindow)
    broadcastLoginResult(getWindow, { ok: true })
  } catch (err) {
    broadcastLoginResult(getWindow, { ok: false, ...mapLoginFailure(err) })
  } finally {
    if (pending === active) {
      active.listener.close()
      pending = null
    }
  }
}

function detachWaitAndClaim(
  getWindow: () => BrowserWindow | null,
  active: PendingLogin,
): void {
  void active.listener.waitForCode().then(
    (grantCode) => completeClaim(getWindow, active, grantCode),
    (err) => {
      broadcastLoginResult(getWindow, { ok: false, ...mapLoginFailure(err) })
      if (pending === active) {
        active.listener.close()
        pending = null
      }
    },
  )
}

export function registerAuthIpc(getWindow: () => BrowserWindow | null): () => void {
  for (const ch of AUTH_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle('auth:get-state', () => getAuthState())

  ipcMain.handle('auth:start-login', async () => {
    clearPending()

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = deriveCodeChallenge(codeVerifier)
    const state = generateState()

    const listener = await startLoopbackListener({ state })

    try {
      const pairing = await startPairing(
        CLIENT_NAME,
        { host: listener.host, port: listener.port },
        { codeChallenge, state },
      )

      assertAuthorizeOrigin(pairing.authorizeUrl)

      pending = {
        pairingId: pairing.pairingId,
        codeVerifier,
        listener,
      }

      await shell.openExternal(pairing.authorizeUrl)
      detachWaitAndClaim(getWindow, pending)

      return { authorizeUrl: pairing.authorizeUrl, expiresIn: pairing.expiresIn }
    } catch (err) {
      // `pending` 在 openExternal 之前就已赋值,所以这里不能只关端口:openExternal
      // 抛错(无默认浏览器、URL 被系统拒绝)时若把 pending 留着,它就指向一个已关闭的
      // 监听器 —— 随后 submit-code 会对着一个永远收不到回调的配对去 claim,
      // clearPending() 还会对同一个监听器二次 close。
      listener.close()
      if (pending?.listener === listener) pending = null
      throw err
    }
  })

  ipcMain.handle('auth:cancel-login', () => {
    clearPending()
  })

  ipcMain.handle('auth:submit-code', async (_event, grantCode: unknown) => {
    if (typeof grantCode !== 'string' || !grantCode) {
      throw new Error('授权码无效')
    }
    const active = pending
    if (!active) {
      throw new Error('当前没有进行中的登录')
    }
    await completeClaim(getWindow, active, grantCode)
  })

  ipcMain.handle('auth:logout', async () => {
    logout()
    broadcastState(getWindow)
  })

  return () => {
    clearPending()
    for (const ch of AUTH_CHANNELS) {
      ipcMain.removeHandler(ch)
    }
  }
}

export type { AuthState, AuthLoginResult }
