/**
 * 输入框下面那排工具栏(Agent 标签 / 模型 / 协作模式 / 出图渠道 / 宠物 / 语音 / Send)在聊天面板被缩窄时:
 * 药丸形状与高度不变(不折行、不被挤成多行)、按钮一个都不丢、只省文字。
 *
 * 回归(用户 2026-10-30 真机截图):面板一窄,模型名折成三行、出图渠道的「官转」折成两行、
 * 语音和 Send 被挤出面板右边。
 * 做法:名称用省略号收短 → 徽标 / 待机语音字样收起(c1)→ 协作模式只留图标(c2)→ 极窄才整颗换行(wrap)。
 * jsdom 没有布局引擎,这里钉类名契约 + 行宽驱动的 data 标记;像素效果见 README 的真窗口验收记录。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cleanup()
})

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { sendMessage: vi.fn(), cancel: vi.fn() },
      fs: { stat: vi.fn() },
    },
    configurable: true,
  })
  useAgentChatStore.setState({
    input: 'hello',
    isRunning: false,
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
    availablePluginMentions: [],
  } as never)
})

const row = (): HTMLElement => screen.getByText('Agent').parentElement as HTMLElement

/** 让工具条行得到指定宽度,并能手动触发 ResizeObserver 回调。 */
function mockRowWidth(initial: number) {
  let width = initial
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const w = this.hasAttribute('data-toolbar-row') ? width : 0
    return { width: w, height: 20, left: 0, top: 0, right: w, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  const callbacks = new Set<() => void>()
  class FakeRO {
    private readonly cb: () => void
    constructor(cb: () => void) {
      this.cb = cb
      callbacks.add(cb)
    }
    observe() {}
    unobserve() {}
    disconnect() {
      callbacks.delete(this.cb)
    }
  }
  vi.stubGlobal('ResizeObserver', FakeRO)
  return {
    resize(next: number) {
      width = next
      act(() => callbacks.forEach((cb) => cb()))
    },
  }
}

describe('MentionInput 工具栏窄屏:形状不变、按钮不丢', () => {
  it('默认不换行:药丸保持一行,靠省略号 / 图标态收窄;只有 data-wrap 才允许换行', () => {
    render(<MentionInput />)
    expect(row().className).not.toMatch(/(^|\s)flex-wrap(\s|$)/)
    expect(row().className).toMatch(/data-\[wrap\]:flex-wrap/)
    expect(row().className).toMatch(/\bgroup\/tb\b/)
  })

  it('Agent 标签不收缩、不折行', () => {
    render(<MentionInput />)
    const chip = screen.getByText('Agent')
    expect(chip.className).toMatch(/\bshrink-0\b/)
    expect(chip.className).toMatch(/whitespace-nowrap/)
  })

  it('Send 在右侧动作组里:整组 ml-auto 贴右、不收缩', () => {
    render(<MentionInput />)
    const group = screen.getByRole('button', { name: 'Send' }).parentElement as HTMLElement
    expect(group.parentElement).toBe(row())
    expect(group.className).toMatch(/\bml-auto\b/)
    expect(group.className).toMatch(/\bshrink-0\b/)
  })

  it('不再有把按钮挤出去的 flex-1 弹性占位', () => {
    render(<MentionInput />)
    const spacer = Array.from(row().children).find((el) => el.tagName === 'DIV' && el.className.trim() === 'flex-1')
    expect(spacer).toBeUndefined()
  })

  it('运行中:Steer 与 Stop 在同一个右侧动作组里', () => {
    useAgentChatStore.setState({ isRunning: true } as never)
    render(<MentionInput />)
    const steer = screen.getByRole('button', { name: 'Steer' })
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.parentElement).toBe(steer.parentElement)
    expect((steer.parentElement as HTMLElement).className).toMatch(/\bml-auto\b/)
  })

  it('宽度充足:没有任何收纳标记', () => {
    mockRowWidth(900)
    render(<MentionInput />)
    expect(row().hasAttribute('data-c1')).toBe(false)
    expect(row().hasAttribute('data-c2')).toBe(false)
    expect(row().hasAttribute('data-wrap')).toBe(false)
  })

  it('行宽随面板变窄逐级打上 c1 → c2 → wrap,变宽后又恢复', () => {
    const layout = mockRowWidth(900)
    render(<MentionInput />)

    layout.resize(580)
    expect(row().hasAttribute('data-c1')).toBe(true)
    expect(row().hasAttribute('data-c2')).toBe(false)

    layout.resize(500)
    expect(row().hasAttribute('data-c2')).toBe(true)
    expect(row().hasAttribute('data-wrap')).toBe(false)

    layout.resize(400)
    expect(row().hasAttribute('data-wrap')).toBe(true)

    layout.resize(900)
    expect(row().hasAttribute('data-c1')).toBe(false)
    expect(row().hasAttribute('data-wrap')).toBe(false)
  })

  it('收纳时每个按钮仍在 DOM 里,可点、有名字(文字收起不等于按钮消失)', () => {
    const layout = mockRowWidth(900)
    render(<MentionInput />)
    layout.resize(400)
    expect(screen.getByRole('button', { name: /^选择模型：/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^出图渠道：/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /切换到 (Plan|Default)/ })).toBeTruthy()
    expect(screen.getByTestId('agent-voice-mic')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('四颗主药丸高度固定同为 27px:收起文字(图标态)时高度不变,形状不变', () => {
    render(<MentionInput />)
    const model = screen.getByRole('button', { name: /^选择模型：/ })
    const image = screen.getByRole('button', { name: /^出图渠道：/ })
    const collab = screen.getByRole('button', { name: /切换到 (Plan|Default)/ }).parentElement as HTMLElement
    const voice = screen.getByRole('group', { name: '语音' })
    for (const el of [model, image, collab, voice]) {
      expect(el.className).toMatch(/\bh-\[27px\]/)
    }
  })

  it('协作模式 / 语音药丸本身不收缩(只靠收起文字让位),形状才不会被挤扁', () => {
    render(<MentionInput />)
    const collab = screen.getByRole('button', { name: /切换到 (Plan|Default)/ }).parentElement as HTMLElement
    const voice = screen.getByRole('group', { name: '语音' })
    expect(collab.className).toMatch(/\bshrink-0\b/)
    expect(voice.className).toMatch(/\bshrink-0\b/)
  })

  it('模型药丸:名称用省略号收短、不折行;推理等级徽标不收缩,窄到 c1 时先收起让给名称', () => {
    render(<MentionInput />)
    const model = screen.getByRole('button', { name: /^选择模型：/ })
    expect(model.className).toMatch(/whitespace-nowrap/)
    expect(model.className).toMatch(/\bmin-w-0\b/)
    expect(model.className).toMatch(/\bw-full\b/)
    expect(model.parentElement?.className).toMatch(/min-w-\[5rem\]/)
    const label = model.querySelector('span.font-medium') as HTMLElement
    expect(label.className).toMatch(/\btruncate\b/)
    expect(label.className).toMatch(/\bmin-w-0\b/)
    const badge = model.querySelector('span.uppercase') as HTMLElement
    expect(badge.className).toMatch(/\bshrink-0\b/)
    expect(badge.className).toMatch(/group-data-\[c1\]\/tb:hidden!/)
    for (const svg of Array.from(model.querySelectorAll('svg'))) {
      expect(svg.getAttribute('class')).toMatch(/\bshrink-0\b/)
    }
    // 完整名称始终在 title / aria-label 里
    expect(model.getAttribute('title')).toBeTruthy()
  })

  it('模型弹层同样夹在输入框内:面板比弹层窄时,弹层宽度跟着输入框、不冲出右边界', () => {
    render(<MentionInput />)
    const model = screen.getByRole('button', { name: /^选择模型：/ })
    const anchor = model.parentElement
    const form = model.closest('form')
    const rect = (left: number, width: number) =>
      ({ left, right: left + width, top: 0, bottom: 20, width, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === form) return rect(100, 300)
      if (this === anchor) return rect(250, 90)
      return rect(0, 0)
    })
    fireEvent.click(model)
    const popover = screen.getByRole('listbox', { name: '模型列表' }).parentElement as HTMLElement
    expect(popover.style.width).toBe('300px')
    expect(popover.style.left).toBe(`${100 - 250}px`)
    expect(popover.className).not.toMatch(/w-\[360px\]/)
  })

  it('c2 级:协作模式文字 / 待机语音字样靠 group 变体收起,按钮本身保留', () => {
    render(<MentionInput />)
    const collabLabel = screen.getByText(/^(Default|Plan)$/)
    expect(collabLabel.className).toMatch(/group-data-\[c2\]\/tb:hidden/)
    const micLabel = screen.getByText('语音', { selector: 'span' })
    expect(micLabel.className).toMatch(/group-data-\[c1\]\/tb:hidden/)
  })
})
