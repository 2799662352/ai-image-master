// 剧栏:列出全部剧、当前剧标记、统计文案、切剧、新建即改名、状态点、折叠。
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_PROJECT_KEY, RAIL_COLLAPSED_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectRail, relativeTime } from '../ProjectRail'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(RAIL_COLLAPSED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => cleanup())

describe('ProjectRail', () => {
  it('列出全部剧,当前剧带 aria-current,行里有段/镜统计', () => {
    const p2 = S().addProject('追车戏')
    S().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    render(<ProjectRail />)
    const rows = screen.getAllByRole('button', { name: /切换到剧/ })
    expect(rows).toHaveLength(2)
    const active = rows.find((r) => r.getAttribute('aria-current') === 'true')!
    expect(within(active).getByText('追车戏')).toBeTruthy()
    expect(within(active).getByText(/1 段 · 2 镜/)).toBeTruthy()
    expect(S().activeProjectId).toBe(p2)
  })

  it('点行切剧;点 + 新建并聚焦改名输入框,Enter 提交新名', () => {
    S().addProject('第二部')
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: '切换到剧 默认项目' }))
    expect(S().activeProjectId).toBe('project-default')
    fireEvent.click(screen.getByRole('button', { name: '新建剧' }))
    expect(S().projects).toHaveLength(3)
    const input = screen.getByRole('textbox', { name: '剧名' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '我的新剧' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(S().projects.find((p) => p.id === S().activeProjectId)!.name).toBe('我的新剧')
  })

  it('搜索框按剧名过滤', () => {
    S().addProject('追车戏')
    render(<ProjectRail />)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索剧' }), { target: { value: '追车' } })
    expect(screen.getAllByRole('button', { name: /切换到剧/ })).toHaveLength(1)
  })

  it('有生成中卡片的剧显示黄点计数,有失败的显示红点计数', () => {
    S().addCards([{ prompt: 'x' }, { prompt: 'y' }])
    const [x, y] = S().cards.map((c) => c.id)
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) =>
        c.id === x ? { ...c, status: 'running', taskId: 't' } : c.id === y ? { ...c, status: 'failed' } : c,
      ),
    }))
    render(<ProjectRail />)
    expect(screen.getByTitle('1 镜生成中')).toBeTruthy()
    expect(screen.getByTitle('1 镜失败')).toBeTruthy()
  })

  it('折叠后只剩封面,按钮文案变「展开剧栏」,状态持久化', () => {
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: '折叠剧栏' }))
    expect(S().railCollapsed).toBe(true)
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('1')
    expect(screen.getByRole('button', { name: '展开剧栏' })).toBeTruthy()
    expect(screen.queryByText('默认项目')).toBeNull()
  })

  it('导入/导出按钮没接回调时禁用并提示即将推出', () => {
    render(<ProjectRail />)
    expect(screen.getByRole('button', { name: '导入工程' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '导出当前剧' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('relativeTime', () => {
  it('分/时/天/周 分档', () => {
    const now = 10_000_000_000
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime(now - 30_000, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
    expect(relativeTime(now - 15 * 86_400_000, now)).toBe('2 周前')
  })
})
