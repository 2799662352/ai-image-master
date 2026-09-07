// 导入确认页:读文件后显示摘要与默认剧名(重名加「(2)」)、导入为新剧、不兼容时禁用。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import { buildCard } from '../../../features/video-workbench/cardSpec'
import { PROJECT_FILE_VERSION, buildProjectFile } from '../../../features/video-workbench/projectFile'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useToastStore } from '../../../stores/useToastStore'
import { ImportProjectDialog } from '../ImportProjectDialog'

const S = () => useVideoWorkbenchStore.getState()

const project: VideoWorkbenchProject = { id: 'src', name: '追车戏', order: 0, createdAt: 1, updatedAt: 2, summary: '三集 · 夜外' }
const boards: VideoWorkbenchBoard[] = [
  { id: 'b1', projectId: 'src', name: '建立镜头', order: 0, createdAt: 1 },
  { id: 'b2', projectId: 'src', name: '隧道', order: 1, createdAt: 2 },
]

function fileText(overrides: Record<string, unknown> = {}): string {
  const r = buildProjectFile({
    project, boards,
    cards: [
      buildCard({ prompt: 'A', referenceImages: ['https://cos/a.png'] }, 0, 'b1'),
      buildCard({ prompt: 'B' }, 1, 'b1'),
      buildCard({ prompt: 'C' }, 0, 'b2'),
    ],
    app: { name: 'CATIMATION', version: '4.8.1' },
    now: Date.UTC(2026, 8, 6, 10, 30),
    resolve: () => null,
  })
  if (!r.ok) throw new Error('fixture')
  return JSON.stringify({ ...r.file, ...overrides })
}

const read = vi.fn()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  useToastStore.getState().clearAll()
  read.mockReset()
  read.mockImplementation(async (path: string) => ({ ok: true, path, text: fileText() }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    videoWorkbench: { projectFile: { read } },
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('ImportProjectDialog', () => {
  it('读完显示摘要与导出信息;剧名默认去重(已有同名 → 加 (2));导入为新剧后切过去并 toast', async () => {
    S().addProject('追车戏')
    const onClose = vi.fn()
    render(<ImportProjectDialog path="D:\\Docs\\追车戏.catwb.json" onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: '导入工程' })
    expect(dialog.textContent).toContain('追车戏.catwb.json')
    await waitFor(() => expect(dialog.textContent).toContain('2 段 · 3 镜 · 1 个素材'))
    expect(dialog.textContent).toContain('客户端 4.8.1')
    const input = screen.getByLabelText('导入为新剧,剧名') as HTMLInputElement
    expect(input.value).toBe('追车戏 (2)')

    fireEvent.change(input, { target: { value: '追车戏 · 导入' } })
    fireEvent.click(screen.getByRole('button', { name: '导入为新剧' }))

    const created = S().projects.find((p) => p.name === '追车戏 · 导入')!
    expect(created).toBeTruthy()
    expect(created.summary).toBe('三集 · 夜外')
    expect(S().activeProjectId).toBe(created.id)
    expect(S().viewByProject[created.id]).toEqual({ mode: 'overview' })
    expect(S().boards.filter((b) => b.projectId === created.id).map((b) => b.name)).toEqual(['建立镜头', '隧道'])
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('2 段 3 镜')
    expect(onClose).toHaveBeenCalled()
  })

  it('高版本文件 → 红字原因、按钮禁用;读失败同样', async () => {
    read.mockImplementationOnce(async (path: string) => ({
      ok: true, path, text: fileText({ formatVersion: PROJECT_FILE_VERSION + 1 }),
    }))
    const { unmount } = render(<ImportProjectDialog path="D:\\future.catwb.json" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('更新'))
    expect(screen.getByRole('button', { name: '导入为新剧' }).hasAttribute('disabled')).toBe(true)
    unmount()

    read.mockImplementationOnce(async () => ({ ok: false, code: 'not-found', reason: '文件不存在' }))
    render(<ImportProjectDialog path="D:\\gone.catwb.json" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('文件不存在'))
    expect(screen.getByRole('button', { name: '导入为新剧' }).hasAttribute('disabled')).toBe(true)
  })

  it('path=null 不渲染;取消关闭', () => {
    const onClose = vi.fn()
    const { rerender } = render(<ImportProjectDialog path={null} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<ImportProjectDialog path="D:\\x.catwb.json" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalled()
  })
})
