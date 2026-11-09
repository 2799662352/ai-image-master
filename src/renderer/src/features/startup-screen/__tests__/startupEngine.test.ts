/**
 * 启动动画引擎(engine.js)的行为测试 —— 用真 jsdom + 假定时器把整条时间线跑一遍。
 *
 * jsdom 没有 Web Animations / AudioContext / speechSynthesis,引擎对这些都有降级;
 * 这里正是要钉住「降级之后时间线照样走完、不抛、不卡」。
 * 语音素材用假 <audio> 注入(createAudio),不碰真实文件和网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStartupScreen } from '../engine.js'
import type {
  StartupActionEvent,
  StartupAudioLike,
  StartupEngineOptions,
  StartupScreenHandle
} from '../engineTypes'

const ROOT = '#cat-startup-root'
const MARK = 'file:///app/images/logo.png'

/** 推进假时间,直到条件成立(最多 maxMs)。条件始终不成立就抛,免得测试静默空转。 */
async function advanceUntil(pred: () => boolean, maxMs = 120_000, stepMs = 50): Promise<void> {
  let spent = 0
  while (!pred() && spent < maxMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
    spent += stepMs
  }
  if (!pred()) throw new Error(`advanceUntil: ${maxMs}ms 内条件没成立`)
}

const root = (): HTMLElement | null => document.querySelector<HTMLElement>(ROOT)
const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const n = root()?.querySelector<T>(sel)
  if (!n) throw new Error(`找不到 ${sel}`)
  return n
}
const actionShown = (): boolean => !!root()?.querySelector('.dsu-action.dsu-in')

interface FakeAudioOpts {
  duration?: number
  /** 加载就失败(素材缺失) */
  fail?: boolean
  /** play() 之后永远不触发 ended(卡住的音频设备) */
  neverEnds?: boolean
  /** play() 被浏览器自动播放策略拒绝 */
  rejectPlay?: boolean
}

function makeFakeAudio(opts: FakeAudioOpts = {}) {
  const listeners = new Map<string, Set<() => void>>()
  const emit = (type: string): void => {
    for (const cb of [...(listeners.get(type) ?? [])]) cb()
  }
  const dur = opts.duration ?? 1
  const audio = {
    preload: '',
    volume: 1,
    currentTime: 0,
    duration: Number.NaN,
    readyState: 0,
    play: vi.fn(() => {
      if (opts.rejectPlay) return Promise.reject(new Error('NotAllowedError'))
      if (!opts.neverEnds) setTimeout(() => emit('ended'), dur * 1000)
      return Promise.resolve()
    }),
    pause: vi.fn(),
    load: vi.fn(() => {
      setTimeout(() => {
        if (opts.fail) {
          emit('error')
          return
        }
        audio.duration = dur
        audio.readyState = 4
        emit('loadedmetadata')
      }, 10)
    }),
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb)
    }
  }
  return audio
}

/**
 * 假的 WebAudio:只记录每个振荡器起始频率。jsdom 没有 AudioContext,界面合成音
 * 平时全是空操作;要验证「哪一声该响、哪一声不该响」就得有个能数的。
 */
function installFakeAudioContext() {
  const freqs: number[] = []
  const w = window as unknown as { AudioContext?: unknown }
  const prev = w.AudioContext
  class FakeAudioContext {
    state = 'running'
    currentTime = 0
    sampleRate = 44100
    destination = {}
    resume() {
      return Promise.resolve()
    }
    createGain() {
      return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }
    }
    createOscillator() {
      return {
        type: '',
        frequency: {
          setValueAtTime(f: number) {
            freqs.push(f)
          },
          exponentialRampToValueAtTime() {}
        },
        connect() {},
        start() {},
        stop() {}
      }
    }
  }
  w.AudioContext = FakeAudioContext
  return {
    freqs,
    restore: () => {
      if (prev === undefined) delete w.AudioContext
      else w.AudioContext = prev
    }
  }
}

