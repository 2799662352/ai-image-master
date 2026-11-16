// 剧栏左列:高度 = 整个视口 − 上下各 12px(保底 360px),只由窗口高度决定,纯 CSS。
//
// 演进(详见 RailColumn.tsx 头注释):#447 按「视口底边 − 本列当前顶边」算 → 滚动时一路变高(晃眼睛);
// #451 改按「文档坐标顶边」算 → 滚动时恒定,但粘住后下方空出 ~285px(1/3 屏),用户说「太短了」;
// 现在取整个视口,不再依赖本列在页面里的位置,所以也不再需要任何 JS 测量。
//
// jsdom 没有布局,量不出真实高度 —— 真实高度 / 底部入口位置在真 Electron 窗口里量过(PR 描述有读数)。
// 这里守的是「决定高度的那几条 CSS 声明」和「组件没有偷偷加回 JS 测量」,这两类回退肉眼看不出来:
//  - 本列少了 min-height:右侧内容短时,剧栏溢出本列,被页面根的 overflow-clip 裁掉、底部够不着;
//  - 底部入口少了 sticky:剧栏比「视口 − 顶栏占的 ~285px」更高,页面在最顶上时入口在视口之外。

import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RailColumn } from '../RailColumn'

const css = readFileSync(path.resolve(__dirname, '../workbench.css'), 'utf8')

/** 取某个选择器【整条规则】的声明块(workbench.css 里这几条都是单行 / 无嵌套)。 */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (!match) throw new Error(`workbench.css 里找不到规则 ${selector}`)
  return match[1].replace(/\s+/g, ' ').trim()
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('<RailColumn />', () => {
  it('外层列负责背景/分隔线,内层是 sticky 的那一块,剧栏在最里面', () => {
    const { container } = render(
      <RailColumn>
        <aside aria-label="剧栏" />
      </RailColumn>,
    )
    expect(container.querySelector('.vw-rail-col > .vw-rail-sticky > aside[aria-label="剧栏"]')).not.toBeNull()
  })

  it('没有 JS 测量:不写内联高度,不监听 scroll / resize,不建 ResizeObserver,不排 rAF', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    let observers = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          observers += 1
        }
        observe() {}
        disconnect() {}
      },
    )
    const { container } = render(
      <RailColumn>
        <div />
      </RailColumn>,
    )
    const sticky = container.querySelector<HTMLElement>('.vw-rail-sticky')!
    const col = container.querySelector<HTMLElement>('.vw-rail-col')!
    // 高度全由 CSS 变量给;内联样式里不该出现 height / min-height
    expect(sticky.getAttribute('style') ?? '').not.toMatch(/height/)
    expect(col.getAttribute('style') ?? '').not.toMatch(/height/)
    expect(add.mock.calls.map((c) => c[0])).not.toContain('scroll')
    expect(add.mock.calls.map((c) => c[0])).not.toContain('resize')
    expect(observers).toBe(0)
    expect(raf).not.toHaveBeenCalled()
  })
})

describe('剧栏高度的 CSS 声明(workbench.css)', () => {
  it('高度变量 = 整个视口 − 上下各 12px,保底 360px', () => {
    expect(declarations('.vw-rail-col')).toContain('--vw-rail-h: max(360px, calc(100vh - 24px))')
  })

  it('内层 sticky:粘在视口顶边 12px,高度取该变量;不能带 overflow(会让 sticky 失效)', () => {
    const d = declarations('.vw-rail-sticky')
    expect(d).toContain('position: sticky')
    expect(d).toContain('top: 12px')
    expect(d).toContain('height: var(--vw-rail-h)')
    expect(d).not.toMatch(/overflow/)
  })

  it('本列 min-height 取同一个变量:右侧内容短时本列也装得下剧栏,不被 overflow-clip 裁掉', () => {
    const d = declarations('.vw-rail-col')
    expect(d).toContain('min-height: var(--vw-rail-h)')
    expect(d).toContain('align-self: stretch')
  })

  it('上下间隙对得上:变量里减去的 24px = sticky 顶边 12px + 底部入口 sticky 底边 12px', () => {
    const top = Number(/top:\s*(\d+)px/.exec(declarations('.vw-rail-sticky'))![1])
    const bottom = Number(/bottom:\s*(\d+)px/.exec(declarations('.vw-rail-foot'))![1])
    const total = Number(/calc\(100vh - (\d+)px\)/.exec(declarations('.vw-rail-col'))![1])
    expect(top + bottom).toBe(total)
  })

  it('底部入口 sticky 贴视口底边:剧栏粘住之前(页面在最顶上)入口也在屏幕里,且有不透明底色盖住下面的列表', () => {
    const d = declarations('.vw-rail-foot')
    expect(d).toContain('position: sticky')
    expect(d).toMatch(/bottom:\s*12px/)
    expect(d).toMatch(/background:\s*#[0-9a-f]{3,8}/i)
    expect(d).toMatch(/z-index:\s*\d+/)
  })
})
