import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, useRef } from 'react'
import {
  TOOLBAR_COMPACT_THRESHOLDS,
  toolbarCompactFlags,
  useToolbarCompact,
} from '../toolbarCompact'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cleanup()
})

describe('toolbarCompactFlags(宽度 → 收纳级别)', () => {
  it('宽度充足时什么都不收', () => {
    expect(toolbarCompactFlags(900)).toEqual({ c1: false, c2: false, wrap: false })
    expect(toolbarCompactFlags(TOOLBAR_COMPACT_THRESHOLDS.c1 + 1)).toEqual({ c1: false, c2: false, wrap: false })
  })

  it('级别逐级累加:先 c1(徽标 / 待机语音字样),再 c2(协作模式文字),最后 wrap(换行)', () => {
    expect(toolbarCompactFlags(TOOLBAR_COMPACT_THRESHOLDS.c1)).toEqual({ c1: true, c2: false, wrap: false })
    expect(toolbarCompactFlags(TOOLBAR_COMPACT_THRESHOLDS.c2)).toEqual({ c1: true, c2: true, wrap: false })
    expect(toolbarCompactFlags(TOOLBAR_COMPACT_THRESHOLDS.wrap)).toEqual({ c1: true, c2: true, wrap: true })
    expect(toolbarCompactFlags(300)).toEqual({ c1: true, c2: true, wrap: true })
  })

  it('阈值顺序合理:越窄收得越多', () => {
    expect(TOOLBAR_COMPACT_THRESHOLDS.c1).toBeGreaterThan(TOOLBAR_COMPACT_THRESHOLDS.c2)
    expect(TOOLBAR_COMPACT_THRESHOLDS.c2).toBeGreaterThan(TOOLBAR_COMPACT_THRESHOLDS.wrap)
  })

  it('宽度未知(0 / NaN / 负数,如 jsdom 或被隐藏)一律不收纳,行为与旧版一致', () => {
    for (const w of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toolbarCompactFlags(w)).toEqual({ c1: false, c2: false, wrap: false })
    }
  })
})

describe('useToolbarCompact(监听行宽)', () => {
  function Probe({ onFlags }: { onFlags: (f: ReturnType<typeof useToolbarCompact>) => void }) {
    const ref = useRef<HTMLDivElement>(null)
    onFlags(useToolbarCompact(ref))
    return createElement('div', { ref, 'data-testid': 'row' })
  }

  it('首次按当前宽度给出级别,ResizeObserver 触发后随宽度更新', () => {
    let width = 440
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width, height: 20, left: 0, top: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    let notify: () => void = () => {}
    const disconnect = vi.fn()
    class FakeRO {
      constructor(cb: () => void) {
        notify = cb
      }
      observe() {}
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', FakeRO)

    const seen: Array<ReturnType<typeof useToolbarCompact>> = []
    const { unmount } = render(createElement(Probe, { onFlags: (f) => seen.push(f) }))
    expect(seen.at(-1)).toEqual({ c1: true, c2: true, wrap: true })

    width = 560
    act(() => notify())
    expect(seen.at(-1)).toEqual({ c1: true, c2: false, wrap: false })

    width = 800
    act(() => notify())
    expect(seen.at(-1)).toEqual({ c1: false, c2: false, wrap: false })

    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('级别没变就不重复渲染(拖动窗口边缘时不会每个像素都重绘工具条)', () => {
    let width = 700
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width, height: 20, left: 0, top: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    let notify: () => void = () => {}
    class FakeRO {
      constructor(cb: () => void) {
        notify = cb
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO)

    let renders = 0
    render(createElement(Probe, { onFlags: () => void (renders += 1) }))
    const before = renders
    for (const w of [690, 680, 670, 900]) {
      width = w
      act(() => notify())
    }
    expect(renders).toBe(before)
  })

  it('没有 ResizeObserver 的环境(jsdom)不报错、不收纳', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const seen: Array<ReturnType<typeof useToolbarCompact>> = []
    render(createElement(Probe, { onFlags: (f) => seen.push(f) }))
    expect(seen.at(-1)).toEqual({ c1: false, c2: false, wrap: false })
  })
})
