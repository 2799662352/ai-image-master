// 多「页」页签组件单测:切换/新建/双击重命名(Enter 确认、Esc 取消)/删除进回收站/右键菜单。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('✕ 删除 = 移入回收站(可恢复),不再二次确认;删后切到剩余页', () => {
    useVideoWorkbenchStore.getState().addBoard('待删页')
    render(<BoardTabs />)

    fireEvent.click(screen.getByRole('button', { name: '删除页「待删页」' }))

    const state = useVideoWorkbenchStore.getState()
    expect(state.boards).toHaveLength(1)
    expect(state.boards[0].name).toBe('页面 1')
    expect(state.activeBoardId).toBe(state.boards[0].id)
    // 进了回收站,而不是物理删除
    expect(state.trash).toHaveLength(1)
    expect(state.trash[0].kind).toBe('board')
    // 原来的「确认删除」第二步已不存在
    expect(screen.queryByRole('button', { name: /确认删除/ })).toBeNull()
    // 恢复后又回来了
    expect(state.restoreFromTrash(state.trash[0].id).ok).toBe(true)
    expect(useVideoWorkbenchStore.getState().boards.map((b) => b.name)).toContain('待删页')
  })

  it('仅剩一页时不出删除按钮(至少保留一页)', () => {
    render(<BoardTabs />)
    expect(screen.queryByRole('button', { name: /删除页/ })).toBeNull()
  })

  it('右键页签弹出菜单:重命名 / 置顶 / Fork / 删除', () => {
    useVideoWorkbenchStore.getState().addBoard('第二页')
    render(<BoardTabs />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /页面 1/ }))
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')
    expect(items).toHaveLength(4)
    expect(items[0]).toContain('重命名')
    expect(items[1]).toContain('置顶')
    expect(items[2]).toContain('Fork')
    expect(items[3]).toContain('删除')
  })

  it('右键 → 重命名 进入行内编辑', () => {
    render(<BoardTabs />)
    fireEvent.contextMenu(screen.getByRole('tab', { name: /页面 1/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '改过的' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useVideoWorkbenchStore.getState().boards[0].name).toBe('改过的')
  })

  it('右键 → 置顶:该页排到最前并出 PIN 标;再右键变「取消置顶」', () => {
    const S = () => useVideoWorkbenchStore.getState()
    S().addBoard('第二页')
    render(<BoardTabs />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /第二页/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /置顶/ }))

    const tabs = screen.getAllByRole('tab').map((el) => el.textContent ?? '')
    expect(tabs[0]).toContain('第二页')
    expect(screen.getByTitle('已置顶')).toBeTruthy()
    // 置顶不改库里的顺序
    expect(S().boards.map((b) => b.name)).toEqual(['页面 1', '第二页'])

    fireEvent.contextMenu(screen.getByRole('tab', { name: /第二页/ }))
    expect(screen.getByRole('menuitem', { name: /取消置顶/ })).toBeTruthy()
  })

  it('右键 → Fork:紧跟原页生成「副本」并带上卡片', () => {
    const S = () => useVideoWorkbenchStore.getState()
    S().addCards([{ prompt: '一镜到底' }])
    render(<BoardTabs />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /页面 1/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Fork/ }))

    expect(S().boards.map((b) => b.name)).toEqual(['页面 1', '页面 1 副本'])
    const copy = S().boards[1]
    expect(S().cards.filter((c) => c.boardId === copy.id).map((c) => c.prompt)).toEqual(['一镜到底'])
  })

  it('右键 → 删除:进回收站;仅剩一页时「删除」是禁用的', () => {
    const S = () => useVideoWorkbenchStore.getState()
    render(<BoardTabs />)
    fireEvent.contextMenu(screen.getByRole('tab', { name: /页面 1/ }))
    expect((screen.getByRole('menuitem', { name: /删除/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.mouseDown(window)
    expect(screen.queryByRole('menu')).toBeNull()

    act(() => {
      S().addBoard('第二页')
    })
    fireEvent.contextMenu(screen.getByRole('tab', { name: /第二页/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }))
    expect(S().boards.map((b) => b.name)).toEqual(['页面 1'])
    expect(S().trash).toHaveLength(1)
  })

  it('Esc / 点菜单外面都能关掉右键菜单', () => {
    render(<BoardTabs />)
    fireEvent.contextMenu(screen.getByRole('tab', { name: /页面 1/ }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(screen.getByRole('tab', { name: /页面 1/ }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
