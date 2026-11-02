import { describe, expect, it } from 'vitest'
import { computePopoverPlacement } from '../popoverPlacement'

// 坐标都是视口坐标。返回的 left 是「相对触发按钮外壳」的偏移(弹层 absolute 定位在外壳里)。
describe('computePopoverPlacement', () => {
  it('容器够宽时:弹层左边贴着触发按钮,宽度取上限', () => {
    // 容器 100~900(宽 800),按钮在 400,弹层上限 540 → 400~940 会越过容器右边 900,
    // 所以往左挪到右边贴齐:360~900。
    expect(computePopoverPlacement({ boundsLeft: 100, boundsWidth: 800, anchorLeft: 400 })).toEqual({
      left: -40,
      width: 540,
    })
    // 按钮在 150 时放得下,左边就贴着按钮。
    expect(computePopoverPlacement({ boundsLeft: 100, boundsWidth: 800, anchorLeft: 150 })).toEqual({
      left: 0,
      width: 540,
    })
  })

  it('容器比上限窄时:宽度跟着容器,左边贴齐容器(不会冲出右边)', () => {
    // 这就是「窗口缩小后右栏 / 按钮被挡住」的场景:容器 120~520(宽 400),按钮在 430。
    const p = computePopoverPlacement({ boundsLeft: 120, boundsWidth: 400, anchorLeft: 430 })
    expect(p).toEqual({ left: 120 - 430, width: 400 })
    // 弹层实际落在 120~520,正好是容器的范围。
    expect(430 + (p?.left ?? 0)).toBe(120)
    expect(430 + (p?.left ?? 0) + (p?.width ?? 0)).toBe(520)
  })

  it('弹层永远不会越过容器左右边界', () => {
    for (const boundsWidth of [260, 320, 440, 540, 700, 1200]) {
      for (const anchorLeft of [0, 90, 300, 480, 900, 1500]) {
        const boundsLeft = 50
        const p = computePopoverPlacement({ boundsLeft, boundsWidth, anchorLeft })
        expect(p).not.toBeNull()
        const left = anchorLeft + (p?.left ?? 0)
        const right = left + (p?.width ?? 0)
        expect(left).toBeGreaterThanOrEqual(boundsLeft)
        expect(right).toBeLessThanOrEqual(boundsLeft + boundsWidth)
      }
    }
  })

  it('没有布局(宽度为 0,例如 jsdom / 容器被隐藏)时不给结果,交回 CSS 默认', () => {
    expect(computePopoverPlacement({ boundsLeft: 0, boundsWidth: 0, anchorLeft: 0 })).toBeNull()
    expect(computePopoverPlacement({ boundsLeft: 10, boundsWidth: -5, anchorLeft: 3 })).toBeNull()
  })

  it('maxWidth 可调', () => {
    expect(computePopoverPlacement({ boundsLeft: 0, boundsWidth: 1000, anchorLeft: 0, maxWidth: 300 })).toEqual({
      left: 0,
      width: 300,
    })
  })
})
