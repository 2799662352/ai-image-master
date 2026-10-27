import { afterEach, describe, expect, it, vi } from 'vitest'
import { initTabStripScroll, type TabStripScroll } from '../tabStripScroll'

// jsdom 没有布局:可视宽 400、内容宽 1000,最大滚动 600;滑块宽 400*400/1000=160,可移动 240。
const VIEW = 400
const CONTENT = 1000

function mountStrip(contentWidth = CONTENT) {
  document.body.innerHTML = `
    <div class="tab-strip">
      <div class="tab-strip-scroller">
        <button class="tab-btn" data-tab="generate"></button>
        <button class="tab-btn" data-tab="batch"></button>
        <button class="tab-btn" data-tab="agentWorkspace"></button>
      </div>
    </div>`
  const strip = document.querySelector<HTMLElement>('.tab-strip')!
  const scroller = strip.querySelector<HTMLElement>('.tab-strip-scroller')!
  let scrollLeft = 0
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, get: () => VIEW },
    scrollWidth: { configurable: true, get: () => contentWidth },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.min(Math.max(value, 0), Math.max(contentWidth - VIEW, 0))
      }
    }
  })
  const scrollTo = vi.fn()
  const scrollBy = vi.fn()
  Object.assign(scroller, { scrollTo, scrollBy })
  return { strip, scroller, scrollTo, scrollBy }
}

const rect = (left: number, right: number) =>
  ({ left, right, top: 0, bottom: 0, x: left, y: 0, width: right - left, height: 0, toJSON: () => ({}) }) as DOMRect

const wheel = (init: WheelEventInit) => new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })

const pointer = (type: string, clientX: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX })

describe('initTabStripScroll', () => {
  let scroll: TabStripScroll | null = null

  const start = (strip: HTMLElement): TabStripScroll => {
    const instance = initTabStripScroll(strip)
    if (!instance) throw new Error('.tab-strip-scroller missing')
    scroll = instance
    return instance
  }

  afterEach(() => {
    scroll?.destroy()
    scroll = null
    document.body.innerHTML = ''
  })

  it('标签放得下时不进入可滚动状态', () => {
    const { strip } = mountStrip(VIEW)
    start(strip)

    expect(strip.classList.contains('is-overflowing')).toBe(false)
  })

  it('放不下时滑块宽度按可视比例,位置跟随滚动', () => {
    const { strip, scroller } = mountStrip()
    start(strip)
    const thumb = strip.querySelector<HTMLElement>('.tab-strip-thumb')!

    expect(strip.classList.contains('is-overflowing')).toBe(true)
    expect(thumb.style.width).toBe('160px')
    expect(thumb.style.transform).toBe('translateX(0px)')

    scroller.scrollLeft = 300
    scroller.dispatchEvent(new Event('scroll'))
    expect(thumb.style.transform).toBe('translateX(120px)')
  })

  it('滚轮的纵向滚动改成横向;滚到头的那一侧放给页面', () => {
    const { strip, scroller } = mountStrip()
    start(strip)

    const down = wheel({ deltaY: 100 })
    scroller.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(scroller.scrollLeft).toBe(100)

    scroller.scrollLeft = 0
    const upAtStart = wheel({ deltaY: -100 })
    scroller.dispatchEvent(upAtStart)
    expect(upAtStart.defaultPrevented).toBe(false)

    scroller.scrollLeft = 600
    const downAtEnd = wheel({ deltaY: 100 })
    scroller.dispatchEvent(downAtEnd)
    expect(downAtEnd.defaultPrevented).toBe(false)
    expect(scroller.scrollLeft).toBe(600)
  })

  it('横向手势、Ctrl+滚轮、标签放得下时都不拦截', () => {
    const { strip, scroller } = mountStrip()
    start(strip)

    const horizontal = wheel({ deltaX: 80, deltaY: 10 })
    scroller.dispatchEvent(horizontal)
    const zoom = wheel({ deltaY: 100, ctrlKey: true })
    scroller.dispatchEvent(zoom)
    expect(horizontal.defaultPrevented).toBe(false)
    expect(zoom.defaultPrevented).toBe(false)
    expect(scroller.scrollLeft).toBe(0)

    scroll?.destroy()
    const fitting = mountStrip(VIEW)
    start(fitting.strip)
    const noOverflow = wheel({ deltaY: 100 })
    fitting.scroller.dispatchEvent(noOverflow)
    expect(noOverflow.defaultPrevented).toBe(false)
  })

  it('拖动滑块按比例滚动,松手后不再跟随', () => {
    const { strip, scroller } = mountStrip()
    start(strip)
    const thumb = strip.querySelector<HTMLElement>('.tab-strip-thumb')!
    Object.assign(thumb, { setPointerCapture: vi.fn() })

    thumb.dispatchEvent(pointer('pointerdown', 100))
    expect(strip.classList.contains('is-dragging')).toBe(true)

    thumb.dispatchEvent(pointer('pointermove', 160))
    expect(scroller.scrollLeft).toBe(150)

    thumb.dispatchEvent(new Event('lostpointercapture'))
    expect(strip.classList.contains('is-dragging')).toBe(false)
    thumb.dispatchEvent(pointer('pointermove', 220))
    expect(scroller.scrollLeft).toBe(150)
  })

  it('点轨道空白处,滑块中心对准点击位置', () => {
    const { strip, scrollTo } = mountStrip()
    start(strip)
    const rail = strip.querySelector<HTMLElement>('.tab-strip-rail')!
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(rect(0, VIEW))

    rail.dispatchEvent(pointer('pointerdown', 300))

    expect(scrollTo).toHaveBeenCalledWith({ left: 550, behavior: 'smooth' })
  })

  it('切到可视区外的标签时把它滚进来,完整可见时不动', () => {
    const { strip, scroller, scrollBy } = mountStrip()
    const instance = start(strip)
    const button = (tab: string) => scroller.querySelector<HTMLElement>(`[data-tab="${tab}"]`)!
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, VIEW))
    vi.spyOn(button('generate'), 'getBoundingClientRect').mockReturnValue(rect(-80, -10))
    vi.spyOn(button('batch'), 'getBoundingClientRect').mockReturnValue(rect(100, 200))
    vi.spyOn(button('agentWorkspace'), 'getBoundingClientRect').mockReturnValue(rect(450, 520))

    instance.revealTab('batch')
    expect(scrollBy).not.toHaveBeenCalled()

    instance.revealTab('agentWorkspace')
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 144, behavior: 'smooth' })

    instance.revealTab('generate')
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -104, behavior: 'smooth' })
  })

  it('destroy 后移除轨道,滚轮不再拦截', () => {
    const { strip, scroller } = mountStrip()
    start(strip).destroy()
    scroll = null

    const after = wheel({ deltaY: 100 })
    scroller.dispatchEvent(after)

    expect(strip.querySelector('.tab-strip-rail')).toBeNull()
    expect(strip.classList.contains('is-overflowing')).toBe(false)
    expect(after.defaultPrevented).toBe(false)
  })
})
