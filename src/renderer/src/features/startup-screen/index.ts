/**
 * 启动动画宿主层(取代旧的 Cyberpunk 开场视频 IntroVideoController)。
 *
 * 分两件互相独立的事:
 *  1. **揭幕加载页**:应用初始化完成(`appReady`)就把 `#pageLoader` / `#mainContent` 揭开,
 *     最长等 15 秒。与动画无关 —— 动画盖在最上层(z-index 远高于加载页),
 *     应用在它下面先就绪,动画一播完就直接落进可用的界面,不会再多等一个「进入」按钮。
 *  2. **今天要不要播动画**:每天第一次启动播完整版(存档见 startupGate),其余启动不加载引擎。
 *
 * 登录:动画里没有任何输入框。游客点第 1 / 2 步的按钮 = **立刻**发起已有的网页登录
 * (系统浏览器 + 回环授权,走 useAuthStore.startLogin),并且**停在原地等结果**:
 * 登录成功才放行;失败(网络 / 超时 / 被拒)在按钮上显示原因、点一下重试;
 * 唯一不登录的出口是显式「跳过登录」(Esc / 右上角 SKIP 同样算,此时顺手取消进行中的登录)。
 * 身份确认那一步(已登录)有「退出登录」:退出后按钮变回网页登录,由用户再点一下重新登录。
 *
 * 引擎(engine.js,约 1.7k 行)和样式只在「今天要播」时才动态加载。
 */
import type {
  StartupActionEvent,
  StartupEngineModule,
  StartupEngineOptions,
  StartupScreenHandle
} from './engineTypes'
import { markPlayed, readPrefs, shouldPlay, type StartupMode, type StorageLike } from './startupGate'
import { FALLBACK_IDENTITY, pickIdentityName, readCachedIdentity, writeCachedIdentity } from './startupIdentity'

export type { StartupEngineModule } from './engineTypes'

/** 宿主关心的登录态切片(useAuthStore 的子集,测试里可注入假实现) */
export interface AuthSnapshot {
  authenticated: boolean
  username?: string | null
  displayName?: string | null
  /** 网页登录已在进行中(等浏览器回调) */
  pending?: boolean
  /** 上一次网页登录失败的原因(原文,可能带 IPC / 网络栈的技术前缀) */
  error?: string | null
}

export interface AuthPort {
  getState(): AuthSnapshot
  subscribe(listener: (state: AuthSnapshot) => void): () => void
  /** 向主进程取一次最新登录态,并保证后续状态推送已订阅 */
  hydrate(): Promise<void>
  /** 发起网页登录(系统浏览器),返回时浏览器已拉起,不会等用户完成 */
  startLogin(): Promise<void>
  /** 退出登录;完成后登录态推送会变成未登录 */
  logout?(): Promise<void>
  /** 取消进行中的网页登录 */
  cancelLogin?(): Promise<void>
  /** 清掉登录失败的提示(不发 IPC) */
  dismissLogin?(): void
}

const GENERIC_LOGIN_ERROR = '登录没有完成，请重试'
const NETWORK_LOGIN_ERROR = '无法连接登录服务，请检查网络或代理后重试'
const UNAVAILABLE_LOGIN_ERROR = '当前环境无法发起网页登录'
const LOGOUT_ERROR = '退出登录失败，请重试'

/**
 * 把登录失败的原文换成给人看的一句话。
 * `useAuthStore.startLogin` 把 IPC 的 reject 原样塞进 error
 * (形如「Error invoking remote method 'auth:start-login': Error: net::ERR_CONNECTION_CLOSED」),
 * 直接显示就是一串技术栈;主进程自己映射过的中文原因则原样保留。
 */
export function friendlyLoginError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : ''
  const cleaned = text
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^\w*Error:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return GENERIC_LOGIN_ERROR
  if (/net::|\bERR_[A-Z_]{3,}|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|handshake/i.test(cleaned)) {
    return NETWORK_LOGIN_ERROR
  }
  return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned
}

