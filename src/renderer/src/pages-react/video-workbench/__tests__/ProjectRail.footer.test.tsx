// 剧栏底部入口:导入 / 导出 / 云备份 / 回收站按剧栏宽度等分成一排(列数 = 实际渲染的按钮数);
// 导入/导出只在这里有一份(剧总览头部不再放重复的)。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY, RAIL_COLLAPSED_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectRail } from '../ProjectRail'

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(RAIL_COLLAPSED_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => cleanup())

const foot = (container: HTMLElement) => container.querySelector<HTMLElement>('.vw-rail-foot')!
const cols = (container: HTMLElement) => foot(container).style.getPropertyValue('--vw-foot-cols')
const labels = (container: HTMLElement) =>
  Array.from(foot(container).querySelectorAll('button')).map((b) => b.textContent?.trim())

describe('ProjectRail 底部入口', () => {
  it('四个入口都有:一排四列,顺序 导入 · 导出 · 云备份 · 回收站,可见文字是短标签', () => {
    const { container } = render(
      <ProjectRail
        onRequestImport={() => {}}
        onRequestExport={() => {}}
        onRequestCloudBackup={() => {}}
        onRequestTrash={() => {}}
      />,
    )
    expect(cols(container)).toBe('4')
    expect(labels(container)).toEqual(['导入', '导出', '云备份', '回收站'])
    // 可访问名保持原样(读屏、其他测试都按它找)
    const names = Array.from(foot(container).querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['导入工程', '导出当前剧', '云备份', '回收站'])
  })

  it('列数跟着实际按钮数走:没有云备份(非桌面端)/ 没有回收站时不留空列', () => {
    const a = render(<ProjectRail onRequestTrash={() => {}} />)
    expect(cols(a.container)).toBe('3')
    expect(labels(a.container)).toEqual(['导入', '导出', '回收站'])
    a.unmount()
    const b = render(<ProjectRail />)
    expect(cols(b.container)).toBe('2')
    expect(labels(b.container)).toEqual(['导入', '导出'])
  })

  it('回收站有内容才出角标(显示条数,标题里也写明);空时没有', () => {
    const empty = render(<ProjectRail onRequestTrash={() => {}} />)
    expect(empty.container.querySelector('.vw-rail-badge')).toBeNull()
    empty.unmount()
    const S = useVideoWorkbenchStore.getState()
    const id = S.addProject('追车戏')
    expect(S.trashProject(id).ok).toBe(true)
    const { container } = render(<ProjectRail onRequestTrash={() => {}} />)
    expect(container.querySelector('.vw-rail-badge')?.textContent).toBe('1')
    expect(screen.getByRole('button', { name: '回收站' }).getAttribute('title')).toContain('(1)')
  })

  it('折叠态不渲染这一排(48px 放不下),只留回收站小图标', () => {
    useVideoWorkbenchStore.getState().setRailCollapsed(true)
    const onTrash = vi.fn()
    const { container } = render(<ProjectRail onRequestTrash={onTrash} onRequestImport={() => {}} />)
    expect(container.querySelector('.vw-rail-foot')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    expect(onTrash).toHaveBeenCalledTimes(1)
  })
})
