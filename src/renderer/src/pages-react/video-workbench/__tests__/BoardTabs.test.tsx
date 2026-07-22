// 多「页」页签组件单测:切换/新建/双击重命名(Enter 确认、Esc 取消)/二次确认删除。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { BoardTabs } from '../BoardTabs'

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
})

describe('BoardTabs', () => {
  it('渲染全部页签并高亮当前页;点击切换', () => {
    const secondId = useVideoWorkbenchStore.getState().addBoard('分镜页')
    render(<BoardTabs />)

    const first = screen.getByRole('tab', { name: /页面 1/ })
    const second = screen.getByRole('tab', { name: /分镜页/ })
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(first.getAttribute('aria-selected')).toBe('false')

    fireEvent.click(first)
    expect(useVideoWorkbenchStore.getState().activeBoardId).not.toBe(secondId)
    expect(first.getAttribute('aria-selected')).toBe('true')
  })

  it('「+」新建页并切换过去', () => {
    render(<BoardTabs />)
    fireEvent.click(screen.getByRole('button', { name: '新建页' }))
    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(2)
    expect(state.activeBoardId).toBe(state.boards[1].id)
    expect(screen.getByRole('tab', { name: /页面 2/ })).toBeTruthy()
  })

  it('双击页签进入行内编辑,Enter 确认重命名', () => {
    render(<BoardTabs />)
    fireEvent.doubleClick(screen.getByRole('tab', { name: /页面 1/ }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('页面 1')

    fireEvent.change(input, { target: { value: '我的分镜' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useVideoWorkbenchStore.getState().boards[0].name).toBe('我的分镜')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('行内编辑 Esc 取消,名称不变', () => {
    render(<BoardTabs />)
    fireEvent.doubleClick(screen.getByRole('tab', { name: /页面 1/ }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '不该生效' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useVideoWorkbenchStore.getState().boards[0].name).toBe('页面 1')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('删除需两步确认:第一次点变「确认删除」,再点才删;删后切到剩余页', () => {
    useVideoWorkbenchStore.getState().addBoard('待删页')
    render(<BoardTabs />)

    const del = screen.getByRole('button', { name: '删除页「待删页」' })
    fireEvent.click(del)
    // 第一次点击不删,进入确认态
    expect(useVideoWorkbenchStore.getState().boards).toHaveLength(2)
    const confirm = screen.getByRole('button', { name: '确认删除「待删页」' })
    fireEvent.click(confirm)

    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(1)
    expect(state.boards[0].name).toBe('页面 1')
    expect(state.activeBoardId).toBe(state.boards[0].id)
  })

  it('仅剩一页时不出删除按钮(至少保留一页)', () => {
    render(<BoardTabs />)
    expect(screen.queryByRole('button', { name: /删除页/ })).toBeNull()
  })
})