export interface StartupHostDeps {
  /** 存档;不传 = window.localStorage,传 null = 不存档 */
  storage?: StorageLike | null
  now?: () => Date
  loadEngine?: () => Promise<StartupEngineModule>
  /** 不传 = 懒加载应用里的 useAuthStore;传 null = 没有登录能力 */
  auth?: AuthPort | null
  markUrl?: string
  assetBase?: string
  /** appReady 迟迟不来时的揭幕封顶(默认 15 s) */
  revealTimeoutMs?: number
  /**
   * 存档里没有(合法的)mode 时用什么。默认 'daily'(每天第一次)。
   * 存档里明确写过的 mode 优先于它。
   */
  defaultMode?: StartupMode
  /**
   * 调试用:压过存档里的一切(含 off、旧版本写进去的 daily),每次启动都按它走。
   * 不会写回存档,所以去掉这个参数就立刻恢复成存档 / 默认的行为。
   */
  forceMode?: StartupMode
}

export interface StartupHost {
  dispose(): void
}

const REVEAL_CAP_MS = 15_000
/** 与 index.html 里 `.page-loader.loaded` 的 opacity 过渡匹配,之后摘掉节点 */
const LOADER_REMOVE_MS = 800
const MARK_PATH = 'images/logo.png'
const AUDIO_DIR = 'audio/startup/'

function resolveAsset(rel: string): string {
  try {
    return new URL(rel, document.baseURI).toString()
  } catch {
    return rel
  }
}

