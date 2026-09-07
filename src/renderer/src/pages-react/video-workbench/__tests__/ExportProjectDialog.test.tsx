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

const write = vi.fn(async (path: string, _json: string) => ({ ok: true as const, path }))
const pickSavePath = vi.fn(async () => ({ path: 'E:\\else\\追车戏.catwb.json' }))
type ResolveResult = { ok: true; url: string } | { ok: false; reason: string }
const resolveRefMedia = vi.fn(
  async (p: string): Promise<ResolveResult> => ({ ok: true, url: `https://cos/${p.split(/[\\/]/).pop()}` }),
)
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
        defaultPath: async (name: string) => ({ path: `D:\\Docs\\CATIMATION 工程\\${name}.catwb.json`, appVersion: '4.8.1' }),
        pickSavePath,
        write,
      },
    },
    attachments: { resolveRefMedia },
    shell: { showItemInFolder },
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
    const json = JSON.parse(write.mock.calls[0][1])
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
    resolveRefMedia.mockResolvedValueOnce({ ok: false, reason: 'offline' })
    render(<ExportProjectDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('CATIMATION 工程'))
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('local.png'))
    expect(screen.getByRole('button', { name: '重试导出' })).toBeTruthy()
    expect(write).not.toHaveBeenCalled()
  })

  it('本地文件找不到 → 列出缺失、给「跳过缺失素材并导出」;跳过后成功并注明跳过数', async () => {
    S().addProject('追车戏')
    S().addCards([{ prompt: 'a', referenceImages: ['Q:\\old\\gone.png', 'D:\\pics\\ok.png'] }])
    resolveRefMedia.mockImplementation(async (p: string): Promise<ResolveResult> =>
      p.endsWith('gone.png')
        ? { ok: false, reason: `referenceMedia: cannot read local file "${p}" — pass an existing path, data: URL, or https URL.` }
        : { ok: true, url: 'https://cos/ok.png' })
    render(<ExportProjectDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('CATIMATION 工程'))
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('gone.png'))
    expect(write).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '跳过缺失素材并导出' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已跳过 1 个找不到的素材'))
    expect(write).toHaveBeenCalledTimes(1)
    const json = JSON.parse(write.mock.calls[0][1])
    expect(json.boards[0].cards[0].referenceImages).toEqual([{ name: 'ok.png', src: 'https://cos/ok.png' }])
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
