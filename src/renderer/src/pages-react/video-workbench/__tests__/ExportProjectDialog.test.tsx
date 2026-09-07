// 导出确认页:统计一行、默认路径、更改…、点导出走编排、成功态「在文件夹中显示」。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PROJECT_KEY } from '../../../features/video-workbench/projects'
import {
  ACTIVE_BOARD_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ExportProjectDialog } from '../ExportProjectDialog'

const S = () => useVideoWorkbenchStore.getState()

const write = vi.fn(async (path: string) => ({ ok: true as const, path }))
const pickSavePath = vi.fn(async () => ({ path: 'E:\\else\\追车戏.catwb.json' }))
const resolveRefMedia = vi.fn(async (p: string) => ({ ok: true as const, url: `https://cos/${p.split(/[\\/]/).pop()}` }))
const showItemInFolder = vi.fn()

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  write.mockClear()
  pickSavePath.mockClear()
  resolveRefMedia.mockClear()
  showItemInFolder.mockClear()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    videoWorkbench: {
      projectFile: {
        defaultPath: async (name: string) => ({ path: `D:\\Docs\\CATIMATION 工程\\${name}.catwb.json` }),
        pickSavePath,
        write,
      },
    },
    attachments: { resolveRefMedia },
    shell: { showItemInFolder },
    getAppVersion: async () => '4.8.1',
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('ExportProjectDialog', () => {
  it('显示剧名·段·镜·素材(待上传);默认路径;更改…换路径;导出后成功态可在文件夹中显示', async () => {
    S().addProject('追车戏')
    S().addCards([{ prompt: 'a', referenceImages: ['D:\\pics\\local.png', 'https://cos/cloud.png'] }])
    const onClose = vi.fn()
    render(<ExportProjectDialog open onClose={onClose} />)

    const dialog = screen.getByRole('dialog', { name: '导出工程' })
    expect(dialog.textContent).toContain('追车戏')
    expect(dialog.textContent).toContain('1 段 · 1 镜 · 2 个素材(其中 1 个待上传)')
    await waitFor(() => expect(dialog.textContent).toContain('D:\\Docs\\CATIMATION 工程\\追车戏.catwb.json'))

    fireEvent.click(screen.getByRole('button', { name: '更改…' }))
    await waitFor(() => expect(dialog.textContent).toContain('E:\\else\\追车戏.catwb.json'))

    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '在文件夹中显示' })).toBeTruthy())
    expect(resolveRefMedia).toHaveBeenCalledWith('D:\\pics\\local.png')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toBe('E:\\else\\追车戏.catwb.json')
    const json = JSON.parse(write.mock.calls[0][1] as string)
    expect(json.app.version).toBe('4.8.1')
    expect(json.boards[0].cards[0].referenceImages.map((m: { src: string }) => m.src)).toEqual([
      'https://cos/local.png', 'https://cos/cloud.png',
    ])

    fireEvent.click(screen.getByRole('button', { name: '在文件夹中显示' }))
    expect(showItemInFolder).toHaveBeenCalledWith('E:\\else\\追车戏.catwb.json')
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('上传失败 → 留在页上给原因,按钮变「重试导出」,不写文件', async () => {
    S().addProject('追车戏')
    S().addCards([{ prompt: 'a', referenceImages: ['D:\\pics\\local.png'] }])
    resolveRefMedia.mockResolvedValueOnce({ ok: false, reason: 'offline' } as never)
    render(<ExportProjectDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('CATIMATION 工程'))
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('local.png'))
    expect(screen.getByRole('button', { name: '重试导出' })).toBeTruthy()
    expect(write).not.toHaveBeenCalled()
  })

  it('取消关闭;open=false 不渲染', () => {
    const onClose = vi.fn()
    const { rerender } = render(<ExportProjectDialog open onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalled()
    rerender(<ExportProjectDialog open={false} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
