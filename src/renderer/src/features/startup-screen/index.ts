/**
 * 启动动画宿主层(取代旧的 Cyberpunk 开场视频 IntroVideoController)。
 *
 * 分两件互相独立的事:
 *  1. **揭幕加载页**:应用初始化完成(`appReady`)就把 `#pageLoader` / `#mainContent` 揭开,
 *     最长等 15 秒。与动画无关 —— 动画盖在最上层(z-index 远高于加载页),
 *     应用在它下面先就绪,动画一播完就直接落进可用的界面,不会再多等一个「进入」按钮。
 *  2. **今天要不要播动画**:每天第一次启动播完整版(存档见 startupGate),其余启动不加载引擎。
 *
 * 登录:动画里没有任何输入框。游客在第 1 步点按钮 = 发起**已有的网页登录**
 * (系统浏览器 + 回环授权,走 useAuthStore.startLogin),动画本身不等登录结果,
 * 登录成功后 auth 状态推送进来,引擎再把名字 / 按钮文案补上。
 *
 * 引擎(engine.js,约 1.7k 行)和样式只在「今天要播」时才动态加载。
 */
import type {
  StartupActionEvent,
  StartupEngineModule,
  StartupEngineOptions,
  StartupScreenHandle
} from './engineTypes'
import { markPlayed, readPrefs, shouldPlay, type StorageLike } from './startupGate'
import { FALLBACK_IDENTITY, pickIdentityName, readCachedIdentity, writeCachedIdentity } from './startupIdentity'

export type { StartupEngineModule } from './engineTypes'

/** 宿主关心的登录态切片(useAuthStore 的子集,测试里可注入假实现) */
export interface AuthSnapshot {
  authenticated: boolean
  username?: string | null
  displayName?: string | null
  /** 网页登录已在进行中(等浏览器回调) */
  pending?: boolean
}

export interface AuthPort {
  getState(): AuthSnapshot
  subscribe(listener: (state: AuthSnapshot) => void): () => void
  /** 向主进程取一次最新登录态,并保证后续状态推送已订阅 */
  hydrate(): Promise<void>
  /** 发起网页登录(系统浏览器),不会等用户完成 */
  startLogin(): Promise<void>
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
}): AuthSnapshot {
  return { authenticated: s.authenticated, username: s.username, displayName: s.displayName, pending: s.pending }
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
      startLogin: () => useAuthStore.getState().startLogin()
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
  }

  const wireAuth = async (): Promise<void> => {
    const port = deps.auth !== undefined ? deps.auth : await loadStoreAuthPort()
    if (!port || disposed || !handle) return
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

  const onAction = (e: StartupActionEvent): void => {
    // 只有游客在第 1 步的主动点击才发起登录;第 2 步、已登录、状态未知都不动
    if (e.action !== 'grant' || e.authenticated !== false) return
    const port = authPort
    if (!port) return
    try {
      if (port.getState().pending) return
      void Promise.resolve(port.startLogin()).catch((err: unknown) => {
        console.warn('[startup-screen] 发起网页登录失败:', err)
      })
    } catch (err) {
      console.warn('[startup-screen] 发起网页登录失败:', err)
    }
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
      onFinish: () => {
        // 跳过也算播过;播到一半被杀不会走到这里,下次启动重播
        markPlayed(storage, now())
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
    void wireAuth()
  }

  if (shouldPlay(readPrefs(storage), now())) {
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
