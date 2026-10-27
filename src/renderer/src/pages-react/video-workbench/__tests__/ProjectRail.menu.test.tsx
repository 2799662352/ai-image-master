// 剧栏的右键菜单 / 「⋯」入口 / 置顶排序 / 回收站入口。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY, RAIL_COLLAPSED_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useToastStore } from '../../../stores/useToastStore'
import { ProjectRail } from '../ProjectRail'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(RAIL_COLLAPSED_KEY)
  localStorage.removeItem('vw-pins')
  useToastStore.getState().clearAll()
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => cleanup())

const rowNames = () =>
  screen.getAllByRole('button', { name: /切换到剧/ }).map((el) => el.getAttribute('aria-label')?.replace('切换到剧 ', ''))

describe('ProjectRail 右键菜单', () => {
  it('右键剧行:重命名 / 置顶 / Fork / 删除;删除带「移入回收站」说明', () => {
    S().addProject('追车戏')
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 追车戏' }))
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('重命名'),
      expect.stringContaining('置顶'),
      expect.stringContaining('Fork'),
      expect.stringContaining('删除'),
    ])
    expect(items[3].textContent).toContain('移入回收站')
  })

  it('悬停出现的「⋯」与右键是同一份菜单', () => {
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: '剧菜单 默认项目' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
  })

  it('重命名:展开态走就地输入框', () => {
    S().addProject('追车戏')
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 追车戏' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))
    const input = screen.getByRole('textbox', { name: '剧名' })
    fireEvent.change(input, { target: { value: '追车戏 终版' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(S().projects.some((p) => p.name === '追车戏 终版')).toBe(true)
  })

  it('重命名:折叠态没有就地输入框,改走小对话框', () => {
    S().addProject('追车戏')
    S().setRailCollapsed(true)
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /切换到剧 追车戏/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))
    expect(screen.getByRole('dialog', { name: '重命名剧' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '新名称' }), { target: { value: '改名了' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(S().projects.some((p) => p.name === '改名了')).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('置顶:该剧排到最前并出 PIN 标;取消置顶回到原位;不改库里的顺序', () => {
    S().addProject('追车戏')
    S().addProject('第三部')
    render(<ProjectRail />)
    expect(rowNames()).toEqual(['默认项目', '追车戏', '第三部'])

    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 第三部' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /置顶/ }))
    expect(rowNames()).toEqual(['第三部', '默认项目', '追车戏'])
    expect(screen.getAllByTitle('已置顶')).toHaveLength(1)
    expect(S().projects.slice().sort((a, b) => a.order - b.order).map((p) => p.name)).toEqual([
      '默认项目',
      '追车戏',
      '第三部',
    ])

    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 第三部' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /取消置顶/ }))
    expect(rowNames()).toEqual(['默认项目', '追车戏', '第三部'])
  })

  it('Fork:创建「副本」整部剧(含分段和卡片),并提示', () => {
    S().addProject('追车戏')
    S().addCards([{ prompt: '一镜' }])
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 追车戏' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Fork/ }))
    expect(rowNames()).toContain('追车戏 副本')
    const copy = S().projects.find((p) => p.name === '追车戏 副本')!
    const boardIds = S().boards.filter((b) => b.projectId === copy.id).map((b) => b.id)
    expect(S().cards.filter((c) => c.boardId && boardIds.includes(c.boardId)).map((c) => c.prompt)).toEqual(['一镜'])
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已创建副本「追车戏 副本」'))).toBe(true)
  })

  it('删除:进回收站,剧栏里消失,回收站入口出现计数', () => {
    S().addProject('追车戏')
    const onTrash = vi.fn()
    render(<ProjectRail onRequestTrash={onTrash} />)
    expect(screen.getByRole('button', { name: '回收站' }).textContent).not.toContain('(')
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 追车戏' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }))
    expect(rowNames()).toEqual(['默认项目'])
    expect(S().trash).toHaveLength(1)
    expect(screen.getByRole('button', { name: '回收站' }).textContent).toContain('(1)')
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('移入回收站'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    expect(onTrash).toHaveBeenCalledTimes(1)
  })

  it('只剩一部剧时「删除」禁用,说明原因', () => {
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 默认项目' }))
    const del = screen.getByRole('menuitem', { name: /删除/ }) as HTMLButtonElement
    expect(del.disabled).toBe(true)
    expect(del.title).toBe('至少保留一部剧')
  })

  it('有生成中卡片的剧删不掉:弹错误提示,不进回收站', () => {
    S().addProject('追车戏')
    S().addCards([{ prompt: 'x' }])
    const id = S().cards[0].id
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'running', taskId: 't1' } : c)),
    }))
    render(<ProjectRail />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '切换到剧 追车戏' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }))
    expect(S().trash).toHaveLength(0)
    expect(rowNames()).toContain('追车戏')
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('折叠态:右键同样可用;回收站入口是单独的小图标按钮', () => {
    S().addProject('追车戏')
    S().setRailCollapsed(true)
    const onTrash = vi.fn()
    render(<ProjectRail onRequestTrash={onTrash} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /切换到剧 追车戏/ }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.mouseDown(window)
    // 折叠态不渲染行内「⋯」(48px 宽放不下)
    expect(screen.queryByRole('button', { name: /剧菜单/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    expect(onTrash).toHaveBeenCalledTimes(1)
  })

  it('不传 onRequestTrash 就没有回收站入口', () => {
    render(<ProjectRail />)
    expect(screen.queryByRole('button', { name: '回收站' })).toBeNull()
  })
})
