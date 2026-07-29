// 头部行点选:单击 / Ctrl 加选 / Shift 区间,以及「点主体不改变选中」这条防误选守卫。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

/** 种 n 张卡并渲染页面,返回卡片 id(按显示序)。 */
function seedAndRender(n: number): string[] {
  const ids = useVideoWorkbenchStore.getState().addCards(
    Array.from({ length: n }, (_, i) => ({ prompt: `p${i}` })),
  )
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
  return ids
}

function selected(): string[] {
  return useVideoWorkbenchStore.getState().selectedCardIds
}

describe('WorkbenchCard 头部点选', () => {
  it('单击头部选中该卡', () => {
    const ids = seedAndRender(2)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    expect(selected()).toEqual([ids[0]])
  })

  it('Ctrl 单击加选', () => {
    const ids = seedAndRender(2)
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[1], { ctrlKey: true })
    expect(selected()).toEqual([ids[0], ids[1]])
  })

  it('Shift 单击选区间', () => {
    const ids = seedAndRender(3)
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[2], { shiftKey: true })
    expect(selected()).toEqual(ids)
  })

  it('点头部行里的按钮不触发选中 —— 删除卡不该顺带选中它', () => {
    seedAndRender(2)
    const header = screen.getAllByTestId('vw-card-header')[0]
    const button = header.querySelector('button')
    expect(button).toBeTruthy()
    fireEvent.click(button!)
    expect(selected()).toEqual([])
  })

  it('点卡片主体的提示词输入框不改变已有选中(防误选守卫)', () => {
    const ids = seedAndRender(2)
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[1], { ctrlKey: true })
    expect(selected()).toEqual([ids[0], ids[1]])

    const editor = document.querySelector('.vw-rich-input')
    expect(editor).toBeTruthy()
    fireEvent.click(editor!)
    expect(selected()).toEqual([ids[0], ids[1]])
  })

  it('选中的卡外层带黄边,未选中的不带', () => {
    const ids = seedAndRender(2)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])
    expect(screen.getByTestId(`vw-card-${ids[0]}`).className).toContain('border-[#FCE300]')
    expect(screen.getByTestId(`vw-card-${ids[1]}`).className).not.toContain('border-[#FCE300]')
  })
})
