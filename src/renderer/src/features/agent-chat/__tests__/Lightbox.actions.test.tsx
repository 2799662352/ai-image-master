/**
 * 灯箱顶栏的「复制 / 下载」。
 *
 * 回归:灯箱里原先没有任何复制入口(只有对着 blob: 图片的原生右键菜单),
 * 用户反馈「放大了也复制不了」。按钮传的必须是**原始地址**(主进程读不到 blob:),
 * 且点击不能冒泡成「点背景关闭灯箱」。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import { Lightbox } from '../Lightbox'

vi.mock('../../../components/shared/media/useResolvedMediaSrc', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/media/useResolvedMediaSrc')>()
  return {
    ...actual,
    // 模拟本地图被换成 blob:,证明复制 / 下载传的不是它。
    useResolvedMediaSrc: (src: string) => (typeof src === 'string' && src.length > 0 ? `blob:resolved/${src}` : null),
  }
})

const copyImage = vi.fn(async (_uri: string) => ({ success: true }) as { success: boolean; error?: string })
const saveAs = vi.fn(async (_uri: string, _name: string) => ({ success: true }) as { success: boolean; error?: string })

const IMAGE = {
  id: 'img_1',
  kind: 'image' as const,
  name: 'night_v2.png',
  mime: 'image/png',
  size: 1,
  uri: 'https://cdn.example.com/night_v2.png',
}
const VIDEO = { id: 'v1', kind: 'video' as const, name: 'a.mp4', mime: 'video/mp4', size: 1, uri: 'local-file:///D:/r/a.mp4' }

function openWith(images: unknown[], index = 0): void {
  useAgentChatStore.setState({ preview: { open: true, index, images } } as never)
}

beforeEach(() => {
  copyImage.mockClear()
  saveAs.mockClear()
  Object.defineProperty(window, 'electronAPI', { value: { shell: { copyImage, saveAs } }, configurable: true })
})
afterEach(cleanup)

describe('Lightbox — 复制 / 下载', () => {
  it('复制:传原始地址,灯箱保持打开,按钮显示「已复制」', async () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '复制图片' }))
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith('https://cdn.example.com/night_v2.png'))
    expect(await screen.findByText('已复制')).toBeTruthy()
    expect(useAgentChatStore.getState().preview.open).toBe(true)
  })

  it('下载:原始地址 + 文件名;灯箱保持打开', async () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '下载图片' }))
    await waitFor(() => expect(saveAs).toHaveBeenCalledWith('https://cdn.example.com/night_v2.png', 'night_v2.png'))
    expect(useAgentChatStore.getState().preview.open).toBe(true)
  })

  it('复制失败要看得见,而不是没反应', async () => {
    copyImage.mockResolvedValueOnce({ success: false, error: '下载图片失败:HTTP 403' })
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '复制图片' }))
    expect(await screen.findByText('复制失败')).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制图片' }).getAttribute('title')).toBe('下载图片失败:HTTP 403')
  })

  it('切到下一张后,复制的是那一张', async () => {
    openWith([IMAGE, { ...IMAGE, id: 'img_2', name: 'b.png', uri: 'https://cdn.example.com/b.png' }], 1)
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '复制图片' }))
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith('https://cdn.example.com/b.png'))
  })

  it('视频只有「下载」,没有「复制」', () => {
    openWith([VIDEO])
    render(<Lightbox />)
    expect(screen.queryByRole('button', { name: '复制图片' })).toBeNull()
    expect(screen.getByRole('button', { name: '下载图片' })).toBeTruthy()
  })

  it('✕ 仍然能关闭灯箱(包了一层 stopPropagation 不能把关闭吃掉)', () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(useAgentChatStore.getState().preview.open).toBe(false)
  })
})
