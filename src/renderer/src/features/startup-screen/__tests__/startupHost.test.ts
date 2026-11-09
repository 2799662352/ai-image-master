/**
 * 启动动画宿主层:「今天播不播」「何时揭幕」「登录态怎么接进去」。
 *
 * 引擎本身(engine.js)有自己的 jsdom 时间线测试;这里把引擎换成假的,
 * 只验证宿主对它的调用与对 DOM / 存档 / 登录态的副作用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { friendlyLoginError, initStartupScreen } from '../index'
import type { AuthPort, AuthSnapshot, StartupHostDeps } from '../index'
import type { StartupEngineModule, StartupEngineOptions, StartupScreenHandle } from '../engineTypes'
import { STARTUP_STORAGE_KEY } from '../startupGate'
import { IDENTITY_STORAGE_KEY, FALLBACK_IDENTITY } from '../startupIdentity'

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    dump: () => Object.fromEntries(data)
  }
}

function fakeEngine() {
  const handle: StartupScreenHandle = {
    skip: vi.fn(),
    finish: vi.fn(),
    dispose: vi.fn(),
    setIdentity: vi.fn(),
    setAuthenticated: vi.fn(),
    setLoginState: vi.fn(),
    setLoginRequired: vi.fn(),
    isFinished: vi.fn(() => false)
  }
  const calls: StartupEngineOptions[] = []
  const createStartupScreen = vi.fn((o: StartupEngineOptions) => {
    calls.push(o)
    return handle
  })
  return { handle, calls, createStartupScreen }
}

function fakeAuth(initial: Partial<AuthSnapshot> = {}) {
  let state: AuthSnapshot = { authenticated: false, username: null, displayName: null, pending: false, ...initial }
  const listeners = new Set<(s: AuthSnapshot) => void>()
  const push = (next: Partial<AuthSnapshot>): void => {
    state = { ...state, ...next }
    for (const l of [...listeners]) l(state)
  }
  const port: AuthPort = {
    getState: () => state,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    hydrate: vi.fn(async () => undefined),
    startLogin: vi.fn(async () => undefined),
    // 默认的退出:登录 store 推回「未登录」
    logout: vi.fn(async () => {
      push({ authenticated: false, username: null, displayName: null })
    }),
    cancelLogin: vi.fn(async () => undefined),
    dismissLogin: vi.fn()
  }
  return { port, listeners, push }
}

const NOW = new Date(2026, 10, 9, 10, 0, 0)

async function flush() {
  // 让 loadEngine().then(...) 这类微任务链走完
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('initStartupScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML =
      '<div id="pageLoader" class="page-loader"></div><div id="mainContent" class="main-content"></div>'
    delete (window as { appInitialized?: boolean }).appInitialized
  })
  // 宿主会在 window 上挂 appReady 监听;不销毁的话,上一个用例的宿主会被下一个用例的 appReady 触发,
  // 去揭下一个用例的 DOM —— 用例之间互相污染。
  const hosts: Array<{ dispose(): void }> = []
  afterEach(() => {
    for (const h of hosts.splice(0)) h.dispose()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  function start(over: Partial<StartupHostDeps> = {}) {
    const engine = fakeEngine()
    const storage = memoryStorage()
    const auth = fakeAuth()
    const loadEngine = vi.fn(async () => ({ createStartupScreen: engine.createStartupScreen }))
    const host = initStartupScreen({
      storage,
      now: () => NOW,
      loadEngine,
      auth: auth.port,
      assetBase: 'file:///app/audio/startup/',
      ...over
    })
    hosts.push(host)
    return { host, engine, storage, auth, loadEngine }
  }

  describe('今天播不播', () => {
    it('当天第一次启动:加载引擎并开播', async () => {
      const { engine, loadEngine } = start()
      await flush()
      expect(loadEngine).toHaveBeenCalledTimes(1)
      expect(engine.createStartupScreen).toHaveBeenCalledTimes(1)
    })

    it('今天已经播过:不加载引擎(连脚本都不下载)', async () => {
      const storage = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: '2026-11-09' }) })
      const { engine, loadEngine } = start({ storage })
      await flush()
      expect(loadEngine).not.toHaveBeenCalled()
      expect(engine.createStartupScreen).not.toHaveBeenCalled()
    })

    it('昨天播过:今天再播', async () => {
      const storage = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: '2026-11-08' }) })
      const { engine } = start({ storage })
      await flush()
      expect(engine.createStartupScreen).toHaveBeenCalledTimes(1)
    })

    it('默认每次启动都播:4.9.34 留下的「今天已播」存档(没写 mode)也照播', async () => {
      const storage = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ lastPlayedDay: '2026-11-09' }) })
      const { engine, loadEngine } = start({ storage })
      await flush()
      expect(loadEngine).toHaveBeenCalledTimes(1)
      expect(engine.createStartupScreen).toHaveBeenCalledTimes(1)
    })

    it('默认:看完(或跳过)后再启动一次、同一天里还是播;存档里没有被写进 mode', async () => {
      const storage = memoryStorage()
      const first = start({ storage })
      await flush()
      first.engine.calls[0].onFinish?.({ skipped: false })
      first.host.dispose()
      expect(JSON.parse(storage.dump()[STARTUP_STORAGE_KEY])).toEqual({ lastPlayedDay: '2026-11-09' })

      const second = start({ storage })
      await flush()
      expect(second.engine.createStartupScreen).toHaveBeenCalledTimes(1)
      second.engine.calls[0].onFinish?.({ skipped: true })

      const third = start({ storage })
      await flush()
      expect(third.engine.createStartupScreen).toHaveBeenCalledTimes(1)
    })

    it('mode=off 永远不播,mode=always 每次都播', async () => {
      const off = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'off', lastPlayedDay: null }) })
      const a = start({ storage: off })
      await flush()
      expect(a.engine.createStartupScreen).not.toHaveBeenCalled()

      const always = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'always', lastPlayedDay: '2026-11-09' }) })
      const b = start({ storage: always })
      await flush()
      expect(b.engine.createStartupScreen).toHaveBeenCalledTimes(1)
    })

    it('forceMode=always(调试版):存档说「今天播过 / off」也照播,且不把 always 写进存档', async () => {
      const playedToday = memoryStorage({
        [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: '2026-11-09' }),
      })
      const a = start({ storage: playedToday, forceMode: 'always' })
      await flush()
      expect(a.engine.createStartupScreen).toHaveBeenCalledTimes(1)
      a.engine.calls[0].onFinish?.({ skipped: false })
      // 存档仍是用户 / 旧版本留下的样子,没被强制值污染
      expect(JSON.parse(playedToday.dump()[STARTUP_STORAGE_KEY])).toEqual({ mode: 'daily', lastPlayedDay: '2026-11-09' })

      const off = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'off', lastPlayedDay: null }) })
      const b = start({ storage: off, forceMode: 'always' })
      await flush()
      expect(b.engine.createStartupScreen).toHaveBeenCalledTimes(1)
    })

    it('开播时不记「已播」;播完(onFinish)才记,且保留 mode', async () => {
      const storage = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: '2026-11-01' }) })
      const { engine } = start({ storage })
      await flush()
      expect(JSON.parse(storage.dump()[STARTUP_STORAGE_KEY]).lastPlayedDay).toBe('2026-11-01')

      engine.calls[0].onFinish?.({ skipped: false })
      const saved = JSON.parse(storage.dump()[STARTUP_STORAGE_KEY])
      expect(saved).toEqual({ mode: 'daily', lastPlayedDay: '2026-11-09' })
    })

    it('用户跳过也算今天播过', async () => {
      const { engine, storage } = start()
      await flush()
      engine.calls[0].onFinish?.({ skipped: true })
      expect(JSON.parse(storage.dump()[STARTUP_STORAGE_KEY]).lastPlayedDay).toBe('2026-11-09')
    })

    it('播到一半被杀(没走到 onFinish):不记,下次启动重播', async () => {
      const { storage } = start()
      await flush()
      expect(storage.dump()[STARTUP_STORAGE_KEY]).toBeUndefined()
    })
  })

  describe('引擎加载失败', () => {
    it('loadEngine 抛错:不崩、不记已播、照常揭幕', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { storage } = start({ loadEngine: vi.fn(async () => { throw new Error('chunk 404') }) })
      await flush()
      expect(storage.dump()[STARTUP_STORAGE_KEY]).toBeUndefined()
      window.dispatchEvent(new Event('appReady'))
      expect(document.getElementById('pageLoader')?.classList.contains('loaded')).toBe(true)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('createStartupScreen 同步抛错:同样不崩', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { storage } = start({
        loadEngine: vi.fn(async () => ({ createStartupScreen: () => { throw new Error('boom') } }))
      })
      await flush()
      expect(storage.dump()[STARTUP_STORAGE_KEY]).toBeUndefined()
      warn.mockRestore()
    })
  })

  describe('揭幕加载页', () => {
    it('appReady 到来时揭幕 #pageLoader 和 #mainContent,之后移除加载页', async () => {
      start()
      await flush()
      const loader = document.getElementById('pageLoader') as HTMLElement
      const main = document.getElementById('mainContent') as HTMLElement
      expect(loader.classList.contains('loaded')).toBe(false)

      window.dispatchEvent(new Event('appReady'))
      expect(loader.classList.contains('loaded')).toBe(true)
      expect(main.classList.contains('loaded')).toBe(true)
      expect(document.getElementById('pageLoader')).not.toBeNull()

      vi.advanceTimersByTime(900)
      expect(document.getElementById('pageLoader')).toBeNull()
    })

    it('应用在宿主启动前就绪(appInitialized 已为真):立即揭幕', async () => {
      ;(window as { appInitialized?: boolean }).appInitialized = true
      start()
      await flush()
      expect(document.getElementById('pageLoader')?.classList.contains('loaded')).toBe(true)
    })

    it('appReady 始终不来:15 秒封顶后揭幕,不把人永远关在加载页里', async () => {
      start()
      await flush()
      vi.advanceTimersByTime(14_900)
      expect(document.getElementById('pageLoader')?.classList.contains('loaded')).toBe(false)
      vi.advanceTimersByTime(200)
      expect(document.getElementById('pageLoader')?.classList.contains('loaded')).toBe(true)
    })

    it('不播的日子同样按 appReady 揭幕(加载页行为不依赖动画)', async () => {
      const storage = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'off', lastPlayedDay: null }) })
      start({ storage })
      window.dispatchEvent(new Event('appReady'))
      expect(document.getElementById('pageLoader')?.classList.contains('loaded')).toBe(true)
    })

    it('揭幕只做一次:appReady 重复触发不会重复安排移除', async () => {
      start()
      await flush()
      window.dispatchEvent(new Event('appReady'))
      vi.advanceTimersByTime(900)
      expect(() => window.dispatchEvent(new Event('appReady'))).not.toThrow()
    })

    it('页面里没有 #pageLoader 也不抛(比如测试 / 别的入口页)', async () => {
      document.body.innerHTML = ''
      start()
      await flush()
      expect(() => window.dispatchEvent(new Event('appReady'))).not.toThrow()
    })
  })

  describe('传给引擎的参数', () => {
    it('带上音频地址(猫头是内联矢量,不再传图片地址),身份用缓存名占位,登录态未知(null)', async () => {
      const storage = memoryStorage({ [IDENTITY_STORAGE_KEY]: 'Neo' })
      const { engine } = start({ storage })
      await flush()
      const o = engine.calls[0]
      expect(o).not.toHaveProperty('markUrl')
      expect(o.assetBase).toBe('file:///app/audio/startup/')
      expect(o.config?.identity).toBe('Neo')
      // 水合前不知道是不是游客,所以不能显示「网页登录」按钮文案
      expect(o.config?.authenticated).toBeNull()
    })

    it('没有缓存名时用兜底名', async () => {
      const { engine } = start()
      await flush()
      expect(engine.calls[0].config?.identity).toBe(FALLBACK_IDENTITY)
    })
  })

  describe('登录态接线', () => {
    it('开播后水合登录态;已登录 → setAuthenticated(true) + 真名字 + 写缓存', async () => {
      const { engine, auth, storage } = start()
      auth.push({ authenticated: true, displayName: 'Trinity', username: 'trin' })
      await flush()
      expect(auth.port.hydrate).toHaveBeenCalled()
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(true)
      expect(engine.handle.setIdentity).toHaveBeenLastCalledWith('Trinity')
      expect(storage.dump()[IDENTITY_STORAGE_KEY]).toBe('Trinity')
    })

    it('游客 → setAuthenticated(false) + 兜底名,不覆盖缓存里的上一个名字', async () => {
      const storage = memoryStorage({ [IDENTITY_STORAGE_KEY]: 'Neo' })
      const { engine } = start({ storage })
      await flush()
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(false)
      expect(engine.handle.setIdentity).toHaveBeenLastCalledWith(FALLBACK_IDENTITY)
      expect(storage.dump()[IDENTITY_STORAGE_KEY]).toBe('Neo')
    })

    it('已登录但账号没有名字:画面用兜底名,缓存里已有的名字不被兜底名顶掉', async () => {
      const storage = memoryStorage({ [IDENTITY_STORAGE_KEY]: 'Neo' })
      const { engine, auth } = start({ storage })
      await flush()
      auth.push({ authenticated: true, displayName: null, username: null })
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(true)
      expect(engine.handle.setIdentity).toHaveBeenLastCalledWith(FALLBACK_IDENTITY)
      expect(storage.dump()[IDENTITY_STORAGE_KEY]).toBe('Neo')
    })

    it('动画期间在浏览器里登录成功:名字与登录态随之更新', async () => {
      const { engine, auth } = start()
      await flush()
      auth.push({ authenticated: true, displayName: 'Morpheus' })
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(true)
      expect(engine.handle.setIdentity).toHaveBeenLastCalledWith('Morpheus')
    })

    it('水合抛错不影响开播(没有 Electron preload 的环境)', async () => {
      const auth = fakeAuth()
      vi.mocked(auth.port.hydrate).mockRejectedValue(new Error('no ipc'))
      const { engine } = start({ auth: auth.port })
      await flush()
      expect(engine.createStartupScreen).toHaveBeenCalledTimes(1)
    })

    // ── 点主按钮 = 立刻发起网页登录,停在原地等结果 ──────────────────────────
    // 登录与否的判据是「登录 store 此刻的真实状态」,与设置页「登录」按钮同一套
    // (`!authenticated` → startLogin),**不是**引擎事件里镜像来的 `authenticated`:
    // 那份在水合完成前恒为 null,点早了就静默什么都不发生(「网页登录你得跳转呀」)。
    const states = (e: ReturnType<typeof fakeEngine>) =>
      vi.mocked(e.handle.setLoginState).mock.calls.map((c) => c[0])

    it('第 1 步点「网页登录」:游客 → 立刻发起网页登录一次,按钮进入「等待」', async () => {
      const { engine, auth } = start()
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      expect(auth.port.startLogin).toHaveBeenCalledTimes(1)
      expect(states(engine)[0]).toBe('waiting')
    })

    it('第 2 步(游客重新登录)同样发起网页登录', async () => {
      const { engine, auth } = start()
      await flush()
      engine.calls[0].onAction?.({ action: 'confirm', authenticated: false })
      await flush()
      expect(auth.port.startLogin).toHaveBeenCalledTimes(1)
    })

    it('点得比水合还早(引擎里登录态还是未知 null):等水合完成,按 store 真实状态发起登录', async () => {
      const auth = fakeAuth()
      let release!: () => void
      vi.mocked(auth.port.hydrate).mockImplementation(
        () => new Promise<undefined>((res) => { release = () => res(undefined) })
      )
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: null })
      await flush()
      // 水合没回来之前不能凭空判断是不是游客
      expect(auth.port.startLogin).not.toHaveBeenCalled()
      release()
      await flush()
      expect(auth.port.startLogin).toHaveBeenCalledTimes(1)
    })

    it('点得比水合还早、而水合出来发现已登录:不发起登录,直接把「已登录」交给引擎放行', async () => {
      const auth = fakeAuth()
      let release!: () => void
      vi.mocked(auth.port.hydrate).mockImplementation(
        () => new Promise<undefined>((res) => { release = () => res(undefined) })
      )
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: null })
      auth.push({ authenticated: true, displayName: 'Trinity' })
      release()
      await flush()
      expect(auth.port.startLogin).not.toHaveBeenCalled()
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(true)
      expect(states(engine)).not.toContain('waiting')
    })

    it('引擎事件说是游客、但 store 已经是登录态:以 store 为准,不发起登录,同步已登录让引擎放行', async () => {
      const { engine, auth } = start()
      await flush()
      auth.push({ authenticated: true, displayName: 'Trinity' })
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      expect(auth.port.startLogin).not.toHaveBeenCalled()
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(true)
    })

    it('已登录点第 1 步:不发起登录', async () => {
      const auth = fakeAuth({ authenticated: true, displayName: 'Trinity' })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: true })
      await flush()
      expect(auth.port.startLogin).not.toHaveBeenCalled()
    })

    it('登录已经在进行(pending):接管等待,不重复拉浏览器', async () => {
      const auth = fakeAuth({ pending: true })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      expect(auth.port.startLogin).not.toHaveBeenCalled()
      expect(states(engine)).toEqual(['waiting'])
    })

    it('接管的登录随后失败:store 推 error → 按钮显示原因', async () => {
      const auth = fakeAuth({ pending: true })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      auth.push({ pending: false, error: '用户拒绝了授权' })
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('error', '用户拒绝了授权')
    })

    it('store 推来的错误带 IPC 包装 / 网络栈名:同样友好化,不把技术名露在按钮上', async () => {
      const auth = fakeAuth({ pending: true })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      auth.push({
        pending: false,
        error: "Error invoking remote method 'auth:start-login': Error: net::ERR_CONNECTION_CLOSED"
      })
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith(
        'error',
        '无法连接登录服务，请检查网络或代理后重试'
      )
    })

    it('startLogin 还没返回时 store 推来「既没 pending 也没 error」:不当作被取消,不回 idle;随后 pending 到了继续等', async () => {
      const auth = fakeAuth()
      let finish!: () => void
      vi.mocked(auth.port.startLogin).mockImplementation(
        () => new Promise<undefined>((res) => { finish = () => res(undefined) })
      )
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      auth.push({ displayName: '路人' }) // 与登录无关的 store 更新
      expect(states(engine)).not.toContain('idle')
      auth.push({ pending: true })
      finish()
      await flush()
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('waiting')
      expect(states(engine)).not.toContain('error')
      expect(states(engine)).not.toContain('idle')
    })

    it('进行中的登录被取消(pending 消失且没有错误):回到可点,可以再点一次', async () => {
      const auth = fakeAuth({ pending: true })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      auth.push({ pending: false })
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('idle')
    })

    it('发起后 store 推 pending → 保持等待;随后登录成功 → 交给引擎放行,不再报错', async () => {
      const auth = fakeAuth()
      vi.mocked(auth.port.startLogin).mockImplementation(async () => {
        auth.push({ pending: true })
      })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('waiting')
      auth.push({ pending: false, authenticated: true, displayName: 'Morpheus' })
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(true)
      expect(states(engine)).not.toContain('error')
      expect(states(engine)).not.toContain('idle')
    })

    it('没点过动画里的按钮:store 里别处(设置页等)的登录状态变化不推进引擎闸门', async () => {
      const { engine, auth } = start()
      await flush()
      auth.push({ pending: true })
      auth.push({ pending: false, error: '别处的登录失败' })
      expect(engine.handle.setLoginState).not.toHaveBeenCalled()
    })

    it('startLogin 抛错(网络):按钮显示网络提示,不崩;再点一次重新发起', async () => {
      const auth = fakeAuth()
      vi.mocked(auth.port.startLogin).mockRejectedValueOnce(
        new Error("Error invoking remote method 'auth:start-login': Error: net::ERR_CONNECTION_CLOSED")
      )
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { engine } = start({ auth: auth.port })
      await flush()
      expect(() => engine.calls[0].onAction?.({ action: 'grant', authenticated: false })).not.toThrow()
      await flush()
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith(
        'error',
        '无法连接登录服务，请检查网络或代理后重试'
      )
      expect(warn).toHaveBeenCalled()
      // 重试:这次成功拉起
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      expect(auth.port.startLogin).toHaveBeenCalledTimes(2)
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('error', '当前环境无法发起网页登录')
      warn.mockRestore()
    })

    it('startLogin 同步抛错也走错误提示', async () => {
      const auth = fakeAuth()
      vi.mocked(auth.port.startLogin).mockImplementation(() => {
        throw new Error('sync boom')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { engine } = start({ auth: auth.port })
      await flush()
      expect(() => engine.calls[0].onAction?.({ action: 'grant', authenticated: false })).not.toThrow()
      await flush()
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('error', 'sync boom')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('startLogin 期间 store 就带回了失败原因:显示那条原因,不会再被覆盖成「无法发起」', async () => {
      const auth = fakeAuth()
      vi.mocked(auth.port.startLogin).mockImplementation(async () => {
        auth.push({ error: '授权服务暂时不可用' })
      })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('error', '授权服务暂时不可用')
      expect(states(engine).filter((s) => s === 'error')).toHaveLength(1)
    })

    it('startLogin 返回了但什么都没发生(没 pending、没 error、没登录):提示当前环境无法发起', async () => {
      const { engine, auth } = start()
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      await flush()
      expect(auth.port.startLogin).toHaveBeenCalledTimes(1)
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('error', '当前环境无法发起网页登录')
    })

    it('水合失败(没有 Electron preload):仍按 store 当前状态处理,不吞掉点击', async () => {
      const auth = fakeAuth()
      vi.mocked(auth.port.hydrate).mockRejectedValue(new Error('no ipc'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: null })
      await flush()
      expect(auth.port.startLogin).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })

    it('等水合期间动画被销毁:点击作废,不再发起登录', async () => {
      const auth = fakeAuth()
      let release!: () => void
      vi.mocked(auth.port.hydrate).mockImplementation(
        () => new Promise<undefined>((res) => { release = () => res(undefined) })
      )
      const { host, engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: null })
      host.dispose()
      release()
      await flush()
      expect(auth.port.startLogin).not.toHaveBeenCalled()
    })

    it('没有 auth 端口(取不到登录模块):照常开播,告诉引擎「没有登录能力」别拦人,点按钮也不抛', async () => {
      const { engine } = start({ auth: null })
      await flush()
      expect(engine.createStartupScreen).toHaveBeenCalledTimes(1)
      expect(engine.handle.setLoginRequired).toHaveBeenCalledWith(false)
      expect(() => engine.calls[0].onAction?.({ action: 'grant', authenticated: false })).not.toThrow()
    })

    // ── 第 2 步「退出登录」 ───────────────────────────────────────────────
    it('退出登录:调 logout;成功后把「未登录」交给引擎并回到可点,不自动拉浏览器', async () => {
      const auth = fakeAuth({ authenticated: true, displayName: 'Trinity' })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'logout', authenticated: true })
      await flush()
      expect(auth.port.logout).toHaveBeenCalledTimes(1)
      expect(engine.handle.setAuthenticated).toHaveBeenLastCalledWith(false)
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('idle')
      expect(auth.port.startLogin).not.toHaveBeenCalled()
    })

    it('退出登录之后再点「网页登录验证身份」:才发起登录(换账号)', async () => {
      const auth = fakeAuth({ authenticated: true, displayName: 'Trinity' })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'logout', authenticated: true })
      await flush()
      engine.calls[0].onAction?.({ action: 'confirm', authenticated: false })
      await flush()
      expect(auth.port.startLogin).toHaveBeenCalledTimes(1)
    })

    it('退出登录失败:提示原因、不回 idle(引擎里按钮保持可再点),不崩', async () => {
      const auth = fakeAuth({ authenticated: true, displayName: 'Trinity' })
      vi.mocked(auth.port.logout!).mockRejectedValue(new Error('ipc down'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { engine } = start({ auth: auth.port })
      await flush()
      expect(() => engine.calls[0].onAction?.({ action: 'logout', authenticated: true })).not.toThrow()
      await flush()
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('error', '退出登录失败，请重试')
      expect(engine.handle.setAuthenticated).not.toHaveBeenCalledWith(false)
      warn.mockRestore()
    })

    it('端口没有 logout 能力:不能让界面卡在「正在退出…」,回到可点', async () => {
      const auth = fakeAuth({ authenticated: true, displayName: 'Trinity' })
      delete auth.port.logout
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'logout', authenticated: true })
      await flush()
      expect(engine.handle.setLoginState).toHaveBeenLastCalledWith('idle')
    })

    // ── 跳过登录 / Esc / SKIP:顺手收拾进行中的登录 ───────────────────────────
    describe('跳过时收拾登录', () => {
      it('点过登录、浏览器正在等:跳过 → 取消进行中的登录', async () => {
        const auth = fakeAuth({ pending: true })
        const { engine } = start({ auth: auth.port })
        await flush()
        engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
        await flush()
        engine.calls[0].onFinish?.({ skipped: true })
        expect(auth.port.cancelLogin).toHaveBeenCalledTimes(1)
        expect(auth.port.dismissLogin).not.toHaveBeenCalled()
      })

      it('点过登录、失败提示还在:跳过 → 清掉提示,不发取消', async () => {
        const auth = fakeAuth({ pending: true })
        const { engine } = start({ auth: auth.port })
        await flush()
        engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
        await flush()
        auth.push({ pending: false, error: '失败了' })
        engine.calls[0].onFinish?.({ skipped: true })
        expect(auth.port.dismissLogin).toHaveBeenCalledTimes(1)
        expect(auth.port.cancelLogin).not.toHaveBeenCalled()
      })

      it('根本没点过登录:跳过不碰 store(哪怕别处正在登录)', async () => {
        const { engine, auth } = start()
        await flush()
        auth.push({ pending: true })
        engine.calls[0].onFinish?.({ skipped: true })
        expect(auth.port.cancelLogin).not.toHaveBeenCalled()
        expect(auth.port.dismissLogin).not.toHaveBeenCalled()
      })

      it('正常播完(没跳过):不取消、不清提示', async () => {
        const auth = fakeAuth({ pending: true })
        const { engine } = start({ auth: auth.port })
        await flush()
        engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
        await flush()
        engine.calls[0].onFinish?.({ skipped: false })
        expect(auth.port.cancelLogin).not.toHaveBeenCalled()
        expect(auth.port.dismissLogin).not.toHaveBeenCalled()
      })

      it('取消登录抛错:吞掉,不影响收尾', async () => {
        const auth = fakeAuth({ pending: true })
        vi.mocked(auth.port.cancelLogin!).mockRejectedValue(new Error('ipc down'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { engine } = start({ auth: auth.port })
        await flush()
        engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
        await flush()
        expect(() => engine.calls[0].onFinish?.({ skipped: true })).not.toThrow()
        await flush()
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
      })
    })
  })

  describe('friendlyLoginError', () => {
    it('IPC 包装 + 网络栈错误 → 一句网络提示,不露技术名', () => {
      expect(
        friendlyLoginError("Error invoking remote method 'auth:start-login': Error: net::ERR_CONNECTION_CLOSED")
      ).toBe('无法连接登录服务，请检查网络或代理后重试')
    })

    it('常见网络错误关键词都归到网络提示', () => {
      for (const raw of ['connect ECONNREFUSED 127.0.0.1:1', 'getaddrinfo ENOTFOUND x', 'fetch failed', 'socket hang up', 'ETIMEDOUT', 'TLS handshake timeout']) {
        expect(friendlyLoginError(raw)).toBe('无法连接登录服务，请检查网络或代理后重试')
      }
    })

    it('主进程映射过的中文原因原样保留(去掉 IPC / Error 前缀)', () => {
      expect(friendlyLoginError("Error invoking remote method 'auth:start-login': Error: 用户拒绝了授权")).toBe('用户拒绝了授权')
      expect(friendlyLoginError('用户拒绝了授权')).toBe('用户拒绝了授权')
    })

    it('Error 对象取 message;空 / 非字符串 → 通用提示', () => {
      expect(friendlyLoginError(new Error('授权码已过期'))).toBe('授权码已过期')
      for (const raw of ['', '   ', null, undefined, 42, {}]) {
        expect(friendlyLoginError(raw)).toBe('登录没有完成，请重试')
      }
    })

    it('折叠空白;超过 60 字截断加省略号', () => {
      expect(friendlyLoginError('a\n\n b\t c')).toBe('a b c')
      const long = friendlyLoginError('长'.repeat(100))
      expect(long).toBe(`${'长'.repeat(60)}…`)
    })
  })

  describe('收尾', () => {
    it('动画结束后退订登录态', async () => {
      const { engine, auth } = start()
      await flush()
      expect(auth.listeners.size).toBe(1)
      engine.calls[0].onDone?.({ skipped: false })
      expect(auth.listeners.size).toBe(0)
    })

    it('dispose:销毁引擎、退订登录态、不再响应 appReady', async () => {
      const { host, engine, auth } = start()
      await flush()
      host.dispose()
      expect(engine.handle.dispose).toHaveBeenCalled()
      expect(auth.listeners.size).toBe(0)
      window.dispatchEvent(new Event('appReady'))
      expect(document.getElementById('pageLoader')?.classList.contains('loaded')).toBe(false)
    })

    it('引擎还没加载完就 dispose:加载完成后不再开播', async () => {
      let release!: (m: StartupEngineModule) => void
      const loadEngine = vi.fn(() => new Promise<StartupEngineModule>((res) => { release = res }))
      const engine = fakeEngine()
      const { host } = start({ loadEngine })
      host.dispose()
      release({ createStartupScreen: engine.createStartupScreen })
      await flush()
      expect(engine.createStartupScreen).not.toHaveBeenCalled()
    })
  })
})
