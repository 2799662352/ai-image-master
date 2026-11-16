// 剧栏左列:固定高度 = 视口底边 − 本列【文档坐标】顶边(与滚动无关)。
// 实机量过的背景:窗口 861px 高、剧栏顶边在 y≈284 —— 高度不能写死成 calc(100vh - 常数)。
// 用户反馈「剧栏随着滚动伸缩,晃眼睛」→ 滚动时高度不许变、也不许为滚动做任何计算。

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RAIL_BOTTOM_GAP,
  RAIL_MIN_HEIGHT,
  RAIL_TOP_GAP,
  RailColumn,
  railHeight,
} from '../RailColumn'

describe('railHeight', () => {
  it('占满「剧栏顶边(文档坐标)→ 视口底边」,留底边空隙', () => {
    expect(railHeight(285, 861)).toBe(861 - 285 - RAIL_BOTTOM_GAP)
  })

  it('顶边落在粘住间隙以内(隐藏的 tab 量出来是 0)时按间隙算,不会比粘住时更高', () => {
    const cap = 861 - RAIL_TOP_GAP - RAIL_BOTTOM_GAP
    expect(railHeight(0, 861)).toBe(cap)
    expect(railHeight(-50, 861)).toBe(cap)
    expect(railHeight(RAIL_TOP_GAP, 861)).toBe(cap)
  })

  it('小数顶边向下取整,不让剧栏比视口多出半个像素', () => {
    expect(railHeight(285.6, 861)).toBe(563)
  })

  it('窗口很矮:保底高度,不把剧栏压成一条', () => {
    expect(railHeight(285, 500)).toBe(RAIL_MIN_HEIGHT)
  })
})

