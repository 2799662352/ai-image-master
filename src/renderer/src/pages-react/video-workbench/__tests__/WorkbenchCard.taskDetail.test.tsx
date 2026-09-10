// 卡片头部的「任务详情」入口:提交过的卡才有(草稿没有可看的),点开是面板,
// 面板里能看到上游任务号;点它不会顺带选中卡片。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

const UPSTREAM = 'cgt-20260903172200-5n7rt'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function seed(): string[] {
  const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '草稿' }, { prompt: '跑过的' }])
  useVideoWorkbenchStore.setState((s) => ({
    hydrated: true,
    cards: s.cards.map((c) =>
      c.id === ids[1]
        ? { ...c, status: 'succeeded', taskId: 'task_x', upstreamTaskId: UPSTREAM, billing: 'platform', persistence: 'done' }
        : c,
    ),
  }))
  render(<VideoWorkbenchPage />)
  return ids
}

describe('WorkbenchCard · 任务详情入口', () => {
  it('草稿卡没有入口;提交过的卡头部有「任务详情」按钮', () => {
    seed()
    const headers = screen.getAllByTestId('vw-card-header')
    expect(headers[0].querySelector('button[aria-label="任务详情"]')).toBeNull()
    expect(headers[1].querySelector('button[aria-label="任务详情"]')).toBeTruthy()
  })

  it('点开面板看到上游任务号;点入口不改变选中', () => {
    seed()
    const button = screen.getAllByTestId('vw-card-header')[1].querySelector('button[aria-label="任务详情"]')!
    fireEvent.click(button)
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([])
    const dialog = screen.getByRole('dialog', { name: '#02 · 任务详情' })
    expect(dialog.textContent).toContain(UPSTREAM)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog', { name: '#02 · 任务详情' })).toBeNull()
  })
})
