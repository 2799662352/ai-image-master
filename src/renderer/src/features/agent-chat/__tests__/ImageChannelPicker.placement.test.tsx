/**
 * 出图渠道弹层的左右位置:整块必须落在输入框(form)的左右边界之内。
 * 回归:窗口 / 聊天面板缩小后,弹层从触发按钮左边起往右铺 540 px,右半边冲出面板被裁掉,
 * 右栏的渠道和按钮都看不见(用户 2026-10-30 真机截图)。
 * jsdom 没有布局,所以这里 mock getBoundingClientRect 给出「form 在哪、按钮在哪」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImageChannelPicker } from '../ImageChannelPicker'
import { useAgentChatStore } from '../store'
import { DEFAULT_IMAGE_CHANNEL_ID } from '../imageChannels'
import { useImageChannelPrefsStore } from '../imageChannelPrefs'
import { channelTriggerBadge, placeImageChannels } from '../imageChannelPlacement'

const trigger = () => screen.getByRole('button', { name: /^出图渠道：/ })
const dialog = () => screen.getByRole('dialog', { name: '出图渠道' }) as HTMLElement

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, top: 0, bottom: 20, width, height: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect
}

/**
 * form 在 formLeft、宽 formWidth;触发按钮外壳(trigger 的父元素)在 anchorLeft。
 * 先取好外壳元素再 mock,避免在 mock 里再跑查询。
 */
function mockLayout(formLeft: number, formWidth: number, anchorLeft: number) {
  const anchor = trigger().parentElement
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.tagName === 'FORM') return rect(formLeft, formWidth)
    if (this === anchor) return rect(anchorLeft, 90)
    return rect(0, 0)
  })
}

beforeEach(() => {
  localStorage.clear()
  useImageChannelPrefsStore.getState().reload()
  useAgentChatStore.setState({ selectedImageChannel: DEFAULT_IMAGE_CHANNEL_ID })
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

function renderInForm() {
  return render(
    <form>
      <ImageChannelPicker />
    </form>,
  )
}

describe('ImageChannelPicker 弹层定位', () => {
  it('输入框比弹层上限窄(聊天面板被缩窄)时,弹层宽度跟着输入框、左边贴齐输入框', () => {
    renderInForm()
    mockLayout(120, 400, 430)
    fireEvent.click(trigger())
    const el = dialog()
    // 弹层落在 120~520 = 输入框范围:相对外壳 left = 120 - 430,宽 400。
    expect(el.style.width).toBe('400px')
    expect(el.style.left).toBe(`${120 - 430}px`)
    // 有测量结果时不再带固定宽度的 CSS 默认(否则会盖过 inline 宽度的意图)。
    expect(el.className).not.toMatch(/w-\[min\(540px/)
  })

  it('输入框很宽时,弹层宽 540、贴着触发按钮;按钮太靠右放不下就往左挪到右边贴齐', () => {
    renderInForm()
    mockLayout(100, 800, 150)
    fireEvent.click(trigger())
    expect(dialog().style.width).toBe('540px')
    expect(dialog().style.left).toBe('0px')
    cleanup()
    vi.restoreAllMocks()

    renderInForm()
    mockLayout(100, 800, 400)
    fireEvent.click(trigger())
    expect(dialog().style.width).toBe('540px')
    expect(dialog().style.left).toBe('-40px') // 360~900,右边正好贴齐输入框右边 900
  })

  it('窗口 resize 时重新测量', () => {
    renderInForm()
    const spy = mockLayout(100, 800, 150)
    fireEvent.click(trigger())
    expect(dialog().style.width).toBe('540px')

    spy.mockRestore()
    mockLayout(100, 360, 150) // 窗口缩小:输入框变窄
    fireEvent(window, new Event('resize'))
    expect(dialog().style.width).toBe('360px')
  })

  it('没有布局(jsdom / 输入框被隐藏)时退回 CSS 默认尺寸,不写 inline 宽度', () => {
    renderInForm()
    fireEvent.click(trigger())
    const el = dialog()
    expect(el.style.width).toBe('')
    expect(el.className).toMatch(/left-0/)
    expect(el.className).toMatch(/w-\[min\(540px/)
  })

  it('不在 form 里也能用(退回父元素当边界)', () => {
    render(
      <div>
        <ImageChannelPicker />
      </div>,
    )
    fireEvent.click(trigger())
    expect(dialog()).toBeTruthy()
  })

  it('药丸窄了只用省略号收短渠道名:不折行、形状不变,图标 / 徽标 / 箭头不被压扁', () => {
    renderInForm()
    const btn = trigger()
    expect(btn.className).toMatch(/whitespace-nowrap/)
    expect(btn.className).toMatch(/\bmin-w-0\b/)
    expect(btn.className).toMatch(/\bw-full\b/)
    // 外壳是 flex 子项:可收缩、但有下限,至少还能认出渠道名开头。
    expect(btn.parentElement?.className).toMatch(/min-w-\[4\.5rem\]/)
    const label = btn.querySelector('span.font-medium') as HTMLElement
    expect(label.className).toMatch(/\btruncate\b/)
    expect(label.className).toMatch(/\bmin-w-0\b/)
    for (const svg of Array.from(btn.querySelectorAll('svg'))) {
      expect(svg.getAttribute('class')).toMatch(/\bshrink-0\b/)
    }
  })

  it('完整渠道名始终在 title / aria-label 里(文字被省略时仍能看到)', () => {
    renderInForm()
    expect(trigger().getAttribute('aria-label')).toMatch(/^出图渠道：.+/)
    expect(trigger().getAttribute('title')).toMatch(/^出图渠道 · .+/)
  })

  it('徽标(如「官转」)不收缩,工具条变窄(c1)时由 group 变体收起', () => {
    const withBadge = placeImageChannels().find((c) => channelTriggerBadge(c) === '官转')
    expect(withBadge).toBeTruthy()
    useAgentChatStore.setState({ selectedImageChannel: withBadge!.id } as never)
    renderInForm()
    const badge = screen.getByTestId('image-channel-trigger-badge')
    expect(badge.textContent).toBe('官转')
    expect(badge.className).toMatch(/\bshrink-0\b/)
    expect(badge.className).toMatch(/group-data-\[c1\]\/tb:hidden/)
  })
})
