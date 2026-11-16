// 剧栏左列:高度 = 视口底边 − 本列当前顶边(滚动时随顶边上移变高,粘住后恒定)。
// 实机量过的背景:窗口 861px 高、剧栏顶边在 y≈284 —— 高度不能写死成 calc(100vh - 常数)。

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RAIL_BOTTOM_GAP,
  RAIL_MIN_HEIGHT,
  RAIL_TOP_GAP,
  RailColumn,
  railFitHeight,
} from '../RailColumn'

describe('railFitHeight', () => {
  it('页面还没滚走:占满「剧栏顶边 → 视口底边」(留底边空隙)', () => {
    expect(railFitHeight(285, 861)).toBe(861 - 285 - RAIL_BOTTOM_GAP)
  })

  it('滚过之后顶边是负数,剧栏已粘在顶部间隙:高度 = 视口 − 上下间隙,恒定', () => {
    const stuck = 861 - RAIL_TOP_GAP - RAIL_BOTTOM_GAP
    expect(railFitHeight(-1, 861)).toBe(stuck)
    expect(railFitHeight(-4000, 861)).toBe(stuck)
    // 顶边正好落在间隙以内也按粘住算,不会比粘住时更高
    expect(railFitHeight(0, 861)).toBe(stuck)
    expect(railFitHeight(RAIL_TOP_GAP, 861)).toBe(stuck)
  })

  it('小数顶边向下取整,不让剧栏比视口多出半个像素', () => {
    expect(railFitHeight(285.6, 861)).toBe(563)
  })

  it('窗口很矮:保底高度,不把剧栏压成一条', () => {
    expect(railFitHeight(285, 500)).toBe(RAIL_MIN_HEIGHT)
  })
})

describe('<RailColumn />', () => {
  let colTop = 285
  let writes = 0
  let restoreHeight: () => void
  let queued: Array<[number, FrameRequestCallback]> = []
  let nextId = 1
  const cancelled: number[] = []
  const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect')

  const heightOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.vw-rail-sticky')!.style.height
  /** 事件 → 过一帧:触发 scroll / resize 之后把排队的 rAF 回调跑掉。 */
  const frame = () => {
    const run = queued
    queued = []
    act(() => run.forEach(([, cb]) => cb(0)))
  }
  const fire = (type: 'scroll' | 'resize') => {
    act(() => void window.dispatchEvent(new Event(type)))
    frame()
  }

  beforeEach(() => {
    colTop = 285
    writes = 0
    Object.defineProperty(window, 'innerHeight', { value: 861, configurable: true, writable: true })
    // rAF 排队、由测试手动「过一帧」:和浏览器一样回调是异步的(同步执行会让 "frame = rAF(...)" 的赋值晚于回调,
    // 把「已排队」标记永久卡死,后面的滚动全被吞掉,测试反而假绿)。
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
      const top = this.classList.contains('vw-rail-col') ? colTop : 0
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    // 数「height 被写了几次」:粘住之后滚动期间不该再写样式(否则每帧都触发布局)
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

  it('滚动:顶边上移 → 剧栏变高;滚过之后停在 视口 − 上下间隙', () => {
    const { container } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    colTop = 100
    fire('scroll')
    expect(heightOf(container)).toBe(`${861 - 100 - RAIL_BOTTOM_GAP}px`)
    colTop = -420
    fire('scroll')
    expect(heightOf(container)).toBe(`${861 - RAIL_TOP_GAP - RAIL_BOTTOM_GAP}px`)
  })

  it('粘住之后继续滚:数值没变就不写样式', () => {
    const { container } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    colTop = -500
    fire('scroll')
    const settled = writes
    const measured = rectSpy.mock.calls.length
    for (const top of [-600, -900, -1500, -2400]) {
      colTop = top
      fire('scroll')
    }
    // 每一帧都量了(不是事件根本没送到),只是数值没变所以没写
    expect(rectSpy.mock.calls.length).toBe(measured + 4)
    expect(writes).toBe(settled)
    expect(heightOf(container)).toBe(`${861 - RAIL_TOP_GAP - RAIL_BOTTOM_GAP}px`)
  })

  it('改窗口大小:按新的视口高度重算', () => {
    const { container } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    window.innerHeight = 1100
    fire('resize')
    expect(heightOf(container)).toBe(`${1100 - 285 - RAIL_BOTTOM_GAP}px`)
  })

  it('从别的 tab 切回来(display:none → 显示,没有 scroll / resize):靠本列尺寸变化补量', () => {
    let callback: () => void = () => {}
    const observed: Element[] = []
    let disconnected = false
    // 只有真的 observe 过本列,尺寸变化才会通知(和浏览器一致;不 observe 就永远收不到)
    const notify = () => {
      if (observed.some((el) => el.classList.contains('vw-rail-col'))) callback()
    }
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
    colTop = 0 // 隐藏时盒子全是 0
    const { container, unmount } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    colTop = 284 // 切回来后真实顶边
    act(() => notify())
    frame()
    expect(observed).toHaveLength(1)
    expect(observed).toHaveLength(1)
    expect(heightOf(container)).toBe(`${861 - 284 - RAIL_BOTTOM_GAP}px`)
    unmount()
    expect(disconnected).toBe(true)
  })

  it('同一帧里连发多次 scroll:只排一个 rAF、只量一次', () => {
    render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    const before = rectSpy.mock.calls.length
    act(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('scroll'))
    })
    expect(queued).toHaveLength(1)
    frame()
    expect(rectSpy.mock.calls.length).toBe(before + 1)
  })

  it('卸载时还有排队的帧:取消它,不在卸载后去量已摘掉的节点', () => {
    const { unmount } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    act(() => void window.dispatchEvent(new Event('scroll')))
    const [[pendingId]] = queued
    unmount()
    expect(cancelled).toContain(pendingId)
    expect(queued).toHaveLength(0)
  })

  it('卸载后摘掉监听,不留悬空的 scroll / resize 处理器', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    unmount()
    const removed = remove.mock.calls.map((c) => c[0])
    expect(removed).toContain('scroll')
    expect(removed).toContain('resize')
    remove.mockRestore()
  })
})
