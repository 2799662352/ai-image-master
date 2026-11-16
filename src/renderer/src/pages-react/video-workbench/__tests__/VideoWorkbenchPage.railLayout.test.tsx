// 工作台页壳:剧栏固定一屏高所依赖的结构,以及「导入/导出只在剧栏有一份」。
//
// sticky 对祖先的 overflow 很敏感:页面根只要是 overflow-hidden,里面 position:sticky 的剧栏就
// 粘在一个永远不滚的盒子里(实机量过:顶边停在 -415 而不是 12)。这类回退肉眼看不出来 ——
// 本地 pnpm dev 窗口很高、右侧内容又短,剧栏根本没有滚动空间 —— 所以单独守一条。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../../../features/video-workbench/store'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

beforeEach(() => {
  resetWorkbenchStoreForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('VideoWorkbenchPage 剧栏布局', () => {
  it('页面根是 overflow-clip,不是 overflow-hidden(后者会让 sticky 剧栏失效)', () => {
    const { container } = render(<VideoWorkbenchPage />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('overflow-clip')
    expect(root.className).not.toContain('overflow-hidden')
  })

  it('剧栏挂在 RailColumn 里:外层列 stretch 铺背景,内层 sticky 装剧栏', () => {
    const { container } = render(<VideoWorkbenchPage />)
    expect(container.querySelector('.vw-rail-col > .vw-rail-sticky > aside[aria-label="剧栏"]')).not.toBeNull()
  })

  it('导入工程 / 导出当前剧各只有一个入口(在剧栏底部),剧总览头部不再重复', () => {
    useVideoWorkbenchStore.getState().openOverview()
    render(<VideoWorkbenchPage />)
    expect(screen.getAllByRole('button', { name: '导入工程' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '导出当前剧' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '导出工程' })).toBeNull()
    // 总览确实渲染了(否则上面的「没有重复」是空话)
    expect(screen.getByRole('region', { name: '剧总览' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建分段' })).toBeTruthy()
  })
})
