// 撤销/重做入口单测:按钮可用性跟栈深联动、点击生效、Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
// 快捷键、输入框内不劫持快捷键、拒绝与部分跳过时的 toast。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useToastStore } from '../../../stores/useToastStore'
import { UndoRedoButtons } from '../UndoRedoButtons'

function state() {
  return useVideoWorkbenchStore.getState()
}

const undoButton = () => screen.getByRole('button', { name: '撤销' })
const redoButton = () => screen.getByRole('button', { name: '重做' })

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
})

describe('UndoRedoButtons', () => {
  it('栈空时两个按钮都禁用', () => {
    render(<UndoRedoButtons />)
    expect(undoButton()).toHaveProperty('disabled', true)
    expect(redoButton()).toHaveProperty('disabled', true)
  })

  it('有编排改动后撤销可用,撤销完重做可用', async () => {
    render(<UndoRedoButtons />)

    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })
    await waitFor(() => expect(undoButton()).toHaveProperty('disabled', false))
    expect(redoButton()).toHaveProperty('disabled', true)

    fireEvent.click(undoButton())

    await waitFor(() => expect(state().cards[0].prompt).toBe('旧'))
    await waitFor(() => expect(redoButton()).toHaveProperty('disabled', false))

    fireEvent.click(redoButton())
    await waitFor(() => expect(state().cards[0].prompt).toBe('新'))
  })

  it('Ctrl+Z 撤销,Ctrl+Shift+Z 与 Ctrl+Y 重做', async () => {
    render(<UndoRedoButtons />)
    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(state().cards[0].prompt).toBe('旧'))

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(state().cards[0].prompt).toBe('新'))

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(state().cards[0].prompt).toBe('旧'))

    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    await waitFor(() => expect(state().cards[0].prompt).toBe('新'))
  })

  it('焦点在提示词框里时不劫持 Ctrl+Z —— 让浏览器撤销刚打的字', () => {
    render(
      <>
        <UndoRedoButtons />
        <textarea aria-label="提示词" />
      </>,
    )
    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })

    const box = screen.getByLabelText('提示词')
    box.focus()
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })

    expect(state().cards[0].prompt).toBe('新')
    expect(state().undoStack.length).toBeGreaterThan(0)
  })

  it('不带修饰键的 z 不触发', () => {
    render(<UndoRedoButtons />)
    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })

    fireEvent.keyDown(window, { key: 'z' })

    expect(state().cards[0].prompt).toBe('新')
  })

  it('在飞的卡拒绝回滚时弹 warning toast', async () => {
    render(<UndoRedoButtons />)

    // 快照:空看板。之后加一张卡并让它进入「渲染中」—— 撤销想删它,但被硬门拦住。
    const [cardId] = state().addCards([{ prompt: '跑着的' }])
    useVideoWorkbenchStore.setState({
      cards: state().cards.map((c) => (c.id === cardId ? { ...c, status: 'running' } : c)),
    })

    await waitFor(() => expect(undoButton()).toHaveProperty('disabled', false))
    fireEvent.click(undoButton())

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts
      expect(toasts).toHaveLength(1)
      expect(toasts[0].type).toBe('warning')
      expect(toasts[0].message).toContain('正在生成')
    })
    // 卡片仍在页面上,没被撤销抹掉
    expect(state().cards.map((c) => c.id)).toEqual([cardId])
  })

  it('全部成功时不弹 toast', async () => {
    render(<UndoRedoButtons />)
    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })

    await waitFor(() => expect(undoButton()).toHaveProperty('disabled', false))
    fireEvent.click(undoButton())

    await waitFor(() => expect(state().cards[0].prompt).toBe('旧'))
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('卸载后不再响应快捷键(页面被隐藏时不该抢全局按键)', async () => {
    const view = render(<UndoRedoButtons />)
    const [cardId] = state().addCards([{ prompt: '旧' }])
    state().updateCard(cardId, { prompt: '新' })
    view.unmount()

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    await Promise.resolve()
    expect(state().cards[0].prompt).toBe('新')
  })
})
