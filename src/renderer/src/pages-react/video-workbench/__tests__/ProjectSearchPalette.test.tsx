// Ctrl+P 搜索面板:同时搜剧名与分段名,↑↓ 选,Enter 打开命中项,Esc 关闭。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectSearchPalette } from '../ProjectSearchPalette'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => cleanup())

describe('ProjectSearchPalette', () => {
  it('同时搜剧名与分段名,回车打开命中的分段(连剧一起切)', () => {
    S().addProject('追车戏')
    S().addBoard('隧道 灯带')
    S().switchProject('project-default')
    const onClose = vi.fn()
    render(<ProjectSearchPalette open onClose={onClose} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '隧道' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(S().boards.find((b) => b.id === S().activeBoardId)!.name).toBe('隧道 灯带')
    expect(S().projects.find((p) => p.id === S().activeProjectId)!.name).toBe('追车戏')
    expect(onClose).toHaveBeenCalled()
  })

  it('命中剧名 → 切到该剧;↓ 移动高亮;Esc 关闭', () => {
    S().addProject('追车戏')
    S().switchProject('project-default')
    const onClose = vi.fn()
    render(<ProjectSearchPalette open onClose={onClose} />)
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: '追车' } })
    // 命中:剧「追车戏」+ 它自带的「分段 1」(副标题是剧名,也含「追车」)
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(2)
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(S().projects.find((p) => p.id === S().activeProjectId)!.name).toBe('追车戏')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('没有匹配时显示空态;关闭时不渲染', () => {
    const { rerender } = render(<ProjectSearchPalette open onClose={() => {}} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } })
    expect(screen.getByText('没有匹配的剧或分段')).toBeTruthy()
    rerender(<ProjectSearchPalette open={false} onClose={() => {}} />)
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