describe('<RailColumn />', () => {
  /** 本列在【文档】里的顶边;视口里的 top = docTop − scrollY(和真实浏览器一致)。 */
  let docTop = 285
  let scrollY = 0
  let writes = 0
  let restoreHeight: () => void
  let queued: Array<[number, FrameRequestCallback]> = []
  let nextId = 1
  const cancelled: number[] = []
  const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect')

  const heightOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.vw-rail-sticky')!.style.height
  /** 事件 → 过一帧:触发 resize 之后把排队的 rAF 回调跑掉。 */
  const frame = () => {
    const run = queued
    queued = []
    act(() => run.forEach(([, cb]) => cb(0)))
  }
  const fire = (type: 'scroll' | 'resize') => {
    act(() => void window.dispatchEvent(new Event(type)))
    frame()
  }
  /** 把页面滚到 y:scrollY 变、视口里的顶边跟着变,文档坐标不变。 */
  const scrollTo = (y: number) => {
    scrollY = y
    fire('scroll')
  }

  beforeEach(() => {
    docTop = 285
    scrollY = 0
    writes = 0
    Object.defineProperty(window, 'innerHeight', { value: 861, configurable: true, writable: true })
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
    // rAF 排队、由测试手动「过一帧」:和浏览器一样回调是异步的(同步执行会让 "frame = rAF(...)" 的赋值晚于回调,
    // 把「已排队」标记永久卡死,后面的重算全被吞掉,测试反而假绿)。
    queued = []
    nextId = 1
    cancelled.length = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++
      queued.push([id, cb])
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelled.push(id)
      queued = queued.filter(([qid]) => qid !== id)
    })
    rectSpy.mockImplementation(function (this: Element) {
      const top = this.classList.contains('vw-rail-col') ? docTop - scrollY : 0
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    // 数「height 被写了几次」:数值没变就不该写样式(否则每次重算都触发布局)
    const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'height')!
    Object.defineProperty(CSSStyleDeclaration.prototype, 'height', {
      configurable: true,
      get: desc.get,
      set(v: string) {
        writes += 1
        desc.set!.call(this, v)
      },
    })
    restoreHeight = () => Object.defineProperty(CSSStyleDeclaration.prototype, 'height', desc)
  })

  afterEach(() => {
    cleanup()
    restoreHeight()
    rectSpy.mockReset()
    vi.unstubAllGlobals()
    delete (window as unknown as { scrollY?: number }).scrollY
  })

  it('挂载就量一次:高度 = 视口底边 − 本列顶边 − 底部间隙', () => {
    const { container } = render(
      <RailColumn>
        <aside aria-label="剧栏" />
      </RailColumn>,
    )
    expect(heightOf(container)).toBe(`${861 - 285 - RAIL_BOTTOM_GAP}px`)
    // 外层列负责背景/分隔线,内层是 sticky 的那一块,剧栏在最里面
    expect(container.querySelector('.vw-rail-col > .vw-rail-sticky > aside[aria-label="剧栏"]')).not.toBeNull()
  })

  it('滚动:高度始终不变(第一版会一路变高),也不重新量、不写样式、不排 rAF', () => {
    const { container } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    const fixed = `${861 - 285 - RAIL_BOTTOM_GAP}px`
    expect(heightOf(container)).toBe(fixed)
    const measured = rectSpy.mock.calls.length
    const settled = writes
    for (const y of [40, 100, 272, 273, 600, 2400]) {
      act(() => {
        scrollY = y
        window.dispatchEvent(new Event('scroll'))
      })
      // 滚动事件本身不排任何帧
      expect(queued).toHaveLength(0)
      frame()
      expect(heightOf(container)).toBe(fixed)
    }
    expect(rectSpy.mock.calls.length).toBe(measured)
    expect(writes).toBe(settled)
  })

  it('已经滚下去之后才触发重算(改窗口大小):仍按文档坐标算,不会因为视口里的顶边是负数就变样', () => {
    const { container } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    scrollTo(900) // 视口里本列顶边 = 285 − 900 = −615
    window.innerHeight = 1000
    fire('resize')
    expect(heightOf(container)).toBe(`${1000 - 285 - RAIL_BOTTOM_GAP}px`)
  })

  it('改窗口大小:按新的视口高度重算;同一数值不重复写样式', () => {
    const { container } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    window.innerHeight = 1100
    fire('resize')
    expect(heightOf(container)).toBe(`${1100 - 285 - RAIL_BOTTOM_GAP}px`)
    const settled = writes
    fire('resize')
    fire('resize')
    expect(writes).toBe(settled)
  })

  it('同一帧里连发多次 resize:只排一个 rAF、只量一次', () => {
    render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    const before = rectSpy.mock.calls.length
    act(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('resize'))
    })
    expect(queued).toHaveLength(1)
    frame()
    expect(rectSpy.mock.calls.length).toBe(before + 1)
  })

  describe('没有 resize 事件的变化:靠尺寸观察补量', () => {
    let callback: () => void = () => {}
    let observed: Element[] = []
    let disconnected = false
    // 只有真的 observe 过目标,尺寸变化才会通知(和浏览器一致;不 observe 就永远收不到)
    const notify = (match: (el: Element) => boolean) => {
      if (observed.some(match)) callback()
    }
    beforeEach(() => {
      callback = () => {}
      observed = []
      disconnected = false
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            callback = cb
          }
          observe(el: Element) {
            observed.push(el)
          }
          disconnect() {
            disconnected = true
          }
        },
      )
    })

    it('从别的 tab 切回来(display:none → 显示):本列尺寸变化 → 补量', () => {
      docTop = 0 // 隐藏时盒子全是 0
      const { container, unmount } = render(
        <RailColumn>
          <div />
        </RailColumn>,
      )
      docTop = 284 // 切回来后真实顶边
      act(() => notify((el) => el.classList.contains('vw-rail-col')))
      frame()
      expect(heightOf(container)).toBe(`${861 - 284 - RAIL_BOTTOM_GAP}px`)
      unmount()
      expect(disconnected).toBe(true)
    })

    it('页面顶部长高(本列尺寸没变、整个页面变了):补量,剧栏底边不会掉出视口', () => {
      const { container } = render(
        <RailColumn>
          <div />
        </RailColumn>,
      )
      expect(heightOf(container)).toBe(`${861 - 285 - RAIL_BOTTOM_GAP}px`)
      docTop = 330 // 顶栏换行,本列整体下移 45px
      act(() => notify((el) => el === document.body))
      frame()
      expect(heightOf(container)).toBe(`${861 - 330 - RAIL_BOTTOM_GAP}px`)
    })
  })

  it('卸载时还有排队的帧:取消它,不在卸载后去量已摘掉的节点', () => {
    const { unmount } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    act(() => void window.dispatchEvent(new Event('resize')))
    const [[pendingId]] = queued
    unmount()
    expect(cancelled).toContain(pendingId)
    expect(queued).toHaveLength(0)
  })

  it('卸载后摘掉 resize 监听;且从头到尾没有挂过 scroll 监听', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    unmount()
    expect(add.mock.calls.map((c) => c[0])).not.toContain('scroll')
    expect(remove.mock.calls.map((c) => c[0])).toContain('resize')
    add.mockRestore()
    remove.mockRestore()
  })
})
