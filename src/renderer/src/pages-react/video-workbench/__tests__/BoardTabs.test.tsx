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

  it('「+」新建分段并切换过去', () => {
    render(<BoardTabs />)
    fireEvent.click(screen.getByRole('button', { name: '新建分段' }))
    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(2)
    expect(state.activeBoardId).toBe(state.boards[1].id)
    expect(screen.getByRole('tab', { name: /分段 2/ })).toBeTruthy()
  })

  it('只显示当前剧的分段;面包屑「返回总览」回总览', () => {
    const S = () => useVideoWorkbenchStore.getState()
    S().addProject('A 剧')
    S().addBoard('别剧的段')
    S().switchProject('project-default')
    render(<BoardTabs />)
    expect(screen.queryByText('别剧的段')).toBeNull()
    expect(screen.getByRole('tab', { name: /页面 1/ })).toBeTruthy()
    // 面包屑:「‹ 总览」是按钮,剧名与当前段名是路径文字
    expect(screen.getByRole('button', { name: '返回总览' }).textContent).toContain('总览')
    expect(screen.getByText('默认项目')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回总览' }))
    expect(S().viewByProject['project-default']).toEqual({ mode: 'overview' })
  })

  it('页签自动换行,不出横向滚动条(与 superdesign 定稿一致)', () => {
    const S = () => useVideoWorkbenchStore.getState()
    for (let i = 0; i < 12; i += 1) S().addBoard()
    render(<BoardTabs />)
    const list = screen.getByRole('tablist', { name: '本剧分段' })
    expect(list.className).toContain('vw-tabs')
    expect(list.className).not.toContain('scroll')
    expect(screen.getAllByRole('tab')).toHaveLength(13)
  })

  /**
   * 摘要原本只有 agent 写得了。不给 UI 入口的话，agent 写错用户改不掉，
   * 也不知道自己这一页被标成了什么 —— 那是个单向门。
   */
  it('摘要:别页在页签上行内截断显示,完整内容进 title', () => {
    const first = useVideoWorkbenchStore.getState().activeBoardId
    useVideoWorkbenchStore.getState().setBoardSummary(first, '追车戏 8 镜，全部夜景')
    useVideoWorkbenchStore.getState().addBoard('第二页') // 切走，让第一页成为「别页」
    render(<BoardTabs />)

    const inline = screen.getByText('追车戏 8 镜，全部夜景')
    expect(inline.getAttribute('title')).toContain('追车戏 8 镜，全部夜景')
    // 摘要不该是第二个 tab stop：点它和点页名是同一个意图（切到这页）。
    expect(inline.tagName).toBe('SPAN')
    expect(inline.className).toContain('truncate')
  })

  it('摘要:当前页只在右侧出一份,不在页签里重复', () => {
    const store = useVideoWorkbenchStore.getState()
    store.setBoardSummary(store.activeBoardId, '追车戏 8 镜')
    render(<BoardTabs />)
    // 同一句话印两遍是噪音；编辑时更会出现两个 autoFocus 输入框互抢焦点。
    expect(screen.getAllByText('追车戏 8 镜')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /页面 1/ }).textContent).toBe('页面 1')
  })

  it('摘要:当前页在右侧空域出全文位,点击展开/收起,切页自动收回', () => {
    const long = '追车戏 8 镜，全部夜景，主角车与追兵车交替，第 6 镜撞击后转慢速'
    const store = useVideoWorkbenchStore.getState()
    store.setBoardSummary(store.activeBoardId, long)
    render(<BoardTabs />)

    // 全文位挂在页签栏右侧，不是把当前页签本身撑宽 —— 页签宽度不随切页跳动。
    const full = screen.getByRole('button', { name: `当前页摘要：${long}` })
    expect(full.getAttribute('aria-expanded')).toBe('false')
    expect(full.className).toContain('truncate')

    fireEvent.click(full)
    expect(full.getAttribute('aria-expanded')).toBe('true')
    expect(full.className).toContain('whitespace-normal')

    // 展开是「此刻想细看」的临时意图，不是页的属性：切页后收回，
    // 否则切到长摘要的页会让整条栏高度突然跳一下。
    fireEvent.click(screen.getByRole('button', { name: '新建分段' }))
    expect(screen.queryByRole('button', { name: /当前页摘要/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /页面 1/ }))
    expect(
      screen.getByRole('button', { name: `当前页摘要：${long}` }).getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('摘要:没写过的页给「＋摘要」入口,点开写入并落库', () => {
    render(<BoardTabs />)
    fireEvent.click(screen.getByRole('button', { name: '给当前页写摘要' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: '医院线，3 镜' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useVideoWorkbenchStore.getState().boards[0].summary).toBe('医院线，3 镜')
  })

  it('摘要:双击可改,清空即删除,Esc 不落盘', () => {
    const { activeBoardId, setBoardSummary } = useVideoWorkbenchStore.getState()
    setBoardSummary(activeBoardId, '旧摘要')
    render(<BoardTabs />)

    // 当前页的摘要在右侧全文位上编辑：单击是「看」，双击是「改」，与页签手势一致。
    fireEvent.doubleClick(screen.getByText('旧摘要'))
    let input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '改过的' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useVideoWorkbenchStore.getState().boards[0].summary).toBe('旧摘要')

    fireEvent.doubleClick(screen.getByText('旧摘要'))
    input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useVideoWorkbenchStore.getState().boards[0].summary).toBeUndefined()
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
