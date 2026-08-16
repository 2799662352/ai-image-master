import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DiffBody } from '../DiffBody'

/**
 * jsdom 里所有元素的 scrollHeight / clientHeight 恒为 0,滚动逻辑没法自然触发。
 * 这里给它们装上可写的实现,让「内容比容器高」成立。
 */
const CLIENT_HEIGHT = 320
let scrollHeight = 0

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => CLIENT_HEIGHT,
  })
})

afterEach(cleanup)

function scroller(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-diff-scroll]')
  if (!(el instanceof HTMLElement)) throw new Error('no scroll container')
  return el
}

function lines(n: number, prefix = '+'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}line ${i}`).join('\n')
}

describe('DiffBody 跟随尾部', () => {
  it('followTail 打开时,内容增长后滚到底', () => {
    scrollHeight = 1000
    const { container, rerender } = render(<DiffBody diff={lines(5)} followTail />)

    scrollHeight = 2000
    rerender(<DiffBody diff={lines(10)} followTail />)

    expect(scroller(container).scrollTop).toBe(2000)
  })

  it('followTail 关闭时不动用户的滚动位置', () => {
    scrollHeight = 1000
    const { container, rerender } = render(<DiffBody diff={lines(5)} />)
    scroller(container).scrollTop = 42

    scrollHeight = 2000
    rerender(<DiffBody diff={lines(10)} />)

    expect(scroller(container).scrollTop).toBe(42)
  })

  it('用户往回翻之后就不再抢滚动条', () => {
    scrollHeight = 1000
    const { container, rerender } = render(<DiffBody diff={lines(5)} followTail />)

    const el = scroller(container)
    // 离底部很远 = 用户主动往上翻了。
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))

    scrollHeight = 2000
    rerender(<DiffBody diff={lines(10)} followTail />)

    expect(el.scrollTop).toBe(0)
  })

  /**
   * 截断方向要跟着看的方向走。收起态看的是「这次改了什么」,从头截合理;
   * 流式态看的是「现在正在写哪一行」,从头截等于永远停在开头,后面写的一个
   * 字都看不到。
   */
  it('流式截断保留尾部而不是开头', () => {
    scrollHeight = 9000
    const { container } = render(<DiffBody diff={lines(300)} followTail />)

    const rows = container.querySelectorAll('[data-diff-row]')
    expect(rows).toHaveLength(200)
    expect(rows[rows.length - 1].textContent).toContain('line 299')
  })

  it('非流式截断仍然保留开头', () => {
    scrollHeight = 9000
    const { container } = render(<DiffBody diff={lines(300)} />)

    const rows = container.querySelectorAll('[data-diff-row]')
    expect(rows).toHaveLength(200)
    expect(rows[0].textContent).toContain('line 0')
  })
})
