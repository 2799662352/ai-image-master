// 剧总览的删除入口 / 分段卡右键菜单 / 置顶排序 / 重命名对话框。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useToastStore } from '../../../stores/useToastStore'
import { ProjectOverview } from '../ProjectOverview'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem('vw-pins')
  useToastStore.getState().clearAll()
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => cleanup())

const cardNames = () =>
  screen
    .getAllByRole('button', { name: /^打开分段 / })
    .map((el) => el.getAttribute('aria-label')?.replace('打开分段 ', ''))

/** 一部有三段的剧「追车戏」(默认分段「分段 1」+ 隧道 + 天台),停在总览。 */
function seed() {
  S().addProject('追车戏')
  S().addBoard('隧道')
  S().addBoard('天台')
  S().openOverview()
}

describe('ProjectOverview 分段卡菜单', () => {
  it('右键分段卡:打开 / 重命名 / 置顶 / Fork / 删除', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 隧道' }))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      expect.stringContaining('打开'),
      expect.stringContaining('重命名'),
      expect.stringContaining('置顶'),
      expect.stringContaining('Fork'),
      expect.stringContaining('删除'),
    ])
  })

  it('卡片右上角的「⋯」按钮打开同一份菜单(不嵌在卡片按钮里)', () => {
    seed()
    render(<ProjectOverview />)
    const more = screen.getByRole('button', { name: '分段菜单 隧道' })
    expect(more.closest('button.vw-seg')).toBeNull()
    fireEvent.click(more)
    expect(screen.getAllByRole('menuitem')).toHaveLength(5)
    // 点「⋯」不会顺带把卡片打开
    expect(S().viewByProject[S().activeProjectId]?.mode).toBe('overview')
  })

  it('菜单「打开」进入分段页', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 隧道' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^打开/ }))
    expect(S().viewByProject[S().activeProjectId]).toMatchObject({ mode: 'board' })
    expect(S().boards.find((b) => b.id === S().activeBoardId)!.name).toBe('隧道')
  })

  it('重命名:弹小对话框(卡片是按钮,不能就地改);空名不让提交', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 隧道' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))
    const input = screen.getByRole('textbox', { name: '新名称' }) as HTMLInputElement
    expect(input.value).toBe('隧道')
    fireEvent.change(input, { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '地下隧道' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(S().boards.some((b) => b.name === '地下隧道')).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cardNames()).toContain('地下隧道')
  })

  it('重命名对话框 Esc 取消,名字不变', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 隧道' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))
    const input = screen.getByRole('textbox', { name: '新名称' })
    fireEvent.change(input, { target: { value: '不该生效' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(S().boards.some((b) => b.name === '隧道')).toBe(true)
  })

  it('置顶:卡片排到最前、出 PIN 标,但序号仍是剧内原顺序', () => {
    seed()
    render(<ProjectOverview />)
    expect(cardNames()).toEqual(['分段 1', '隧道', '天台'])
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 天台' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /置顶/ }))
    expect(cardNames()).toEqual(['天台', '分段 1', '隧道'])
    expect(screen.getAllByTitle('已置顶')).toHaveLength(1)
    // 「天台」是第 3 段:徽标仍是 03,而不是因为排到最前变成 01
    const pinnedCard = screen.getByRole('button', { name: '打开分段 天台' })
    expect(pinnedCard.querySelector('.vw-seg-badge-tl')?.textContent).toBe('03')
    // 取消置顶回到原位
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 天台' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /取消置顶/ }))
    expect(cardNames()).toEqual(['分段 1', '隧道', '天台'])
  })

  it('Fork:紧跟原段生成「副本」', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 隧道' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Fork/ }))
    expect(cardNames()).toEqual(['分段 1', '隧道', '隧道 副本', '天台'])
  })

  it('删除:卡片消失、进回收站,不弹确认(确认在回收站里「彻底删除」那一步)', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '打开分段 隧道' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }))
    expect(cardNames()).toEqual(['分段 1', '天台'])
    expect(S().trash).toHaveLength(1)
    expect(S().trash[0]).toMatchObject({ kind: 'board' })
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('分段「隧道」移入回收站'))).toBe(true)
  })

  it('本剧只剩一段时「删除」禁用', () => {
    S().addProject('单段剧')
    S().openOverview()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /^打开分段 / }))
    expect((screen.getByRole('menuitem', { name: /删除/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ProjectOverview 剧级删除入口', () => {
  it('头部「删除此剧」:移入回收站并切走', () => {
    seed()
    const pid = S().activeProjectId
    render(<ProjectOverview />)
    fireEvent.click(screen.getByRole('button', { name: '删除此剧' }))
    expect(S().projects.some((p) => p.id === pid)).toBe(false)
    expect(S().trash).toHaveLength(1)
    expect(S().trash[0]).toMatchObject({ kind: 'project' })
    expect(S().activeProjectId).not.toBe(pid)
  })

  it('只有一部剧时「删除此剧」禁用并说明原因', () => {
    render(<ProjectOverview />)
    const btn = screen.getByRole('button', { name: '删除此剧' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe('至少保留一部剧')
  })

  it('右键剧名区域弹出剧菜单;重命名进入就地编辑', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('heading', { name: '追车戏' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))
    expect(screen.getByRole('textbox', { name: '剧名' })).toBeTruthy()
  })

  it('剧置顶后头部出 PIN 标', () => {
    seed()
    render(<ProjectOverview />)
    fireEvent.contextMenu(screen.getByRole('heading', { name: '追车戏' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /置顶/ }))
    expect(screen.getByTitle('已置顶')).toBeTruthy()
  })
})
