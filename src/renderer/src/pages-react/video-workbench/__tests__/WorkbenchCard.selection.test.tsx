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

/** jsdom 没有 DataTransfer,同目录 MaterialStack.test.tsx 是同款替身。 */
function fakeDataTransfer(): DataTransfer {
  const data: Record<string, string> = {}
  return {
    get types() {
      return Object.keys(data)
    },
    effectAllowed: '',
    dropEffect: '',
    setData(t: string, v: string) {
      data[t] = v
    },
    getData(t: string) {
      return data[t] ?? ''
    },
  } as unknown as DataTransfer
}

const FILE_PATHS_MIME = 'application/x-catimation-file-paths'

function dragHandle(i: number): HTMLElement {
  return screen.getAllByTitle('拖动排序')[i]
}

/** 让卡片带上产物路径 —— 出片过的卡才有东西可以递给聊天栏。 */
function giveLocalPaths(ids: string[]): void {
  useVideoWorkbenchStore.setState((s) => ({
    cards: s.cards.map((c) =>
      ids.includes(c.id) ? { ...c, status: 'succeeded' as const, localPath: `C:/u/agent/uploads/${c.id}.mp4` } : c,
    ),
  }))
}

describe('WorkbenchCard 拖拽载荷', () => {
  it('页内排序 MIME 与聊天栏路径 MIME 同时写,effectAllowed 为 copyMove', () => {
    const ids = seedAndRender(1)
    giveLocalPaths(ids)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(dragHandle(0), { dataTransfer })

    expect(dataTransfer.getData('application/x-vw-card')).toBe(ids[0])
    expect(JSON.parse(dataTransfer.getData(FILE_PATHS_MIME))).toEqual([`C:/u/agent/uploads/${ids[0]}.mp4`])
    expect(dataTransfer.effectAllowed).toBe('copyMove')
  })

  it('拖一张已选中的卡 = 递出全部选中项的路径,旧 MIME 仍只带一张', () => {
    const ids = seedAndRender(3)
    giveLocalPaths(ids)
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[2], { ctrlKey: true })

    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(dragHandle(0), { dataTransfer })

    expect(JSON.parse(dataTransfer.getData(FILE_PATHS_MIME))).toEqual([
      `C:/u/agent/uploads/${ids[0]}.mp4`,
      `C:/u/agent/uploads/${ids[2]}.mp4`,
    ])
    expect(dataTransfer.getData('application/x-vw-card')).toBe(ids[0])
  })

  it('拖一张未选中的卡 → 选区换成它,只递它自己(与文件树一致)', () => {
    const ids = seedAndRender(3)
    giveLocalPaths(ids)
    fireEvent.click(screen.getAllByTestId('vw-card-header')[0])

    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(dragHandle(2), { dataTransfer })

    expect(JSON.parse(dataTransfer.getData(FILE_PATHS_MIME))).toEqual([`C:/u/agent/uploads/${ids[2]}.mp4`])
    // 选区跟着拖动走,于是「拖出去的」恒等于 agent 从选中态读到的
    expect(selected()).toEqual([ids[2]])
  })

  it('还没出片的卡不写路径 MIME —— 不假装递了东西', () => {
    const ids = seedAndRender(1)
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(dragHandle(0), { dataTransfer })

    expect(dataTransfer.types).not.toContain(FILE_PATHS_MIME)
    // 排序照旧可用
    expect(dataTransfer.getData('application/x-vw-card')).toBe(ids[0])
  })

  it('选中里混着没出片的卡时只递有产物的那些', () => {
    const ids = seedAndRender(2)
    giveLocalPaths([ids[1]])
    const headers = screen.getAllByTestId('vw-card-header')
    fireEvent.click(headers[0])
    fireEvent.click(headers[1], { ctrlKey: true })

    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(dragHandle(0), { dataTransfer })

    expect(JSON.parse(dataTransfer.getData(FILE_PATHS_MIME))).toEqual([`C:/u/agent/uploads/${ids[1]}.mp4`])
  })
})
