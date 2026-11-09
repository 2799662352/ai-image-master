/**
 * 启动动画宿主层:「今天播不播」「何时揭幕」「登录态怎么接进去」。
 *
 * 引擎本身(engine.js)有自己的 jsdom 时间线测试;这里把引擎换成假的,
 * 只验证宿主对它的调用与对 DOM / 存档 / 登录态的副作用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initStartupScreen } from '../index'
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
  const port: AuthPort = {
    getState: () => state,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    hydrate: vi.fn(async () => undefined),
    startLogin: vi.fn(async () => undefined)
  }
  return {
    port,
    listeners,
    push(next: Partial<AuthSnapshot>) {
      state = { ...state, ...next }
      for (const l of [...listeners]) l(state)
    }
  }
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
      markUrl: 'file:///app/images/logo.png',
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
    it('带上 logo 与音频地址,身份用缓存名占位,登录态未知(null)', async () => {
      const storage = memoryStorage({ [IDENTITY_STORAGE_KEY]: 'Neo' })
      const { engine } = start({ storage })
      await flush()
      const o = engine.calls[0]
      expect(o.markUrl).toBe('file:///app/images/logo.png')
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

    it('第 1 步点「网页登录」:游客 → 发起网页登录一次', async () => {
      const { engine, auth } = start()
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      expect(auth.port.startLogin).toHaveBeenCalledTimes(1)
    })

    it('已登录点第 1 步:不发起登录', async () => {
      const { engine, auth } = start()
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: true })
      expect(auth.port.startLogin).not.toHaveBeenCalled()
    })

    it('第 2 步(确认身份)从不触发登录', async () => {
      const { engine, auth } = start()
      await flush()
      engine.calls[0].onAction?.({ action: 'confirm', authenticated: false })
      expect(auth.port.startLogin).not.toHaveBeenCalled()
    })

    it('登录已经在进行(pending)时不重复发起', async () => {
      const auth = fakeAuth({ pending: true })
      const { engine } = start({ auth: auth.port })
      await flush()
      engine.calls[0].onAction?.({ action: 'grant', authenticated: false })
      expect(auth.port.startLogin).not.toHaveBeenCalled()
    })

    it('startLogin 抛错被吞掉,动画不受影响', async () => {
      const auth = fakeAuth()
      vi.mocked(auth.port.startLogin).mockRejectedValue(new Error('ipc down'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { engine } = start({ auth: auth.port })
      await flush()
      expect(() => engine.calls[0].onAction?.({ action: 'grant', authenticated: false })).not.toThrow()
      await flush()
      warn.mockRestore()
    })

    it('没有 auth 端口(取不到登录模块):照常开播,点按钮也不抛', async () => {
      const { engine } = start({ auth: null })
      await flush()
      expect(engine.createStartupScreen).toHaveBeenCalledTimes(1)
      expect(() => engine.calls[0].onAction?.({ action: 'grant', authenticated: false })).not.toThrow()
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
