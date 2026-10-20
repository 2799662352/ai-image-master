// 回收站对话框:空态、列表、恢复(含被拒原因)、彻底删除与清空的两步确认、Esc 关闭。

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useToastStore } from '../../../stores/useToastStore'
import { TrashDialog } from '../TrashDialog'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem('vw-pins')
  useToastStore.getState().clearAll()
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

/** 造一部有两段的「追车戏」,把其中「隧道」段单独删进回收站;返回 [剧 id, 隧道 id]。 */
function seedTrashedBoard(): [string, string] {
  const pid = S().addProject('追车戏')
  const tunnel = S().addBoard('隧道')
  S().addCards([{ prompt: '隧道里追' }])
  expect(S().trashBoard(tunnel).ok).toBe(true)
  return [pid, tunnel]
}

describe('TrashDialog', () => {
  it('关着不渲染;空回收站给出空态,没有「清空」按钮', () => {
    const { rerender } = render(<TrashDialog open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<TrashDialog open onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: '回收站' })).toBeTruthy()
    expect(screen.getByText('回收站是空的')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /清空回收站/ })).toBeNull()
  })

  it('列出被删的剧和分段,带类型、规模和来源', () => {
    const [pid] = seedTrashedBoard()
    expect(S().trashProject(pid).ok).toBe(true)
    render(<TrashDialog open onClose={() => {}} />)
    const rows = within(screen.getByRole('list', { name: '回收站内容' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    const text = rows.map((r) => r.textContent ?? '')
    expect(text.some((t) => t.includes('剧') && t.includes('追车戏') && t.includes('1 段'))).toBe(true)
    expect(text.some((t) => t.includes('分段') && t.includes('隧道') && t.includes('1 镜') && t.includes('追车戏'))).toBe(true)
  })

  it('恢复分段:回到原来的剧里,并提示成功', () => {
    const [pid] = seedTrashedBoard()
    render(<TrashDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复「隧道」' }))
    expect(S().trash).toHaveLength(0)
    expect(S().boards.some((b) => b.projectId === pid && b.name === '隧道')).toBe(true)
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已恢复分段「隧道」'))).toBe(true)
    expect(screen.getByText('回收站是空的')).toBeTruthy()
  })

  it('所属的剧也在回收站时恢复分段被拒:原因显示在列表上方,条目还在', () => {
    const [pid] = seedTrashedBoard()
    expect(S().trashProject(pid).ok).toBe(true)
    render(<TrashDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复「隧道」' }))
    expect(screen.getByRole('alert').textContent).toContain('请先恢复那部剧')
    expect(S().trash.some((e) => e.kind === 'board')).toBe(true)
    // 先恢复剧,再恢复分段
    fireEvent.click(screen.getByRole('button', { name: '恢复「追车戏」' }))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '恢复「隧道」' }))
    expect(S().trash).toHaveLength(0)
  })

  it('彻底删除要点两下:第一下只是进入确认态,第二下才真删', () => {
    seedTrashedBoard()
    render(<TrashDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '彻底删除「隧道」' }))
    expect(S().trash).toHaveLength(1)
    const confirm = screen.getByRole('button', { name: '确认彻底删除「隧道」' })
    expect(confirm.className).toContain('vw-danger-armed')
    fireEvent.click(confirm)
    expect(S().trash).toHaveLength(0)
    expect(screen.getByText('回收站是空的')).toBeTruthy()
  })

  it('确认态 3.5 秒后自动退回,不会被很久以后的一次误点真删', () => {
    vi.useFakeTimers()
    seedTrashedBoard()
    render(<TrashDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '彻底删除「隧道」' }))
    expect(screen.getByRole('button', { name: '确认彻底删除「隧道」' })).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(3600)
    })
    expect(screen.queryByRole('button', { name: '确认彻底删除「隧道」' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除「隧道」' }))
    expect(S().trash).toHaveLength(1)
  })

  it('清空回收站同样要两步,并报告清掉的条数', () => {
    seedTrashedBoard()
    const extra = S().addBoard('另一段')
    expect(S().trashBoard(extra).ok).toBe(true)
    render(<TrashDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '清空回收站' }))
    expect(S().trash).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '确认清空回收站' }))
    expect(S().trash).toHaveLength(0)
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('已清空回收站(2 项)'))).toBe(true)
  })

  it('Esc 与「关闭」都会触发 onClose', () => {
    const onClose = vi.fn()
    render(<TrashDialog open onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
