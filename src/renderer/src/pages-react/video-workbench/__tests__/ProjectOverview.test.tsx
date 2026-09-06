// 剧总览:头部汇总、分段网格、点卡进分段页、新建分段、迁移提示条、剧名就地改名。
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectOverview } from '../ProjectOverview'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => cleanup())

describe('ProjectOverview', () => {
  it('头部汇总 + 每个分段一张卡,点卡进分段页', () => {
    S().addProject('追车戏')
    S().addBoard('隧道')
    S().addCards([{ prompt: 'a' }])
    const id = S().cards[0].id
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'succeeded', duration: 10 } : c)),
    }))
    render(<ProjectOverview />)
    expect(screen.getByRole('heading', { name: '追车戏' })).toBeTruthy()
    const summary = within(screen.getByRole('group', { name: '剧汇总' }))
    expect(summary.getByText('2 段')).toBeTruthy()
    expect(summary.getByText('1 镜')).toBeTruthy()
    expect(summary.getByText('总时长 0:10')).toBeTruthy()
    expect(summary.getByText('已完成 100%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开分段 隧道' }))
    expect(S().viewByProject[S().activeProjectId]).toMatchObject({ mode: 'board' })
    expect(S().boards.find((b) => b.id === S().activeBoardId)!.name).toBe('隧道')
  })

  it('「新建分段」在当前剧下加一段并进入它', () => {
    render(<ProjectOverview />)
    fireEvent.click(screen.getByRole('button', { name: '新建分段' }))
    expect(S().boards.filter((b) => b.projectId === S().activeProjectId)).toHaveLength(2)
    expect(S().viewByProject[S().activeProjectId]?.mode).toBe('board')
  })

  it('默认项目显示迁移提示条,关闭后不再出现且 legacy 被清', () => {
    render(<ProjectOverview />)
    expect(screen.getByRole('status').textContent).toContain('升级前')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(S().projects[0].legacy).toBeUndefined()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('非 legacy 的剧不显示提示条', () => {
    S().addProject('新剧')
    render(<ProjectOverview />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('剧名就地改名:Enter 提交,Esc 放弃', () => {
    render(<ProjectOverview />)
    fireEvent.click(screen.getByRole('button', { name: '重命名剧' }))
    const input = screen.getByRole('textbox', { name: '剧名' })
    fireEvent.change(input, { target: { value: '新名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(S().projects[0].name).toBe('新名字')
    fireEvent.click(screen.getByRole('button', { name: '重命名剧' }))
    const again = screen.getByRole('textbox', { name: '剧名' })
    fireEvent.change(again, { target: { value: '不要这个' } })
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(S().projects[0].name).toBe('新名字')
  })

  it('分段卡上有序号、镜数、状态角标', () => {
    S().addCards([{ prompt: 'x' }, { prompt: 'y' }])
    const [x] = S().cards.map((c) => c.id)
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === x ? { ...c, status: 'running', taskId: 't' } : c)),
    }))
    render(<ProjectOverview />)
    const card = screen.getByRole('button', { name: /打开分段 页面 1/ })
    expect(card.textContent).toContain('01')
    expect(card.textContent).toContain('2 镜')
    expect(card.textContent).toContain('1 镜生成中')
  })
})