function pickStorage(dep: StorageLike | null | undefined): StorageLike | undefined {
  if (dep === null) return undefined
  if (dep) return dep
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

async function defaultLoadEngine(): Promise<StartupEngineModule> {
  const [mod] = await Promise.all([import('./engine.js'), import('./startup-screen.css')])
  return mod as StartupEngineModule
}

function toSnapshot(s: {
  authenticated: boolean
  username: string | null
  displayName: string | null
  pending: boolean
  error: string | null
}): AuthSnapshot {
  return {
    authenticated: s.authenticated,
    username: s.username,
    displayName: s.displayName,
    pending: s.pending,
    error: s.error
  }
}

/** 默认的登录端口:懒加载应用里现成的 useAuthStore(与登录覆盖层共用同一份状态) */
async function loadStoreAuthPort(): Promise<AuthPort | null> {
  try {
    const { useAuthStore } = await import('../../stores/useAuthStore')
    return {
      getState: () => toSnapshot(useAuthStore.getState()),
      subscribe: (cb) => useAuthStore.subscribe((s) => cb(toSnapshot(s))),
      hydrate: async () => {
        useAuthStore.getState().ensureSubscriptions()
        await useAuthStore.getState().hydrate()
      },
      startLogin: () => useAuthStore.getState().startLogin(),
      logout: () => useAuthStore.getState().logout(),
      cancelLogin: () => useAuthStore.getState().cancelLogin(),
      dismissLogin: () => useAuthStore.getState().dismissLogin()
    }
  } catch (err) {
    console.warn('[startup-screen] 取不到登录模块,动画里不提供网页登录入口:', err)
    return null
  }
}

export function initStartupScreen(deps: StartupHostDeps = {}): StartupHost {
  const storage = pickStorage(deps.storage)
  const now = deps.now ?? (() => new Date())
  let disposed = false
  let handle: StartupScreenHandle | null = null
  let authPort: AuthPort | null = null
  let unsubscribeAuth: (() => void) | null = null

  // ── 1. 揭幕加载页 ────────────────────────────────────────────────
  let revealed = false
  let capTimer: ReturnType<typeof setTimeout> | null = null
  let removeTimer: ReturnType<typeof setTimeout> | null = null

  const stopWaitingForReady = (): void => {
    window.removeEventListener('appReady', reveal)
    if (capTimer !== null) {
      clearTimeout(capTimer)
      capTimer = null
    }
  }

  function reveal(): void {
    if (revealed) return
    revealed = true
    stopWaitingForReady()
    const loader = document.getElementById('pageLoader')
    const main = document.getElementById('mainContent')
    loader?.classList.add('loaded')
    main?.classList.add('loaded')
    if (loader) {
      removeTimer = setTimeout(() => {
        removeTimer = null
        loader.parentNode?.removeChild(loader)
      }, LOADER_REMOVE_MS)
    }
  }

  if ((window as { appInitialized?: boolean }).appInitialized === true) {
    reveal()
  } else {
    window.addEventListener('appReady', reveal)
    capTimer = setTimeout(reveal, deps.revealTimeoutMs ?? REVEAL_CAP_MS)
  }

  // ── 2. 动画 ──────────────────────────────────────────────────────
  const dropAuth = (): void => {
    if (unsubscribeAuth) {
      try {
        unsubscribeAuth()
      } catch {
        // 退订失败不影响收尾
      }
      unsubscribeAuth = null
    }
  }

  /**
   * 本轮用户点击已经发起(或接管)了一次网页登录。只有这时,登录 store 里
   * pending / error 的变化才会推进引擎的登录闸门;平时 store 里别处(设置页等)的登录状态与动画无关。
   */
  let loginActive = false
  /** `startLogin()` 调用还没返回(此刻 store 里「既没 pending 也没 error」不代表被取消) */
  let loginStarting = false
  /** 动画里点过登录:跳过时据此决定要不要顺手取消 / 清掉提示 */
  let loginTouched = false

  /** store 里的登录状态 → 引擎按钮上的「等待 / 出错 / 回到可点」 */
  const syncLoginState = (s: AuthSnapshot): void => {
    if (!handle || !loginActive) return
    if (s.authenticated) {
      // 引擎的 setAuthenticated(true) 已经把这一步放行,闸门状态随 hideAction 复位
      loginActive = false
      return
    }
    if (s.pending) {
      handle.setLoginState('waiting')
      return
    }
    if (s.error) {
      loginActive = false
      handle.setLoginState('error', friendlyLoginError(s.error))
      return
    }
    if (!loginStarting) {
      // 进行中的登录被取消了:回到可点,用户可以再点一次
      loginActive = false
      handle.setLoginState('idle')
    }
  }

  const applyAuth = (s: AuthSnapshot): void => {
    if (!handle) return
    handle.setAuthenticated(s.authenticated)
    if (s.authenticated) {
      const name = pickIdentityName(s) ?? FALLBACK_IDENTITY
      handle.setIdentity(name)
      // 只有真名字才写缓存(兜底名不写,免得「创作者」顶掉上次的真名)
      writeCachedIdentity(storage, pickIdentityName(s))
    } else {
      // 游客:缓存里的名字属于上一个登录的人,不能再当「欢迎 XXX」显示
      handle.setIdentity(FALLBACK_IDENTITY)
    }
    syncLoginState(s)
  }

  const wireAuth = async (): Promise<void> => {
    const port = deps.auth !== undefined ? deps.auth : await loadStoreAuthPort()
    if (disposed || !handle) return
    if (!port) {
      // 没有登录能力(登录模块加载失败 / 显式传 null):没法登录就别拦人
      handle.setLoginRequired(false)
      return
    }
    authPort = port
    unsubscribeAuth = port.subscribe(applyAuth)
    try {
      await port.hydrate()
    } catch (err) {
      // 没有 Electron preload / IPC 不通:登录态保持「未知」,按钮文案不变
      console.warn('[startup-screen] 登录态水合失败:', err)
      return
    }
    if (disposed || !handle) return
    applyAuth(port.getState())
  }

  /** 水合收尾(成功、失败、没有登录模块都算收尾);点击要等它,才知道此刻是不是游客 */
  let authReady: Promise<void> = Promise.resolve()

  /**
   * 用户点了主按钮(第 1 / 2 步)→ 与设置页「登录」按钮同一套判据:**看登录 store 此刻的真实状态**。
   *   · 已登录            → 同步给引擎,它把这一步放行;
   *   · 已有进行中的登录   → 接管等待(不重复拉浏览器);
   *   · 否则 `startLogin()`(主进程打开系统浏览器),引擎停在原地等 store 推回「已登录」。
   * 失败(抛错 / 没拉起来 / store 里带 error)一律回到按钮上的错误提示,点一下重试。
   *
   * 不看引擎事件里镜像来的 `authenticated`:那份在水合完成前恒为 null。
   */
  const runLogin = async (): Promise<void> => {
    await authReady
    if (disposed || !handle) return
    const port = authPort
    if (!port) {
      // 水合期间发现没有登录能力:别把人卡在这儿
      handle.setLoginRequired(false)
      return
    }
    const before = port.getState()
    if (before.authenticated) {
      applyAuth(before)
      return
    }
    loginTouched = true
    loginActive = true
    handle.setLoginState('waiting')
    if (before.pending) return // 接管已有的登录:等 store 推送结果
    loginStarting = true
    try {
      await port.startLogin()
    } catch (err) {
      loginStarting = false
      loginActive = false
      console.warn('[startup-screen] 发起网页登录失败:', err)
      handle?.setLoginState('error', friendlyLoginError(err))
      return
    }
    loginStarting = false
    if (disposed || !handle || !loginActive) return
    const after = port.getState()
    if (after.authenticated || after.pending || after.error) {
      applyAuth(after)
    } else {
      // 调用返回了,浏览器却没拉起来(没有登录 IPC / 被无声吞掉)
      loginActive = false
      handle.setLoginState('error', UNAVAILABLE_LOGIN_ERROR)
    }
  }

  /**
   * 第 2 步(身份确认)的「退出登录」。只退出,不自动拉浏览器:
   * 按钮变回「网页登录验证身份」,用户再点一下重新登录(想换账号的人得先能看清自己已经退了)。
   */
  const runLogout = async (): Promise<void> => {
    await authReady
    if (disposed || !handle) return
    const port = authPort
    if (!port?.logout) {
      handle.setLoginState('idle')
      return
    }
    loginActive = false
    try {
      await port.logout()
    } catch (err) {
      console.warn('[startup-screen] 退出登录失败:', err)
      handle?.setLoginState('error', LOGOUT_ERROR)
      return
    }
    if (disposed || !handle) return
    applyAuth(port.getState())
    handle.setLoginState('idle')
  }

  /** 用户选择跳过:正在等的登录没必要留着(浏览器回调之后弹登录覆盖层很突兀),失败提示也一并清掉 */
  const abandonLogin = (): void => {
    if (!loginTouched) return
    loginTouched = false
    loginActive = false
    const port = authPort
    if (!port) return
    try {
      const s = port.getState()
      if (s.pending) {
        void port.cancelLogin?.().catch((err: unknown) => {
          console.warn('[startup-screen] 取消网页登录失败:', err)
        })
      } else if (s.error) {
        port.dismissLogin?.()
      }
    } catch (err) {
      console.warn('[startup-screen] 收尾登录状态失败:', err)
    }
  }

  const onAction = (e: StartupActionEvent): void => {
    if (e.action === 'logout') {
      void runLogout()
      return
    }
    void runLogin()
  }

  const play = async (): Promise<void> => {
    let mod: StartupEngineModule
    try {
      mod = await (deps.loadEngine ?? defaultLoadEngine)()
    } catch (err) {
      console.warn('[startup-screen] 引擎加载失败,跳过启动动画:', err)
      return
    }
    if (disposed) return

    const options: StartupEngineOptions = {
      markUrl: deps.markUrl ?? resolveAsset(MARK_PATH),
      assetBase: deps.assetBase ?? resolveAsset(AUDIO_DIR),
      config: {
        identity: readCachedIdentity(storage) ?? FALLBACK_IDENTITY,
        // 水合之前不知道是不是游客,按钮文案先保持中性
        authenticated: null
      },
      onAction,
      onFinish: (evt) => {
        // 跳过也算播过;播到一半被杀不会走到这里,下次启动重播
        markPlayed(storage, now())
        if (evt?.skipped) abandonLogin()
      },
      onDone: () => {
        dropAuth()
        handle = null
      }
    }

    try {
      handle = mod.createStartupScreen(options)
    } catch (err) {
      console.warn('[startup-screen] 启动动画创建失败:', err)
      return
    }
    authReady = wireAuth().catch((err: unknown) => {
      console.warn('[startup-screen] 登录态接线失败:', err)
    })
  }

  if (shouldPlay(readPrefs(storage, deps.defaultMode, deps.forceMode), now())) {
    void play()
  }

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      stopWaitingForReady()
      if (removeTimer !== null) {
        clearTimeout(removeTimer)
        removeTimer = null
      }
      dropAuth()
      const h = handle
      handle = null
      try {
        h?.dispose()
      } catch {
        // 销毁失败也不能影响退出
      }
    }
  }
}
