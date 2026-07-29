// 选中态的「够不够得着」:命中区大小、取消选中的可见度、Esc 退路。
//
// 用户反馈:可选中的地方太小(原来头部行只有上内边距,实际可点高度约等于文字高度,
// 要瞄准才点得中),以及取消选中按钮太不起眼(一条低对比度裸文字挤在一排实心按钮里)。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function seedAndRender(n: number): string[] {
  const ids = useVideoWorkbenchStore.getState().addCards(
    Array.from({ length: n }, (_, i) => ({ prompt: `p${i}` })),
  )
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
  return ids
}

const selected = (): string[] => useVideoWorkbenchStore.getState().selectedCardIds

describe('命中区', () => {
  it('头部行上下都有内边距 —— 只有 pt 时可点高度约等于一行字', () => {
    seedAndRender(1)
    const cls = screen.getAllByTestId('vw-card-header')[0].className
    expect(cls).toContain('py-3')
    expect(cls).not.toContain('pt-3')
  })

  it('给出可拖光标与悬停底色 —— 命中区看不见时用户不知道往哪儿按', () => {
    seedAndRender(1)
    const cls = screen.getAllByTestId('vw-card-header')[0].className
    expect(cls).toContain('cursor-grab')
    expect(cls).toContain('hover:bg-white/[0.04]')
  })

  it('选中的卡头部带底色 —— 边框之外再给一处可见反馈', () => {
    const ids = seedAndRender(2)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    expect(screen.getAllByTestId('vw-card-header')[0].className).toContain('bg-[#FCE300]')
    expect(screen.getAllByTestId('vw-card-header')[1].className).not.toContain('bg-[#FCE300]')
  })
})

describe('取消选中', () => {
  it('是个和邻居一样的描边按钮,不是一条裸文字', () => {
    seedAndRender(1)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    const button = screen.getByRole('button', { name: '取消选中' })
    expect(button.className).toContain('border')
    expect(button.className).toContain('px-3')
  })

  it('点它清空选中', () => {
    seedAndRender(2)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    expect(selected()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '取消选中' }))
    expect(selected()).toEqual([])
  })

  it('没有选中时不占位', () => {
    seedAndRender(1)
    expect(screen.queryByRole('button', { name: '取消选中' })).toBeNull()
  })
})

describe('Esc 退路', () => {
  it('按 Esc 清空选中', () => {
    seedAndRender(2)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    expect(selected()).toHaveLength(1)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(selected()).toEqual([])
  })

  it('输入框里按 Esc 不劫走 —— 那是编辑动作(退出输入法候选等)', () => {
    const ids = seedAndRender(1)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    expect(selected()).toEqual([ids[0]])

    const editor = document.querySelector('.vw-rich-input') as HTMLElement | null
    expect(editor).toBeTruthy()
    act(() => {
      editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(selected()).toEqual([ids[0]])
  })

  it('已经被别人处理掉的 Esc 不再插手(弹层关闭会 preventDefault)', () => {
    const ids = seedAndRender(1)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      event.preventDefault()
      window.dispatchEvent(event)
    })
    expect(selected()).toEqual([ids[0]])
  })
})
