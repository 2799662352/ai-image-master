// 组合器的投放悬停反馈。此前 onDragOver 只调 preventDefault,能放但看不出来能放。
//
// 反馈按 MIME 收窄(只为我们认识的载荷亮),但 preventDefault 保持无条件 ——
// 收窄它会连带掐掉浏览器原生的选中文本拖入 textarea。

import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

beforeEach(() => {
  useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [] } as never)
})

const ACTIVE = 'border-cyan-300/80'
const IDLE = 'border-cyan-400/20'

function transfer(types: string[]): DataTransfer {
  return {
    types,
    files: [] as unknown as FileList,
    getData: () => '',
    setData: () => {},
    dropEffect: 'none',
  } as unknown as DataTransfer
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

/** 表单是挂 drag 处理的那一层,textarea 是显示高亮的那一层。 */
function composer(): HTMLElement {
  const form = textarea().closest('form')
  expect(form).toBeTruthy()
  return form as HTMLElement
}

/**
 * jsdom 没有 DragEvent 构造器,testing-library 退化成普通 Event,init 里的
 * relatedTarget 会被丢掉 —— 而「掠过子元素不收起」这条守卫恰好只看 relatedTarget。
 * 所以手工建事件再把它钉上去。
 */
function fireDragLeave(target: HTMLElement, relatedTarget: Node | null): void {
  const event = createEvent.dragLeave(target, { dataTransfer: transfer(['Files']) })
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget, configurable: true })
  fireEvent(target, event)
}

describe('组合器投放悬停反馈', () => {
  it('拖着内部文件路径悬停 → 高亮 + 光标为 copy', () => {
    render(<MentionInput />)
    expect(textarea().className).toContain(IDLE)

    const dataTransfer = transfer(['application/x-catimation-file-paths'])
    fireEvent.dragOver(composer(), { dataTransfer })

    expect(textarea().className).toContain(ACTIVE)
    expect(textarea().className).not.toContain(IDLE)
    // 组合器只会复制(附件/引用),从不移动源文件
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  it('OS 文件与引文同样点亮', () => {
    render(<MentionInput />)
    fireEvent.dragOver(composer(), { dataTransfer: transfer(['Files']) })
    expect(textarea().className).toContain(ACTIVE)

    fireDragLeave(composer(), null)
    expect(textarea().className).toContain(IDLE)

    fireEvent.dragOver(composer(), { dataTransfer: transfer(['application/x-catimation-quote']) })
    expect(textarea().className).toContain(ACTIVE)
  })

  it('不认识的载荷不点亮,但依然 preventDefault(原生文本拖入不能被掐掉)', () => {
    render(<MentionInput />)
    const dataTransfer = transfer(['text/plain'])
    const accepted = !fireEvent.dragOver(composer(), { dataTransfer })

    expect(textarea().className).toContain(IDLE)
    // fireEvent 返回 false 表示事件被 preventDefault 了
    expect(accepted).toBe(true)
    expect(dataTransfer.dropEffect).toBe('none')
  })

  it('掠过子元素不收起高亮 —— dragleave 会为每次跨子元素触发', () => {
    render(<MentionInput />)
    const form = composer()
    fireEvent.dragOver(form, { dataTransfer: transfer(['Files']) })
    expect(textarea().className).toContain(ACTIVE)

    fireDragLeave(form, textarea())
    expect(textarea().className).toContain(ACTIVE)
  })

  it('真正离开组合器才收起', () => {
    render(<MentionInput />)
    const form = composer()
    fireEvent.dragOver(form, { dataTransfer: transfer(['Files']) })
    fireDragLeave(form, document.body)
    expect(textarea().className).toContain(IDLE)
  })

  it('投放后收起高亮', () => {
    render(<MentionInput />)
    const form = composer()
    fireEvent.dragOver(form, { dataTransfer: transfer(['Files']) })
    expect(textarea().className).toContain(ACTIVE)

    fireEvent.drop(form, { dataTransfer: transfer([]) })
    expect(textarea().className).toContain(IDLE)
  })
})