describe('createStartupScreen 引擎', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let handle: StartupScreenHandle | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="app">应用本体</div>'
    document.documentElement.className = ''
    document.documentElement.style.overflow = ''
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    try {
      handle?.dispose()
    } catch {
      /* noop */
    }
    handle = null
    vi.clearAllTimers()
    vi.useRealTimers()
    warn.mockRestore()
    document.body.innerHTML = ''
  })

  function start(over: Partial<StartupEngineOptions> = {}) {
    const onAction = vi.fn<(e: StartupActionEvent) => void>()
    const onFinish = vi.fn()
    const onDone = vi.fn()
    handle = createStartupScreen({
      markUrl: MARK,
      // 不给 assetBase:没有语音素材 = 静音,时间线不等任何加载
      onAction,
      onFinish,
      onDone,
      ...over
    })
    return { handle: handle!, onAction, onFinish, onDone }
  }

  /**
   * 跑到确认按钮亮出来、并且真的可点了。
   * 引擎在按钮亮出后还要等 520ms 才挂点击监听(原版就有,防止动画刚出现时的误触),
   * 所以「亮了」不等于「可点」,这里再多推一点。
   */
  async function toGrant(): Promise<void> {
    await advanceUntil(actionShown)
    await vi.advanceTimersByTimeAsync(700)
  }
  /** 点掉当前这一步的确认,等它收起 */
  async function confirmCurrent(): Promise<void> {
    q('.dsu-btn').click()
    await advanceUntil(() => !actionShown())
  }

  describe('搭建', () => {
    it('根节点、猫头、品牌字都在;滚动被锁住', () => {
      start()
      expect(root()).not.toBeNull()
      expect(document.documentElement.classList.contains('dsu-lock')).toBe(true)
      expect(document.documentElement.style.overflow).toBe('hidden')
      // 黑幕 / 中央标识 / 终幕三处都是应用自己的猫头 <img>
      const marks = [...(root()!.querySelectorAll<HTMLImageElement>('img.dsu-mark'))]
      expect(marks).toHaveLength(3)
      for (const m of marks) expect(m.getAttribute('src')).toBe(MARK)
      expect(q('.dsu-black-en').textContent).toBe('CATIMATION')
      expect(q('.dsu-black-sub').textContent).toBe('CYBERPUNK MASTER')
    })

    it('没有 DeepSeek / dsh 的任何痕迹(文案、类名、id、svg 鲸鱼)', () => {
      start()
      const html = root()!.outerHTML
      expect(html).not.toMatch(/deepseek/i)
      expect(html).not.toMatch(/dsh/i)
      expect(html).not.toMatch(/whale/i)
      expect(root()!.querySelector('svg.dsu-logo-svg, .dsu-whale')).toBeNull()
    })

    it('界面里没有任何输入框(登录走系统浏览器,不在动画里输密码)', () => {
      start()
      expect(root()!.querySelector('input, textarea, [contenteditable], [type=password]')).toBeNull()
    })

    it('没给 markUrl:猫头退成空占位,不出破图,时间线照常搭得起来', () => {
      start({ markUrl: undefined })
      expect(root()!.querySelectorAll('img')).toHaveLength(0)
      expect(root()!.querySelectorAll('span.dsu-mark')).toHaveLength(3)
    })

    it('页面上留着上一个实例的残骸:只剩一个根节点', () => {
      document.body.insertAdjacentHTML('beforeend', '<div id="cat-startup-root">stray</div>')
      start()
      expect(document.querySelectorAll(ROOT)).toHaveLength(1)
      expect(root()!.textContent).not.toContain('stray')
    })

    it('同一时刻 theme=dark 走深色版式', () => {
      start({ config: { theme: 'dark' } })
      expect(root()!.classList.contains('dsu-dark')).toBe(true)
    })

    it('Web Animations / AudioContext / speechSynthesis 全缺(jsdom):搭建不抛', () => {
      expect(typeof (HTMLElement.prototype as { animate?: unknown }).animate).toBe('undefined')
      expect(() => start()).not.toThrow()
    })
  })

  describe('完整时间线(要点击)', () => {
    it('第 1、2 步各点一次,走到终幕,onFinish / onDone 各一次,根节点摘除、滚动解锁', async () => {
      const { onAction, onFinish, onDone } = start({ config: { authenticated: true } })
      await toGrant()
      await confirmCurrent()
      await toGrant() // 第 2 步
      await confirmCurrent()
      await advanceUntil(() => onFinish.mock.calls.length > 0)

      expect(onFinish).toHaveBeenCalledTimes(1)
      expect(onFinish).toHaveBeenCalledWith({ skipped: false })
      expect(onAction.mock.calls.map((c) => c[0].action)).toEqual(['grant', 'confirm'])

      // 揭幕淡出结束后才摘节点、回调 onDone
      expect(onDone).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onDone).toHaveBeenCalledWith({ skipped: false })
      expect(root()).toBeNull()
      expect(document.documentElement.classList.contains('dsu-lock')).toBe(false)
      expect(document.documentElement.style.overflow).toBe('')
      expect(handle!.isFinished()).toBe(true)
      // 整条时间线没有走到 catch 里的「动画异常」兜底
      expect(warn.mock.calls.some((c) => String(c[0]).includes('动画异常'))).toBe(false)
    })

    it('终幕有「欢迎 + 名字」,猫头和品牌字都出现在终幕版式里', async () => {
      const { onFinish } = start({ config: { identity: '小猫', authenticated: true } })
      await toGrant()
      await confirmCurrent()
      await toGrant()
      await confirmCurrent()
      await advanceUntil(() => !!root()?.querySelector('.dsu-welcome.dsu-in'))
      expect(q('.dsu-w4').textContent).toBe('欢迎 小猫 访问')
      expect(q('.dsu-w2').textContent).toBe('CATIMATION')
      expect(q('.dsu-w3 img.dsu-mark').getAttribute('src')).toBe(MARK)
      await advanceUntil(() => onFinish.mock.calls.length > 0)
    })

    it('第 1 步卡片只在第 2 步(身份确认)才出现,且列出身份名称', async () => {
      start({ config: { identity: '小猫', authenticated: true } })
      await toGrant()
      expect(q('.dsu-card').hidden).toBe(true)
      await confirmCurrent()
      await toGrant()
      expect(q('.dsu-card').hidden).toBe(false)
      expect(q('.dsu-card').textContent).toContain('小猫')
    })

    it('用户一直不点:不会被看门狗踢出去,一直停在确认按钮上', async () => {
      const { onFinish, onAction } = start()
      await toGrant()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onFinish).not.toHaveBeenCalled()
      expect(onAction).not.toHaveBeenCalled()
      expect(actionShown()).toBe(true)
    })
  })

  describe('整段自动(requireInteraction:false)', () => {
    it('不用点击就能走完,而且不触发任何 onAction', async () => {
      const { onAction, onFinish } = start({ config: { requireInteraction: false } })
      await advanceUntil(() => onFinish.mock.calls.length > 0)
      expect(onFinish).toHaveBeenCalledWith({ skipped: false })
      expect(onAction).not.toHaveBeenCalled()
    })
  })

  describe('确认动作 → onAction(游客登录的入口)', () => {
    it('点第 1 步的按钮:onAction({action:grant, authenticated:false})', async () => {
      const { onAction } = start({ config: { authenticated: false } })
      await toGrant()
      q('.dsu-btn').click()
      expect(onAction).toHaveBeenCalledTimes(1)
      expect(onAction).toHaveBeenCalledWith({ action: 'grant', authenticated: false })
    })

    it('点按钮外的整块确认区域同样算一次点击', async () => {
      const { onAction } = start({ config: { authenticated: false } })
      await toGrant()
      q('.dsu-action').click()
      expect(onAction).toHaveBeenCalledTimes(1)
    })

    it.each([['Enter'], [' ']])('按 %j 等同点击(且默认行为被拦下)', async (key) => {
      const { onAction } = start({ config: { authenticated: false } })
      await toGrant()
      const ev = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true })
      document.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true)
      expect(onAction).toHaveBeenCalledTimes(1)
      expect(onAction.mock.calls[0][0].action).toBe('grant')
    })

    it('其它按键不算确认', async () => {
      const { onAction } = start({ config: { authenticated: false } })
      await toGrant()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      expect(onAction).not.toHaveBeenCalled()
      expect(actionShown()).toBe(true)
    })

    it('连点两下只算一次(按钮收起前不会重复通知宿主去登录)', async () => {
      const { onAction } = start({ config: { authenticated: false } })
      await toGrant()
      q('.dsu-btn').click()
      q('.dsu-btn').click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(onAction).toHaveBeenCalledTimes(1)
    })

    it('登录态未知(水合前)点击:authenticated 为 null,宿主据此不发起登录', async () => {
      const { onAction } = start()
      await toGrant()
      q('.dsu-btn').click()
      expect(onAction).toHaveBeenCalledWith({ action: 'grant', authenticated: null })
    })

    it('宿主的 onAction 抛错不拖垮时间线', async () => {
      const onFinish = vi.fn()
      start({
        config: { authenticated: true },
        onAction: () => {
          throw new Error('宿主出错')
        },
        onFinish
      })
      await toGrant()
      await confirmCurrent()
      await toGrant()
      await confirmCurrent()
      await advanceUntil(() => onFinish.mock.calls.length > 0)
      expect(onFinish).toHaveBeenCalledTimes(1)
    })

    it('跳过时不会把「点击」通知给宿主(跳过不是授权)', async () => {
      const { onAction, onFinish } = start({ config: { authenticated: false } })
      await toGrant()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(onFinish).toHaveBeenCalledWith({ skipped: true })
      expect(onAction).not.toHaveBeenCalled()
    })
  })

  describe('登录闸门(没登录就不放行)', () => {
    const btnZh = (): string => q('.dsu-btn-zh').textContent ?? ''
    const hint = (): string => q('.dsu-hint').textContent ?? ''
    const actions = (onAction: { mock: { calls: Array<[StartupActionEvent]> } }): string[] =>
      onAction.mock.calls.map((c) => c[0].action)

    /** 游客点第 1 步主按钮,返回句柄与宿主回调 */
    async function guestClicksGrant(over: Partial<StartupEngineOptions> = {}) {
      const ctx = start({ config: { authenticated: false }, ...over })
      await toGrant()
      q('.dsu-btn').click()
      return ctx
    }

    it('游客点主按钮:立刻通知宿主去登录,但不放行 —— 停在原地,等多久都不被看门狗踢走', async () => {
      const { onAction, onFinish } = await guestClicksGrant()
      expect(actions(onAction)).toEqual(['grant'])
      expect(btnZh()).toBe('正在确认登录状态…')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(actionShown()).toBe(true)
      expect(onFinish).not.toHaveBeenCalled()
      expect(q('.dsu-card').hidden).toBe(true) // 没进第 2 步
    })

    it('登录态未知(null)的人点主按钮同样不放行(宿主还没水合出结果)', async () => {
      const { onAction, onFinish } = start()
      await toGrant()
      q('.dsu-btn').click()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(actions(onAction)).toEqual(['grant'])
      expect(actionShown()).toBe(true)
      expect(onFinish).not.toHaveBeenCalled()
    })

    it('宿主推到 waiting:按钮显示等浏览器、标忙碌;等待中连点 / 回车 / 空格都不再重复通知宿主', async () => {
      const { handle: h, onAction } = await guestClicksGrant()
      h.setLoginState('waiting')
      expect(btnZh()).toBe('等待浏览器登录…')
      expect(q('.dsu-btn').getAttribute('aria-busy')).toBe('true')
      expect(q('.dsu-btn').classList.contains('dsu-wait')).toBe(true)
      q('.dsu-btn').click()
      q('.dsu-action').click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      expect(actions(onAction)).toEqual(['grant'])
    })

    it('登录成功(setAuthenticated(true)):点过按钮的这一步当场放行,且放行本身不再通知宿主', async () => {
      const { handle: h, onAction } = await guestClicksGrant()
      h.setLoginState('waiting')
      h.setAuthenticated(true)
      await advanceUntil(() => !actionShown())
      await toGrant() // 第 2 步
      expect(q('.dsu-card').hidden).toBe(false)
      // 闸门状态不带到下一步:第 2 步是干净的「确认身份」
      expect(btnZh()).toBe('确认身份')
      expect(q('.dsu-btn').getAttribute('aria-busy')).toBe('false')
      expect(actions(onAction)).toEqual(['grant'])
    })

    it('没点过按钮时别处登录成功了:不替人放行,按钮变回「授予访问权限」,点一下才走', async () => {
      const { handle: h, onAction, onFinish } = start({ config: { authenticated: false } })
      await toGrant()
      h.setAuthenticated(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(actionShown()).toBe(true)
      expect(btnZh()).toBe('授予访问权限')
      expect(onFinish).not.toHaveBeenCalled()
      q('.dsu-btn').click()
      expect(actions(onAction)).toEqual(['grant'])
      await advanceUntil(() => !actionShown())
    })

    it('出错:按钮变「重新登录」,原因显示在提示行(带出错样式);再点一次重新通知宿主', async () => {
      const { handle: h, onAction } = await guestClicksGrant()
      h.setLoginState('error', '无法连接登录服务，请检查网络或代理后重试')
      expect(btnZh()).toBe('重新登录')
      expect(hint()).toContain('无法连接登录服务，请检查网络或代理后重试')
      expect(hint()).toContain('Esc')
      expect(q('.dsu-hint').classList.contains('dsu-err')).toBe(true)
      expect(q('.dsu-btn').classList.contains('dsu-wait')).toBe(false)
      q('.dsu-btn').click()
      expect(actions(onAction)).toEqual(['grant', 'grant'])
      expect(btnZh()).toBe('正在确认登录状态…')
      expect(q('.dsu-hint').classList.contains('dsu-err')).toBe(false)
    })

    it('错误原因只当文字:HTML 不成节点、控制字符折成空格、超长截到 80 字;没给原因用兜底句', async () => {
      const { handle: h } = await guestClicksGrant()
      h.setLoginState('error', '<img src=x onerror=alert(1)>')
      expect(q('.dsu-hint').querySelectorAll('img')).toHaveLength(0)
      expect(hint()).toContain('<img')
      h.setLoginState('error', 'A\nB\tC')
      expect(hint()).toContain('A B C')
      h.setLoginState('error', '长'.repeat(200))
      expect(hint()).toContain('长'.repeat(80))
      expect(hint()).not.toContain('长'.repeat(81))
      h.setLoginState('error')
      expect(hint()).toContain('登录没有完成，请重试')
    })

    it('未知的状态值按 idle 处理(回到可点);下一步不继承上一步的状态', async () => {
      const { handle: h } = await guestClicksGrant()
      h.setLoginState('waiting')
      h.setLoginState('bogus' as never)
      expect(btnZh()).toBe('网页登录授权')
      expect(q('.dsu-btn').getAttribute('aria-busy')).toBe('false')
    })

    it('已登录的人:点一下就走,不经过闸门', async () => {
      const { onAction } = start({ config: { authenticated: true } })
      await toGrant()
      q('.dsu-btn').click()
      expect(actions(onAction)).toEqual(['grant'])
      await advanceUntil(() => !actionShown())
    })

    it('第 1 步靠登录成功放行后,「点过按钮」不带进第 2 步:store 重复推一次已登录,不会替人确认身份', async () => {
      const { handle: h, onAction, onFinish } = await guestClicksGrant()
      h.setLoginState('waiting')
      h.setAuthenticated(true)
      await advanceUntil(() => !actionShown())
      await toGrant() // 第 2 步:身份确认
      expect(q('.dsu-card').hidden).toBe(false)
      h.setAuthenticated(true) // 登录 store 常会重复推同一份状态(刷新令牌 / 改名)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(actionShown()).toBe(true)
      expect(q('.dsu-card').hidden).toBe(false)
      expect(onFinish).not.toHaveBeenCalled()
      expect(actions(onAction)).toEqual(['grant'])
      // 用户自己点了才确认
      q('.dsu-btn').click()
      expect(actions(onAction)).toEqual(['grant', 'confirm'])
    })

    describe('宿主没有登录能力(setLoginRequired(false) / requireLogin:false)', () => {
      it('已点过按钮卡在闸门上的人当场放行', async () => {
        const { handle: h } = await guestClicksGrant()
        h.setLoginRequired(false)
        await advanceUntil(() => !actionShown())
      })

      it('之后游客点主按钮也直接放行,不再等登录', async () => {
        const { handle: h, onAction } = start({ config: { authenticated: false } })
        h.setLoginRequired(false)
        await toGrant()
        q('.dsu-btn').click()
        expect(actions(onAction)).toEqual(['grant'])
        await advanceUntil(() => !actionShown())
      })

      it('配置里 requireLogin:false:游客一点就走;没有「跳过登录」(没东西可跳)', async () => {
        const { onAction } = start({ config: { authenticated: false, requireLogin: false } })
        await toGrant()
        expect(q('.dsu-skiplogin').hidden).toBe(true)
        q('.dsu-btn').click()
        expect(actions(onAction)).toEqual(['grant'])
        await advanceUntil(() => !actionShown())
      })

      it('没点过按钮的人不被替放行', async () => {
        const { handle: h, onFinish } = start({ config: { authenticated: false } })
        await toGrant()
        h.setLoginRequired(false)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(actionShown()).toBe(true)
        expect(onFinish).not.toHaveBeenCalled()
      })
    })

    describe('「跳过登录」', () => {
      it('游客 / 登录态未知的人看得到;已登录的人看不到', async () => {
        const guest = start({ config: { authenticated: false } })
        await toGrant()
        expect(q('.dsu-skiplogin').hidden).toBe(false)
        expect(q('.dsu-skiplogin').textContent).toContain('跳过登录')
        guest.handle.setAuthenticated(true)
        expect(q('.dsu-skiplogin').hidden).toBe(true)
      })

      it('allowSkip:false 时没有任何跳过出口(含跳过登录)', async () => {
        start({ config: { authenticated: false, allowSkip: false } })
        await toGrant()
        expect(q('.dsu-skiplogin').hidden).toBe(true)
      })

      it('点它:跳过动画直接进应用(onFinish skipped),不通知宿主去登录', async () => {
        const { onAction, onFinish } = start({ config: { authenticated: false } })
        await toGrant()
        q('.dsu-skiplogin').click()
        expect(onFinish).toHaveBeenCalledWith({ skipped: true })
        expect(onAction).not.toHaveBeenCalled()
      })

      it('等登录的过程中也能点它放弃', async () => {
        const { handle: h, onFinish } = await guestClicksGrant()
        h.setLoginState('waiting')
        q('.dsu-skiplogin').click()
        expect(onFinish).toHaveBeenCalledTimes(1)
        expect(onFinish).toHaveBeenCalledWith({ skipped: true })
        await vi.advanceTimersByTimeAsync(1000)
        expect(root()).toBeNull()
      })

      it('出错之后也能点它放弃', async () => {
        const { handle: h, onFinish } = await guestClicksGrant()
        h.setLoginState('error', '登录失败')
        q('.dsu-skiplogin').click()
        expect(onFinish).toHaveBeenCalledWith({ skipped: true })
      })

      it('Esc / 右上角 SKIP 与它是同一个出口(闸门上也一样)', async () => {
        const a = await guestClicksGrant()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(a.onFinish).toHaveBeenCalledWith({ skipped: true })
        a.handle.dispose()
        document.body.innerHTML = '<div id="app">应用本体</div>'
        const b = await guestClicksGrant()
        q('.dsu-skip').click()
        expect(b.onFinish).toHaveBeenCalledWith({ skipped: true })
      })

      it('点在「跳过登录 / 退出登录」所在容器的空隙上:不算主按钮,不通知宿主、也不放行', async () => {
        const { onAction, onFinish } = start({ config: { authenticated: false } })
        await toGrant()
        q('.dsu-subact').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await vi.advanceTimersByTimeAsync(2_000)
        expect(onAction).not.toHaveBeenCalled()
        expect(onFinish).not.toHaveBeenCalled()
        expect(actionShown()).toBe(true)
      })

      it('焦点在它上面按 Enter / 空格:只触发它自己,不会被当成主按钮去登录', async () => {
        const { onAction } = start({ config: { authenticated: false } })
        await toGrant()
        const link = q('.dsu-skiplogin')
        link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        link.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
        expect(onAction).not.toHaveBeenCalled()
      })
    })

    describe('「退出登录」(第 2 步身份确认)', () => {
      /** 已登录的人走到第 2 步 */
      async function atConfirm(over: Partial<StartupEngineOptions> = {}) {
        const ctx = start({ config: { authenticated: true, identity: '小猫' }, ...over })
        await toGrant()
        await confirmCurrent()
        await toGrant()
        return ctx
      }

      it('只在第 2 步且已登录时出现;第 1 步、游客都没有', async () => {
        const ctx = start({ config: { authenticated: true } })
        await toGrant()
        expect(q('.dsu-logout').hidden).toBe(true) // 第 1 步
        await confirmCurrent()
        await toGrant()
        expect(q('.dsu-logout').hidden).toBe(false)
        expect(q('.dsu-logout').textContent).toContain('退出登录')
        ctx.handle.setAuthenticated(false)
        expect(q('.dsu-logout').hidden).toBe(true)
      })

      it('点它:通知宿主 logout,进入「正在退出…」(禁用、主按钮暂不响应)', async () => {
        const { onAction } = await atConfirm()
        q('.dsu-logout').click()
        expect(onAction).toHaveBeenLastCalledWith({ action: 'logout', authenticated: true })
        expect(q('.dsu-logout').textContent).toContain('正在退出')
        expect((q('.dsu-logout') as HTMLButtonElement).disabled).toBe(true)
        const before = onAction.mock.calls.length
        q('.dsu-btn').click()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        expect(onAction.mock.calls.length).toBe(before)
        expect(actionShown()).toBe(true)
      })

      it('正在退出时再来一次 click(合成事件绕过 disabled)也不重复通知宿主', async () => {
        const { onAction } = await atConfirm()
        q('.dsu-logout').click()
        q('.dsu-logout').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(actions(onAction)).toEqual(['grant', 'logout'])
      })

      it('点在容器空隙上不算确认身份(不放行、不退出)', async () => {
        const { onAction, onFinish } = await atConfirm()
        q('.dsu-subact').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await vi.advanceTimersByTimeAsync(2_000)
        expect(actions(onAction)).toEqual(['grant'])
        expect(onFinish).not.toHaveBeenCalled()
        expect(actionShown()).toBe(true)
      })

      it('点它不会被外层当成「确认身份」(不放行)', async () => {
        const { onAction, onFinish } = await atConfirm()
        q('.dsu-logout').click()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(actions(onAction)).toEqual(['grant', 'logout'])
        expect(actionShown()).toBe(true)
        expect(onFinish).not.toHaveBeenCalled()
      })

      it('宿主退出成功(推回未登录):按钮变回「网页登录验证身份」,身份卡写「未登录」,可以重新网页登录', async () => {
        const { handle: h, onAction } = await atConfirm()
        q('.dsu-logout').click()
        h.setAuthenticated(false)
        h.setLoginState('idle')
        expect(btnZh()).toBe('网页登录验证身份')
        expect(q('.dsu-card').textContent).toContain('未登录')
        expect(q('.dsu-logout').hidden).toBe(true)
        expect(q('.dsu-skiplogin').hidden).toBe(false)
        // 再点主按钮 = 重新网页登录(第 2 步的 action 是 confirm),且不放行
        q('.dsu-btn').click()
        expect(onAction).toHaveBeenLastCalledWith({ action: 'confirm', authenticated: false })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(actionShown()).toBe(true)
        // 登录成功才放行,进到后面的自动步骤
        h.setAuthenticated(true)
        await advanceUntil(() => !actionShown())
        expect(actions(onAction)).toEqual(['grant', 'logout', 'confirm'])
      })

      it('退出失败(宿主推 error):提示原因,「退出登录」重新可点,人还是已登录', async () => {
        const { handle: h, onAction } = await atConfirm()
        q('.dsu-logout').click()
        h.setLoginState('error', '退出登录失败，请重试')
        expect(hint()).toContain('退出登录失败，请重试')
        expect((q('.dsu-logout') as HTMLButtonElement).disabled).toBe(false)
        expect(btnZh()).toBe('确认身份')
        q('.dsu-logout').click()
        expect(actions(onAction)).toEqual(['grant', 'logout', 'logout'])
      })

      it('焦点在它上面按 Enter / 空格:不会被当成主按钮确认身份', async () => {
        const { onAction } = await atConfirm()
        const before = onAction.mock.calls.length
        q('.dsu-logout').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        expect(onAction.mock.calls.length).toBe(before)
        expect(actionShown()).toBe(true)
      })
    })
  })

  describe('第 1 步按钮文案随登录态变化', () => {
    it('游客:「网页登录授权」+ 说明无需输入密码', async () => {
      start({ config: { authenticated: false } })
      await toGrant()
      expect(q('.dsu-btn-zh').textContent).toBe('网页登录授权')
      expect(q('.dsu-btn-en').textContent).toBe('SIGN IN VIA WEB')
      expect(q('.dsu-hint').textContent).toContain('无需输入密码')
    })

    it.each([[null], [true]])('登录态 %s:沿用原版「授予访问权限」', async (auth) => {
      start({ config: { authenticated: auth } })
      await toGrant()
      expect(q('.dsu-btn-zh').textContent).toBe('授予访问权限')
      expect(q('.dsu-btn-en').textContent).toBe('GRANT ACCESS')
      expect(q('.dsu-hint').textContent).not.toContain('密码')
    })

    it('登录态回到「未知」(null)或传了奇怪的值:不当游客处理', async () => {
      const { handle: h } = start({ config: { authenticated: false } })
      await toGrant()
      expect(q('.dsu-btn-zh').textContent).toBe('网页登录授权')
      h.setAuthenticated(null as never)
      expect(q('.dsu-btn-zh').textContent).toBe('授予访问权限')
      h.setAuthenticated(false)
      h.setAuthenticated('false' as never)
      expect(q('.dsu-btn-zh').textContent).toBe('授予访问权限')
    })

    it('按钮已经亮着时登录态才水合出来:文案当场换', async () => {
      const { handle: h } = start()
      await toGrant()
      expect(q('.dsu-btn-zh').textContent).toBe('授予访问权限')
      h.setAuthenticated(false)
      expect(q('.dsu-btn-zh').textContent).toBe('网页登录授权')
      h.setAuthenticated(true)
      expect(q('.dsu-btn-zh').textContent).toBe('授予访问权限')
    })

    it('登录是在第 1 步放行之后完成的:第 2 步用的是已登录文案', async () => {
      // 游客点了第 1 步 → 登录成功才放行;放行后第 2 步按已登录处理
      const { handle: h } = start({ config: { authenticated: false } })
      await toGrant()
      q('.dsu-btn').click()
      h.setAuthenticated(true)
      await advanceUntil(() => !actionShown())
      await toGrant()
      expect(q('.dsu-btn-zh').textContent).toBe('确认身份')
      expect(q('.dsu-btn-zh').textContent).not.toBe('网页登录验证身份')
    })
  })

  describe('身份(setIdentity)', () => {
    it('中文名:欢迎语换成新名字,身份编号退回 OPERATOR', () => {
      const { handle: h } = start()
      h.setIdentity('张三')
      expect(q('.dsu-w4').textContent).toBe('欢迎 张三 访问')
      expect(q('.dsu-idline').textContent).toContain('OPERATOR')
    })

    it('英文名:身份编号取字母数字大写', () => {
      const { handle: h } = start()
      h.setIdentity('Ada Lovelace')
      expect(q('.dsu-idline').textContent).toContain('ADALOVELACE')
    })

    it('名字被清洗:控制字符折成空格、超长截到 48 字', () => {
      const { handle: h } = start()
      h.setIdentity('A\nB\tC')
      expect(q('.dsu-w4').textContent).toBe('欢迎 A B C 访问')
      h.setIdentity('长'.repeat(80))
      expect(q('.dsu-w4').textContent).toBe(`欢迎 ${'长'.repeat(48)} 访问`)
    })

    it('名字里的 HTML 只当文字,不会变成节点', () => {
      const { handle: h } = start()
      h.setIdentity('<img src=x onerror=alert(1)>')
      expect(root()!.querySelectorAll('img[src="x"]')).toHaveLength(0)
      expect(q('.dsu-w4').textContent).toContain('<img')
    })

    it('空名字退回默认「创作者」', () => {
      const { handle: h } = start()
      h.setIdentity('   ')
      expect(q('.dsu-w4').textContent).toBe('欢迎 创作者 访问')
    })

    it('身份卡正亮着时换人:卡片当场重画', async () => {
      const { handle: h } = start({ config: { identity: '旧名', authenticated: true } })
      await toGrant()
      await confirmCurrent()
      await toGrant()
      expect(q('.dsu-card').textContent).toContain('旧名')
      h.setIdentity('新名')
      expect(q('.dsu-card').textContent).toContain('新名')
      expect(q('.dsu-card').textContent).not.toContain('旧名')
    })
  })

  describe('跳过', () => {
    it('Esc:onFinish({skipped:true}),随后摘节点、onDone、解锁', async () => {
      const { onFinish, onDone } = start()
      await vi.advanceTimersByTimeAsync(500)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(onFinish).toHaveBeenCalledTimes(1)
      expect(onFinish).toHaveBeenCalledWith({ skipped: true })
      expect(root()!.classList.contains('dsu-gone')).toBe(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onDone).toHaveBeenCalledWith({ skipped: true })
      expect(root()).toBeNull()
      expect(document.documentElement.classList.contains('dsu-lock')).toBe(false)
    })

    it('点右上角「跳过」按钮', async () => {
      const { onFinish } = start()
      await vi.advanceTimersByTimeAsync(500)
      q('.dsu-skip').click()
      expect(onFinish).toHaveBeenCalledWith({ skipped: true })
    })

    it('黑幕阶段(按钮还没出现)也能跳', () => {
      const { onFinish } = start()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(onFinish).toHaveBeenCalledWith({ skipped: true })
    })

    it('allowSkip:false 时 Esc 无效,跳过按钮隐藏', async () => {
      const { onFinish } = start({ config: { allowSkip: false } })
      expect(q('.dsu-skip').hidden).toBe(true)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(onFinish).not.toHaveBeenCalled()
    })

    it('重复跳过 / 跳过后再 finish:onFinish 只一次', () => {
      const { handle: h, onFinish } = start()
      h.skip()
      h.skip()
      h.finish()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(onFinish).toHaveBeenCalledTimes(1)
    })

    it('跳过之后时间线里剩下的步骤不再动手(不会冒出新的确认按钮)', async () => {
      const { handle: h } = start()
      h.skip()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(actionShown()).toBe(false)
    })
  })

  describe('收尾与清理', () => {
    it('结束后不再监听 document 的键盘(Esc / 确认 / 音频解锁都摘掉)', async () => {
      const add = vi.spyOn(document, 'addEventListener')
      const remove = vi.spyOn(document, 'removeEventListener')
      const { handle: h } = start()
      await toGrant()
      h.skip()
      const added = add.mock.calls.map((c) => `${c[0]}`)
      const removed = remove.mock.calls.map((c) => `${c[0]}`)
      for (const type of new Set(added)) {
        expect(removed.filter((t) => t === type).length).toBeGreaterThanOrEqual(
          added.filter((t) => t === type).length
        )
      }
      add.mockRestore()
      remove.mockRestore()
    })

    it('dispose:不触发 onFinish / onDone,摘节点、解锁、清空全部定时器', async () => {
      const { handle: h, onFinish, onDone } = start()
      await toGrant()
      h.dispose()
      expect(root()).toBeNull()
      expect(document.documentElement.classList.contains('dsu-lock')).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onFinish).not.toHaveBeenCalled()
      expect(onDone).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('dispose 在动画进行中(看门狗正上着弦、不是在等点击):一个定时器都不留', async () => {
      const { handle: h } = start()
      await vi.advanceTimersByTimeAsync(300)
      expect(root()).not.toBeNull()
      expect(actionShown()).toBe(false)
      h.dispose()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('跳过之后(揭幕那 900ms 走完):时间线的等待、看门狗都清掉,不留定时器', async () => {
      const { handle: h, onDone } = start()
      await vi.advanceTimersByTimeAsync(300)
      h.skip()
      await vi.advanceTimersByTimeAsync(1000)
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('刚 finish 就被 dispose(揭幕的 900ms 里宿主要拆):onDone 不再回调,节点已摘', async () => {
      const { handle: h, onFinish, onDone } = start()
      h.finish()
      expect(onFinish).toHaveBeenCalledTimes(1)
      h.dispose()
      await vi.advanceTimersByTimeAsync(2000)
      expect(onDone).not.toHaveBeenCalled()
      expect(root()).toBeNull()
    })

    it('dispose 之后再 skip / setIdentity / setAuthenticated 都是安全空操作', () => {
      const { handle: h } = start()
      h.dispose()
      expect(() => {
        h.skip()
        h.setIdentity('x')
        h.setAuthenticated(false)
        h.finish()
      }).not.toThrow()
    })

    it('finish 结束后不再受 Esc 影响;isFinished 反映状态', () => {
      const { handle: h, onFinish } = start()
      expect(h.isFinished()).toBe(false)
      h.finish()
      expect(h.isFinished()).toBe(true)
      expect(onFinish).toHaveBeenCalledWith({ skipped: false })
    })

    it('宿主的 onFinish / onDone 抛错:不影响摘节点', async () => {
      start({
        onFinish: () => {
          throw new Error('x')
        },
        onDone: () => {
          throw new Error('y')
        }
      })
      handle!.finish()
      await vi.advanceTimersByTimeAsync(1000)
      expect(root()).toBeNull()
    })
  })

  describe('语音素材(缺了就静音,绝不卡住)', () => {
    const base = 'file:///app/audio/startup/'

    it('素材全部加载失败:时间线照走、不播任何声音、不抛', async () => {
      const made: ReturnType<typeof makeFakeAudio>[] = []
      const { onFinish } = start({
        assetBase: base,
        config: { requireInteraction: false },
        createAudio: () => {
          const a = makeFakeAudio({ fail: true })
          made.push(a)
          return a as unknown as StartupAudioLike
        }
      })
      await advanceUntil(() => onFinish.mock.calls.length > 0)
      expect(made.length).toBeGreaterThan(0)
      for (const a of made) expect(a.play).not.toHaveBeenCalled()
      expect(warn.mock.calls.some((c) => String(c[0]).includes('动画异常'))).toBe(false)
    })

    it('素材既不触发 loaded 也不触发 error(请求挂住):3 秒超时后当缺失处理', async () => {
      const hang = (): StartupAudioLike =>
        ({
          preload: '',
          volume: 1,
          duration: Number.NaN,
          readyState: 0,
          play: vi.fn(() => Promise.resolve()),
          pause: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        }) as unknown as StartupAudioLike
      const { onFinish } = start({
        assetBase: base,
        config: { requireInteraction: false },
        createAudio: hang
      })
      await advanceUntil(() => onFinish.mock.calls.length > 0)
      expect(onFinish).toHaveBeenCalledTimes(1)
      // 是加载超时自己放行的,不是撞上 15 秒看门狗才结束
      expect(warn.mock.calls.some((c) => String(c[0]).includes('停滞'))).toBe(false)
    })

    it('素材齐全:按 line-1…line-5 + line-6 取地址,逐步播放', async () => {
      const urls: string[] = []
      const made = new Map<string, ReturnType<typeof makeFakeAudio>>()
      const { onFinish } = start({
        assetBase: base,
        config: { requireInteraction: false },
        createAudio: (url) => {
          urls.push(url)
          const a = makeFakeAudio({ duration: 0.8 })
          made.set(url, a)
          return a as unknown as StartupAudioLike
        }
      })
      await advanceUntil(() => onFinish.mock.calls.length > 0)
      expect([...new Set(urls)].sort()).toEqual(
        ['line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6'].map((n) => `${base}${n}.mp3`)
      )
      for (const a of made.values()) expect(a.play).toHaveBeenCalledTimes(1)
    })

    it('assetBase 末尾没有斜杠也能拼对', async () => {
      const urls: string[] = []
      start({
        assetBase: 'file:///app/audio/startup',
        createAudio: (url) => {
          urls.push(url)
          return makeFakeAudio({ fail: true }) as unknown as StartupAudioLike
        }
      })
      expect(urls[0]).toBe('file:///app/audio/startup/line-1.mp3')
    })

    // 「念台词之前的两声轻提示」(1046.5 Hz + 1568 Hz)是给真声开口用的,素材缺了就不该单独响一下
    const CUE_HZ = 1046.5

    it('素材齐全:每句台词开口前有提示音(对照组,证明下面的「没响」不是假象)', async () => {
      const ac = installFakeAudioContext()
      try {
        const { onFinish } = start({
          assetBase: base,
          config: { requireInteraction: false },
          createAudio: () => makeFakeAudio({ duration: 0.5 }) as unknown as StartupAudioLike
        })
        await advanceUntil(() => onFinish.mock.calls.length > 0)
        expect(ac.freqs).toContain(CUE_HZ)
      } finally {
        ac.restore()
      }
    })

    it('素材全部缺失:界面合成音照响,但台词提示音一声都不出(没有声音跟着,不能单独「叮」一下)', async () => {
      const ac = installFakeAudioContext()
      try {
        const { onFinish } = start({
          assetBase: base,
          config: { requireInteraction: false },
          createAudio: () => makeFakeAudio({ fail: true }) as unknown as StartupAudioLike
        })
        await advanceUntil(() => onFinish.mock.calls.length > 0)
        // 界面音效还活着(否则「没有提示音」什么也说明不了)
        expect(ac.freqs.length).toBeGreaterThan(0)
        expect(ac.freqs).not.toContain(CUE_HZ)
      } finally {
        ac.restore()
      }
    })

    it('开播当下就把六句素材都开始加载(终幕那句不等到最后一刻才去取)', async () => {
      const urls: string[] = []
      start({
        assetBase: base,
        createAudio: (url) => {
          urls.push(url)
          return makeFakeAudio({ duration: 0.5 }) as unknown as StartupAudioLike
        }
      })
      await vi.advanceTimersByTimeAsync(100)
      // 此刻还在黑场,远没到终幕
      expect(actionShown()).toBe(false)
      expect(urls).toContain(`${base}line-6.mp3`)
      expect(new Set(urls).size).toBe(6)
    })

    it('用户点了确认之后,这一句没念完就不进下一步(不掐断旁白)', async () => {
      const made = new Map<string, ReturnType<typeof makeFakeAudio>>()
      start({
        assetBase: base,
        config: { authenticated: true },
        createAudio: (url) => {
          const a = makeFakeAudio({ duration: 8 })
          made.set(url, a)
          return a as unknown as StartupAudioLike
        }
      })
      await toGrant()
      const line1 = made.get(`${base}line-1.mp3`)!
      const line2 = made.get(`${base}line-2.mp3`)!
      expect(line1.play).toHaveBeenCalledTimes(1)
      await confirmCurrent()
      // 点得快也要等第 1 句念完(8 秒)
      await vi.advanceTimersByTimeAsync(1500)
      expect(line2.play).not.toHaveBeenCalled()
      // 念完之后第 2 步才开口
      await advanceUntil(() => line2.play.mock.calls.length > 0, 40_000)
      expect(line2.play).toHaveBeenCalledTimes(1)
    })

    it('自动播放被浏览器拒绝(play() reject):当作静音,不卡住', async () => {
      const { onFinish } = start({
        assetBase: base,
        config: { requireInteraction: false },
        createAudio: () => makeFakeAudio({ rejectPlay: true }) as unknown as StartupAudioLike
      })
      await advanceUntil(() => onFinish.mock.calls.length > 0)
      expect(onFinish).toHaveBeenCalledTimes(1)
    })

    it('音频设备卡死(永不 ended):看门狗 15 秒后强制揭幕,宁可截断也不关住人', async () => {
      const { onFinish } = start({
        assetBase: base,
        config: { requireInteraction: false },
        createAudio: () => makeFakeAudio({ duration: 600, neverEnds: true }) as unknown as StartupAudioLike
      })
      await advanceUntil(() => onFinish.mock.calls.length > 0)
      expect(onFinish).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('停滞'))).toBe(true)
    })

    it('跳过时正在播的语音被停掉', async () => {
      const made: ReturnType<typeof makeFakeAudio>[] = []
      const { handle: h } = start({
        assetBase: base,
        config: { requireInteraction: false },
        createAudio: () => {
          const a = makeFakeAudio({ duration: 30, neverEnds: true })
          made.push(a)
          return a as unknown as StartupAudioLike
        }
      })
      await advanceUntil(() => made.some((a) => a.play.mock.calls.length > 0))
      h.skip()
      expect(made.some((a) => a.pause.mock.calls.length > 0)).toBe(true)
    })

    it('voice:false 时一个素材都不加载', () => {
      const createAudio = vi.fn(() => makeFakeAudio() as unknown as StartupAudioLike)
      start({ assetBase: base, config: { voice: false }, createAudio })
      expect(createAudio).not.toHaveBeenCalled()
    })

    it('不开 ttsFallback:缺素材时不会去调浏览器 speechSynthesis(没有合成腔)', async () => {
      const speak = vi.fn()
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: { speak, cancel: vi.fn(), resume: vi.fn(), getVoices: () => [], addEventListener: vi.fn() }
      })
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        configurable: true,
        value: function () {
          /* 假的 */
        }
      })
      try {
        const { onFinish } = start({
          assetBase: base,
          config: { requireInteraction: false },
          createAudio: () => makeFakeAudio({ fail: true }) as unknown as StartupAudioLike
        })
        await advanceUntil(() => onFinish.mock.calls.length > 0)
        expect(speak).not.toHaveBeenCalled()
      } finally {
        delete (window as { speechSynthesis?: unknown }).speechSynthesis
        delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
      }
    })
  })

  describe('配置兜底', () => {
    it('speed 越界被夹到 [0.35, 3]:极快的 speed 不会让时间线卡死', async () => {
      const { onFinish } = start({ config: { speed: 999, requireInteraction: false } })
      await advanceUntil(() => onFinish.mock.calls.length > 0, 60_000)
      expect(onFinish).toHaveBeenCalledTimes(1)
    })

    it('config 里的 null / undefined 不覆盖默认值', () => {
      start({ config: { identity: undefined, accent: undefined } as never })
      expect(q('.dsu-w4').textContent).toBe('欢迎 创作者 访问')
    })

    it('不传任何 options 也能起(全部走默认)', () => {
      handle = createStartupScreen(undefined as never)
      expect(root()).not.toBeNull()
    })
  })
})
