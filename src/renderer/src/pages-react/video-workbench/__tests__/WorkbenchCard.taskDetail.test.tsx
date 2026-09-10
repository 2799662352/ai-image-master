// 卡片头部的「任务详情」入口:提交过的卡才有(草稿没有可看的),点开是面板,
// 面板里能看到上游任务号;点它不会顺带选中卡片。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VideoWorkbenchVersion } from '../../../../../types/videoWorkbench'
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

  it('卡片切到 v1 再点任务详情:面板与脚注都是 v1 的任务号;面板里「查看 v2」,卡片跟着切回', () => {
    const spec = {
      prompt: 'p',
      model: '2.5' as const,
      resolution: '480p' as const,
      ratio: '16:9' as const,
      duration: 6,
      generateAudio: true,
      mode: 'multimodal_ref' as const,
      webSearch: false,
      referenceBrief: { images: [], videos: [], audios: [] },
    }
    const versions: VideoWorkbenchVersion[] = [
      { id: 'v1', seq: 1, createdAt: 1, taskId: 't1', upstreamTaskId: 'cgt-1', localPath: 'D:\\v1.mp4', spec },
      { id: 'v2', seq: 2, createdAt: 2, taskId: 'task_x', upstreamTaskId: UPSTREAM, localPath: 'D:\\v2.mp4', spec },
    ]
    const ids = seed()
    // render 之后改 store 要包 act,否则 React 在测试环境里不会同步刷 DOM
    act(() => {
      useVideoWorkbenchStore.setState((s) => ({
        cards: s.cards.map((c) => (c.id === ids[1] ? { ...c, localPath: 'D:\\v2.mp4', versions } : c)),
      }))
    })

    // 卡片上切到 v1
    fireEvent.click(screen.getByRole('button', { name: '上一版' }))
    expect(screen.getByText('task: t1')).toBeTruthy()

    fireEvent.click(screen.getAllByTestId('vw-card-header')[1].querySelector('button[aria-label="任务详情"]')!)
    screen.getByRole('dialog', { name: '#02 · 任务详情 · v1/2' })
    expect(screen.getByTestId('vw-detail-upstreamTaskId').textContent).toContain('cgt-1')

    // 面板里切回 v2:面板与卡片都跟着走,关掉面板后卡片仍停在 v2
    fireEvent.click(screen.getByRole('button', { name: '查看 v2' }))
    screen.getByRole('dialog', { name: '#02 · 任务详情 · v2/2' })
    expect(screen.getByTestId('vw-detail-upstreamTaskId').textContent).toContain(UPSTREAM)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByText('task: task_x')).toBeTruthy()
    expect(screen.queryByText('task: t1')).toBeNull()
  })
})
